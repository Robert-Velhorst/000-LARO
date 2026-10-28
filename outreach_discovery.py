"""Bounded, review-first discovery of public outreach candidates.

This adapter deliberately searches only the query the user submits.  It does
not upload case material, crawl target sites, or treat a search result as a
verified contact.  Every returned record is intended for the LARO directory's
existing human-review gate.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import parse_qs, unquote, urlencode, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup

from dutch_legal_taxonomy import legal_area, normalize_legal_fields


DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/"
ALLOWED_TARGET_TYPES = {"media", "organization"}
MAX_QUERY_LENGTH = 240
MAX_RESULTS = 20
MAX_CASE_QUERIES = 8
MAX_CASE_RESULTS = 60

CASE_QUERY_PILLARS = {
    "media": (
        ("newsroom", "journalist redactie"),
        ("investigative_program", "onderzoeksjournalist programma podcast"),
        ("news_coverage", "nieuws actualiteiten dossier"),
        ("public_interest_program", "consumentenprogramma omroep reportage"),
    ),
    "organization": (
        ("advocacy", "belangenorganisatie vereniging"),
        ("support", "stichting hulp advies"),
        ("representation", "belangenbehartiging lobby"),
        ("ombuds_support", "meldpunt ombudsman ondersteuning"),
    ),
}


class OutreachDiscoveryError(RuntimeError):
    """Raised when a public candidate search cannot be completed safely."""


class OutreachTargetDiscovery:
    """Read-only public-search adapter for LARO's review queue."""

    def __init__(
        self,
        http_get=requests.get,
        search_url: str = DUCKDUCKGO_HTML_URL,
        timeout_seconds: int = 12,
    ):
        self.http_get = http_get
        self.search_url = search_url
        self.timeout_seconds = timeout_seconds

    def discover(
        self,
        target_type: str,
        query: str,
        limit: Any = 10,
    ) -> Dict[str, Any]:
        normalized_type = str(target_type or "").strip().lower()
        if normalized_type not in ALLOWED_TARGET_TYPES:
            raise OutreachDiscoveryError("target_type must be media or organization")

        normalized_query = " ".join(str(query or "").split())
        if not normalized_query:
            raise OutreachDiscoveryError("Enter an external search query before discovering targets")
        if len(normalized_query) > MAX_QUERY_LENGTH:
            raise OutreachDiscoveryError(f"Search query must be {MAX_QUERY_LENGTH} characters or fewer")

        try:
            bounded_limit = min(max(int(limit or 10), 1), MAX_RESULTS)
        except (TypeError, ValueError):
            bounded_limit = 10

        retrieved_at = datetime.now(timezone.utc).isoformat()
        try:
            response = self.http_get(
                self.search_url,
                params={"q": normalized_query, "kl": "nl-nl"},
                headers={
                    "Accept": "text/html,application/xhtml+xml",
                    "User-Agent": "LARO-local-outreach-discovery/1.0 (+local-only)",
                },
                timeout=self.timeout_seconds,
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            raise OutreachDiscoveryError("Public web search could not be reached; retry later") from exc

        response_text = getattr(response, "text", "") or ""
        response_lower = response_text.casefold()
        if (
            int(getattr(response, "status_code", 200) or 200) == 202
            or 'id="challenge-form"' in response_lower
            or "anomaly-modal" in response_lower
            or "confirm this search was made by a human" in response_lower
        ):
            raise OutreachDiscoveryError(
                "Public web search requested human verification; retry later or use a manual sourced query"
            )

        candidates = self._parse_results(
            html=response_text,
            target_type=normalized_type,
            query=normalized_query,
            retrieved_at=retrieved_at,
            limit=bounded_limit,
        )
        return {
            "provider": "duckduckgo_html",
            "provider_label": "DuckDuckGo public web search",
            "query": normalized_query,
            "retrieved_at": retrieved_at,
            "candidates": candidates,
            "result_count": len(candidates),
            "search_url": f"{self.search_url}?{urlencode({'q': normalized_query, 'kl': 'nl-nl'})}",
        }

    def plan_case_queries(
        self,
        target_type: str,
        legal_fields: Iterable[Any],
        max_queries: Any = 6,
    ) -> List[Dict[str, Any]]:
        """Build public-search queries from official areas, never case prose."""
        normalized_type = str(target_type or "").strip().lower()
        if normalized_type not in ALLOWED_TARGET_TYPES:
            raise OutreachDiscoveryError("target_type must be media or organization")
        try:
            bounded_query_count = min(max(int(max_queries or 6), 1), MAX_CASE_QUERIES)
        except (TypeError, ValueError):
            bounded_query_count = 6

        areas = []
        for field in normalize_legal_fields(legal_fields)[:4]:
            area = legal_area(field)
            if area:
                areas.append(area)
        if not areas:
            raise OutreachDiscoveryError(
                "No official legal area is available for case-aware discovery; analyze the case or select an expert area first"
            )

        plan: List[Dict[str, Any]] = []
        for pillar, search_terms in CASE_QUERY_PILLARS[normalized_type]:
            for area in areas:
                plan.append({
                    "query": f"Nederland {area['name_nl']} {search_terms}",
                    "pillar": pillar,
                    "legal_field": area["key"],
                    "legal_area": area["name_nl"],
                    "raw_case_text_shared": False,
                })
                if len(plan) >= bounded_query_count:
                    return plan
        return plan

    def discover_for_case(
        self,
        target_type: str,
        legal_fields: Iterable[Any],
        limit: Any = 40,
        max_queries: Any = 6,
    ) -> Dict[str, Any]:
        """Run a bounded multi-query search and return review-only candidates."""
        try:
            bounded_limit = min(max(int(limit or 40), 1), MAX_CASE_RESULTS)
        except (TypeError, ValueError):
            bounded_limit = 40
        plan = self.plan_case_queries(target_type, legal_fields, max_queries=max_queries)
        per_query_limit = min(MAX_RESULTS, max(5, math.ceil(bounded_limit / max(len(plan), 1))))
        retrieved_at = datetime.now(timezone.utc).isoformat()
        candidates_by_key: Dict[str, Dict[str, Any]] = {}
        completed_queries: List[Dict[str, Any]] = []
        failed_queries: List[Dict[str, Any]] = []
        raw_result_count = 0

        for query_index, query_item in enumerate(plan, start=1):
            try:
                result = self.discover(
                    target_type=target_type,
                    query=query_item["query"],
                    limit=per_query_limit,
                )
            except OutreachDiscoveryError as exc:
                failed_queries.append({
                    **query_item,
                    "error": str(exc),
                })
                continue

            query_candidates = result.get("candidates") or []
            raw_result_count += len(query_candidates)
            completed_queries.append({
                **query_item,
                "result_count": len(query_candidates),
                "search_url": result.get("search_url"),
            })
            for candidate in query_candidates:
                enriched = self._enrich_case_candidate(candidate, query_item, query_index)
                identity = self._candidate_identity(enriched.get("source_url"))
                if not identity:
                    continue
                existing = candidates_by_key.get(identity)
                if existing:
                    existing["topics"] = _dedupe_strings(existing.get("topics", []) + enriched.get("topics", []))
                    existing["legal_fields"] = _dedupe_strings(
                        existing.get("legal_fields", []) + enriched.get("legal_fields", [])
                    )
                    metadata = existing.setdefault("metadata", {})
                    metadata["discovery_queries"] = _dedupe_strings(
                        metadata.get("discovery_queries", []) + [query_item["query"]]
                    )
                    metadata["query_pillars"] = _dedupe_strings(
                        metadata.get("query_pillars", []) + [query_item["pillar"]]
                    )
                    continue
                candidates_by_key[identity] = enriched

        if failed_queries and not completed_queries:
            reasons = _dedupe_strings(item.get("error") for item in failed_queries)
            detail = reasons[0] if len(reasons) == 1 else "; ".join(reasons[:2])
            raise OutreachDiscoveryError(f"Every planned public web query failed: {detail}")

        candidates = list(candidates_by_key.values())[:bounded_limit]
        domains = sorted({urlparse(item.get("source_url") or "").netloc.casefold() for item in candidates if item.get("source_url")})
        legal_fields_used = _dedupe_strings(item["legal_field"] for item in plan)
        return {
            "provider": "duckduckgo_html_multi_query",
            "provider_label": "DuckDuckGo public web search",
            "retrieved_at": retrieved_at,
            "candidates": candidates,
            "result_count": len(candidates),
            "query_plan": plan,
            "coverage": {
                "strategy": "official_legal_area_multi_query",
                "planned_query_count": len(plan),
                "completed_query_count": len(completed_queries),
                "failed_query_count": len(failed_queries),
                "raw_result_count": raw_result_count,
                "unique_candidate_count": len(candidates_by_key),
                "returned_candidate_count": len(candidates),
                "unique_domain_count": len(domains),
                "legal_fields": legal_fields_used,
                "completed_queries": completed_queries,
                "failed_queries": failed_queries,
                "external_values_sent": [item["query"] for item in plan],
                "raw_case_text_shared": False,
                "completeness": "bounded_public_web_discovery_not_exhaustive",
            },
        }

    def _enrich_case_candidate(
        self,
        candidate: Dict[str, Any],
        query_item: Dict[str, Any],
        query_index: int,
    ) -> Dict[str, Any]:
        metadata = dict(candidate.get("metadata") or {})
        metadata.update({
            "case_aware_discovery": True,
            "safe_query_only": True,
            "discovery_queries": [query_item["query"]],
            "query_pillars": [query_item["pillar"]],
            "query_index": query_index,
            "raw_case_text_shared": False,
        })
        return {
            **candidate,
            "subtype": self._infer_subtype(
                candidate.get("target_type"),
                candidate.get("name"),
                candidate.get("description"),
            ),
            "topics": _dedupe_strings([query_item["legal_area"]]),
            "legal_fields": [query_item["legal_field"]],
            "metadata": metadata,
        }

    @staticmethod
    def _candidate_identity(source_url: Any) -> str:
        parsed = urlparse(str(source_url or "").strip())
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return ""
        host = parsed.netloc.casefold().removeprefix("www.")
        path = (parsed.path or "/").rstrip("/") or "/"
        return f"{host}{path.casefold()}"

    @staticmethod
    def _infer_subtype(target_type: Any, name: Any, description: Any) -> str:
        text = f"{name or ''} {description or ''}".casefold()
        if str(target_type or "").casefold() == "media":
            if any(term in text for term in ("journalist", "reporter", "verslaggever", "correspondent")):
                return "journalist or reporter candidate"
            if any(term in text for term in ("programma", "podcast", "radio", "televisie", "broadcast")):
                return "media program candidate"
            if any(term in text for term in ("redactie", "nieuws", "newspaper", "magazine", "omroep")):
                return "newsroom candidate"
            return "media discovery candidate"
        if any(term in text for term in ("ombudsman", "meldpunt", "helpdesk", "loket")):
            return "support or ombuds candidate"
        if any(term in text for term in ("belangen", "lobby", "advocacy")):
            return "advocacy candidate"
        if any(term in text for term in ("vereniging", "association")):
            return "association candidate"
        if any(term in text for term in ("stichting", "foundation")):
            return "foundation candidate"
        return "organization discovery candidate"

    def _parse_results(
        self,
        html: str,
        target_type: str,
        query: str,
        retrieved_at: str,
        limit: int,
    ) -> List[Dict[str, Any]]:
        soup = BeautifulSoup(html or "", "html.parser")
        links = soup.select("a.result__a, a[data-testid='result-title-a']")
        candidates: List[Dict[str, Any]] = []
        seen_urls = set()

        for link in links:
            source_url = self._clean_result_url(link.get("href") or "")
            title = link.get_text(" ", strip=True)
            if not source_url or not title or source_url in seen_urls:
                continue
            seen_urls.add(source_url)

            container = link.find_parent(class_="result") or link.find_parent("article") or link.parent
            snippet_node = container.select_one(".result__snippet, [data-result='snippet'], [data-testid='result-snippet']") if container else None
            snippet = snippet_node.get_text(" ", strip=True) if snippet_node else ""
            rank = len(candidates) + 1
            candidates.append({
                "target_type": target_type,
                "name": title[:255],
                "subtype": f"{target_type} discovery candidate",
                "description": snippet[:2000],
                "topics": [],
                "legal_fields": [],
                "audience": [],
                "channels": ["web"],
                "region": "Netherlands",
                "url": source_url,
                "source_url": source_url,
                "source_label": "DuckDuckGo public web search",
                "source_retrieved_at": retrieved_at,
                "confidence": "discovery_candidate",
                "metadata": {
                    "discovery_provider": "duckduckgo_html",
                    "discovery_query": query,
                    "discovery_rank": rank,
                    "discovery_snippet": snippet[:2000],
                    "discovered_at": retrieved_at,
                    "review_note": "Public search result only. Verify the target, scope, and contact route before approval.",
                },
            })
            if len(candidates) >= limit:
                break
        return candidates

    @staticmethod
    def _clean_result_url(raw_url: str) -> str:
        raw_url = str(raw_url or "").strip()
        if not raw_url:
            return ""
        parsed = urlparse(raw_url)
        if parsed.netloc.endswith("duckduckgo.com"):
            redirect_target = parse_qs(parsed.query).get("uddg", [""])[0]
            raw_url = unquote(redirect_target)
            parsed = urlparse(raw_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return ""
        filtered_query = urlencode([
            (key, value)
            for key, values in parse_qs(parsed.query, keep_blank_values=True).items()
            if not key.lower().startswith("utm_")
            for value in values
        ])
        return urlunparse((parsed.scheme, parsed.netloc, parsed.path or "/", "", filtered_query, ""))


def _dedupe_strings(values: Iterable[Any]) -> List[str]:
    result: List[str] = []
    seen = set()
    for value in values or []:
        text = str(value or "").strip()
        key = text.casefold()
        if text and key not in seen:
            seen.add(key)
            result.append(text)
    return result
