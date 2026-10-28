"""
Document intelligence for legal case evidence.

This module turns raw email, Drive, and uploaded document text into a stable
analysis object that the rest of LARO can use for summaries, timelines,
contradiction checks, and lawyer outreach.
"""

import datetime
import html
import os
import re
from collections import Counter
from typing import Any, Dict, Iterable, List, Optional

from local_semantic_analysis import LocalSemanticAnalysisProvider


class DocumentIntelligenceEngine:
    """Extracts legal signals and evidence facts from document contents."""

    def __init__(self, semantic_provider: Optional[LocalSemanticAnalysisProvider] = None) -> None:
        self.semantic_provider = semantic_provider or LocalSemanticAnalysisProvider()

    DATE_PATTERNS = [
        re.compile(r"\b(?P<date>\d{4}[-/]\d{1,2}[-/]\d{1,2})\b"),
        re.compile(r"\b(?P<date>\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\b"),
        re.compile(
            r"\b(?P<date>\d{1,2}\s+(?:jan|januari|feb|februari|mrt|maart|apr|april|mei|jun|juni|jul|juli|aug|augustus|sep|sept|september|okt|oktober|nov|november|dec|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4})\b",
            re.IGNORECASE,
        ),
        re.compile(
            r"\b(?P<date>(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b",
            re.IGNORECASE,
        ),
    ]

    MONTHS = {
        "jan": 1,
        "januari": 1,
        "january": 1,
        "feb": 2,
        "februari": 2,
        "february": 2,
        "mrt": 3,
        "maart": 3,
        "mar": 3,
        "march": 3,
        "apr": 4,
        "april": 4,
        "mei": 5,
        "may": 5,
        "jun": 6,
        "juni": 6,
        "june": 6,
        "jul": 7,
        "juli": 7,
        "july": 7,
        "aug": 8,
        "augustus": 8,
        "august": 8,
        "sep": 9,
        "sept": 9,
        "september": 9,
        "okt": 10,
        "oktober": 10,
        "oct": 10,
        "october": 10,
        "nov": 11,
        "november": 11,
        "dec": 12,
        "december": 12,
    }

    LEGAL_TOPICS = {
        "employment_law": [
            "ontslag",
            "arbeidsovereenkomst",
            "werkgever",
            "werknemer",
            "loon",
            "uwv",
            "transitievergoeding",
            "termination",
            "employment",
            "salary",
        ],
        "tenancy_law": [
            "huur",
            "huurder",
            "verhuurder",
            "woning",
            "gebrek",
            "huurcommissie",
            "lease",
            "tenant",
            "landlord",
            "rent",
        ],
        "consumer_law": [
            "consument",
            "aankoop",
            "garantie",
            "reparatie",
            "refund",
            "warranty",
            "defect",
            "delivery",
        ],
        "family_law": [
            "scheiding",
            "alimentatie",
            "ouderschap",
            "voogdij",
            "divorce",
            "custody",
            "alimony",
        ],
        "contract_law": [
            "overeenkomst",
            "contract",
            "clausule",
            "wanprestatie",
            "breach",
            "agreement",
            "terms",
        ],
        "administrative_law": [
            "besluit",
            "bezwaar",
            "beroep",
            "gemeente",
            "vergunning",
            "decision",
            "permit",
            "objection",
        ],
        "debt_collection": [
            "factuur",
            "betaling",
            "aanmaning",
            "incasso",
            "schuld",
            "invoice",
            "payment",
            "debt",
        ],
    }

    DOCUMENT_TYPE_KEYWORDS = {
        "court_filing": ["rechtbank", "dagvaarding", "verweerschrift", "court", "summons", "pleading"],
        "decision": ["beschikking", "vonnis", "uitspraak", "decision", "judgment", "ruling"],
        "contract": ["overeenkomst", "contract", "terms and conditions", "algemene voorwaarden"],
        "notice": ["ingebrekestelling", "aanmaning", "sommatie", "notice", "demand letter"],
        "invoice": ["factuur", "invoice", "payment request"],
        "correspondence": ["dear", "beste", "geachte", "kind regards", "met vriendelijke groet"],
    }

    LEGAL_SIGNAL_WORDS = [
        "deadline",
        "termijn",
        "bezwaar",
        "beroep",
        "ingebrekestelling",
        "aansprakelijk",
        "liability",
        "breach",
        "wanprestatie",
        "evidence",
        "bewijs",
        "court",
        "rechtbank",
        "contract",
        "overeenkomst",
        "payment",
        "betaling",
        "termination",
        "ontslag",
        "urgent",
        "spoed",
    ]

    OBLIGATION_WORDS = [
        "must",
        "shall",
        "required",
        "obliged",
        "agreed",
        "moet",
        "dient",
        "verplicht",
        "overeengekomen",
        "betaling",
        "betalen",
        "uiterlijk",
        "binnen",
    ]

    RISK_WORDS = [
        "deadline",
        "termijn",
        "verjaring",
        "default",
        "ingebrekestelling",
        "aansprakelijk",
        "penalty",
        "boete",
        "court",
        "rechtbank",
        "summons",
        "dagvaarding",
        "eviction",
        "ontruiming",
    ]

    # These labels describe what the source sentence appears to contain. They
    # are not legal conclusions and every result remains review-gated.
    STATEMENT_CUES = {
        "deadline": ["deadline", "termijn", "uiterlijk", "binnen", "due", "before"],
        "obligation": ["moet", "dient", "verplicht", "shall", "must", "required", "obliged"],
        "decision": ["besluit", "beschikking", "vonnis", "uitspraak", "decision", "judgment", "ruling"],
        "allegation": ["stelt", "gesteld", "beweert", "claimt", "alleges", "claims", "according to"],
        "request": ["verzoek", "verzoeken", "verzoekt", "request", "requested", "please provide"],
        "procedure": ["bezwaar", "beroep", "rechtbank", "zitting", "dagvaarding", "appeal", "court"],
    }

    def enrich_document(self, document: Dict[str, Any], case_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Return a copy of document with extracted text and legal analysis."""
        enriched = dict(document)
        text = self.extract_text_from_document(enriched)
        enriched["content"] = text
        analysis = self.analyze_text(
            text=text,
            document_name=enriched.get("document_name") or enriched.get("name", ""),
            metadata=enriched,
            case_context=case_context,
        )
        enriched["content_summary"] = analysis["summary"]
        enriched["legal_analysis"] = analysis
        enriched["is_key_document"] = bool(
            enriched.get("is_key_document") or analysis["evidence"]["relevance_score"] >= 0.7
        )
        return enriched

    def build_evidence_timeline(self, documents: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Build a chronological timeline with source-document deep links."""
        events = []
        for document in documents:
            analysis = document.get("legal_analysis") or self.analyze_text(
                document.get("content", ""),
                document_name=document.get("document_name", ""),
                metadata=document,
            )
            document_id = document.get("document_id") or document.get("id") or "unknown"
            document_name = document.get("document_name") or document.get("name") or "Untitled document"
            source_url = (
                document.get("source_url")
                or document.get("web_view_link")
                or document.get("document_url")
                or f"#document-{document_id}"
            )

            chronology_events = analysis.get("evidence", {}).get("chronology_events", [])
            if not chronology_events and document.get("upload_date"):
                chronology_events = [
                    {
                        "date": str(document["upload_date"])[:10],
                        "description": analysis.get("summary", ""),
                        "source": "upload_date",
                    }
                ]

            for index, event in enumerate(chronology_events):
                date = event.get("date") or str(document.get("upload_date", ""))[:10] or "Unknown date"
                description = event.get("description") or analysis.get("summary") or document_name
                event_fields = self.timeline_event_fields(description, document)
                actor = event.get("actor") or event_fields["actor"]
                action = event.get("action") or event_fields["action"]
                events.append(
                    {
                        "timeline_id": f"{document_id}-{index}",
                        "date": date,
                        "summary": self._timeline_summary(description),
                        "actor": actor,
                        "action": action,
                        "affected_party": event.get("affected_party") or event_fields["affected_party"],
                        "event_kind": event.get("event_kind") or event_fields["event_kind"],
                        "event_label": f"{actor} {action}".strip(),
                        "evidence_quote": self._timeline_quote(description),
                        "source_document_id": document_id,
                        "source_document_name": document_name,
                        "source": document.get("source", "unknown"),
                        "document_type": analysis.get("document_type") or document.get("document_type", "unknown"),
                        "source_url": source_url,
                        "source_anchor": f"document-{document_id}",
                        "relevance_score": analysis.get("evidence", {}).get("relevance_score", 0.0),
                        "topics": analysis.get("topics", [])[:3],
                        "key_sentences": analysis.get("key_sentences", [])[:2],
                    }
                )

        return sorted(events, key=lambda item: self._timeline_sort_key(item["date"]))

    def extract_text_from_document(self, document: Dict[str, Any]) -> str:
        """Extract text from supported document shapes."""
        for key in ("content", "body", "text", "plain_text"):
            value = document.get(key)
            if isinstance(value, str) and value.strip():
                return self._clean_text(value)

        file_path = document.get("file_path") or document.get("path")
        if file_path:
            return self.extract_text_from_file(file_path)

        html_body = document.get("html") or document.get("html_body")
        if isinstance(html_body, str) and html_body.strip():
            return self._clean_text(self._strip_html(html_body))

        return ""

    def extract_text_from_file(self, file_path: str) -> str:
        """Extract readable text from a local file when available."""
        if not file_path or not os.path.exists(file_path):
            return ""

        extension = os.path.splitext(file_path)[1].lower()
        if extension in {".txt", ".md", ".csv", ".json", ".log", ".eml"}:
            return self._read_text_file(file_path)
        if extension in {".html", ".htm"}:
            return self._clean_text(self._strip_html(self._read_text_file(file_path)))
        if extension == ".pdf":
            return self._extract_pdf_text(file_path)
        if extension == ".docx":
            return self._extract_docx_text(file_path)

        return self._read_text_file(file_path)

    def analyze_text(
        self,
        text: str,
        document_name: str = "",
        metadata: Optional[Dict[str, Any]] = None,
        case_context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Analyze text and return a stable legal evidence object."""
        metadata = metadata or {}
        normalized = self._clean_text(text)
        passages = self._build_source_passages(normalized)
        sentences = [item["text"] for item in passages]
        dates = self._extract_dates(passages)
        legal_references = self._extract_legal_references(normalized)
        topics = self._detect_topics(normalized)
        document_type = self._classify_document_type(document_name, normalized, metadata)
        key_sentences = self._select_key_sentences(sentences)
        obligations = self._select_sentences(sentences, self.OBLIGATION_WORDS, limit=6)
        risk_flags = self._detect_risks(sentences)
        chronology_events = [
            {
                **event,
                **self.timeline_event_fields(event.get("description") or "", metadata),
            }
            for event in self._build_chronology_events(dates)
        ]
        relevance_score = self._score_relevance(normalized, dates, legal_references, topics, key_sentences)
        semantic_reading = self.semantic_provider.analyze(normalized, document_name=document_name)

        return {
            "readable": bool(normalized),
            "summary": self._summarize(normalized, key_sentences),
            "document_type": document_type,
            "topics": topics,
            "key_sentences": key_sentences,
            "facts": {
                "dates": dates,
                "parties": self._extract_parties(normalized, metadata),
                "contacts": self._extract_contacts(normalized, metadata),
                "monetary_amounts": self._extract_money(normalized),
                "legal_references": legal_references,
                "obligations": obligations,
            },
            "risks": risk_flags,
            "evidence": {
                "relevance_score": relevance_score,
                "chronology_events": chronology_events,
                "suggested_evidence_role": self._suggest_evidence_role(document_type, topics, risk_flags),
            },
            "findings": self._build_source_findings(passages),
            "semantic_reading": semantic_reading,
            "processing": {
                "text_length": len(normalized),
                "word_count": len(normalized.split()),
                "sentence_count": len(sentences),
                "confidence": self._confidence(normalized, legal_references, dates),
                "analysis_method": "rule_based_source_passage_v1",
                "semantic_analysis_status": semantic_reading.get("status") or "disabled",
                "semantic_analysis_provider": semantic_reading.get("provider") or "rule_based",
                "analysis_limits": [
                    "Findings identify source passages for review; they do not establish legal facts or legal advice.",
                    "Only material rule-matched passages are listed. The original document remains the authoritative source.",
                ],
            },
        }

    def _read_text_file(self, file_path: str) -> str:
        for encoding in ("utf-8", "utf-8-sig", "cp1252", "latin-1"):
            try:
                with open(file_path, "r", encoding=encoding) as handle:
                    return self._clean_text(handle.read())
            except UnicodeDecodeError:
                continue
        return ""

    def _extract_pdf_text(self, file_path: str) -> str:
        try:
            import PyPDF2

            chunks = []
            with open(file_path, "rb") as handle:
                reader = PyPDF2.PdfReader(handle)
                for page in reader.pages:
                    chunks.append(page.extract_text() or "")
            return self._clean_text("\n".join(chunks))
        except Exception:
            return ""

    def _extract_docx_text(self, file_path: str) -> str:
        try:
            import docx

            document = docx.Document(file_path)
            return self._clean_text("\n".join(paragraph.text for paragraph in document.paragraphs))
        except Exception:
            return ""

    def _strip_html(self, value: str) -> str:
        # Fixed-length tokens and monotonic cursors avoid retrying an unbounded
        # suffix for each malformed opening tag. Preserve the legacy extraction
        # semantics, including incomplete tags and Unicode IGNORECASE spelling.
        folded_letters = str.maketrans({"Ä°": "i", "Ä±": "i", "Å¿": "s"})

        def token_kind(match):
            return match.group(1).translate(folded_letters).lower()

        closings = {}
        for match in re.finditer(r"</(script|style)>", value, re.IGNORECASE):
            closings.setdefault(token_kind(match), []).append((match.start(), match.end()))
        positions = {}
        chunks = []
        cursor = 0
        for match in re.finditer(r"<(script|style)", value, re.IGNORECASE):
            if match.start() < cursor:
                continue
            kind = token_kind(match)
            ends = closings.get(kind, [])
            index = positions.get(kind, 0)
            while index < len(ends) and ends[index][0] < match.end():
                index += 1
            positions[kind] = index
            if index < len(ends):
                chunks.extend((value[cursor:match.start()], " "))
                cursor = ends[index][1]
        chunks.append(value[cursor:])
        without_blocks = "".join(chunks)

        chunks = []
        cursor = 0
        opening = None
        for index, character in enumerate(without_blocks):
            if character == "<" and opening is None:
                opening = index
            elif character == ">":
                if opening is not None and index > opening + 1:
                    chunks.extend((without_blocks[cursor:opening], " "))
                    cursor = index + 1
                opening = None
        chunks.append(without_blocks[cursor:])
        return html.unescape("".join(chunks))

    def _clean_text(self, value: str) -> str:
        return re.sub(r"\s+", " ", value or "").strip()

    def _split_sentences(self, text: str) -> List[str]:
        if not text:
            return []
        return [part.strip() for part in re.split(r"(?<=[.!?])\s+", text) if part.strip()]

    def _build_source_passages(self, text: str) -> List[Dict[str, Any]]:
        """Return stable sentence locators without storing a second full copy of a document."""
        passages = []
        for match in re.finditer(r"[^.!?]+(?:[.!?]+|$)", text or ""):
            raw = match.group(0)
            leading = len(raw) - len(raw.lstrip())
            trailing = len(raw) - len(raw.rstrip())
            start = match.start() + leading
            end = match.end() - trailing
            sentence = text[start:end].strip()
            if not sentence:
                continue
            passages.append({
                "id": f"p{len(passages) + 1}",
                "text": sentence,
                "start_char": start,
                "end_char": end,
            })
        return passages

    def _extract_dates(self, sentences: Iterable[Any]) -> List[Dict[str, Any]]:
        dates = []
        seen = set()
        for source in sentences:
            passage = source if isinstance(source, dict) else {}
            sentence = str(passage.get("text") if passage else source or "")
            for pattern in self.DATE_PATTERNS:
                for match in pattern.finditer(sentence):
                    raw = match.group("date")
                    normalized = self._normalize_date(raw)
                    key = (raw.lower(), normalized, sentence[:80])
                    if key in seen:
                        continue
                    seen.add(key)
                    item = {
                        "raw": raw,
                        "normalized": normalized or raw,
                        "context": sentence[:220],
                    }
                    if passage:
                        item["source_locator"] = {
                            "passage_id": passage.get("id"),
                            "start_char": passage.get("start_char", 0) + match.start(),
                            "end_char": passage.get("start_char", 0) + match.end(),
                        }
                    dates.append(item)
        return dates

    def _statement_categories(self, text: str) -> List[str]:
        lowered = text.lower()
        categories = [
            category
            for category, cues in self.STATEMENT_CUES.items()
            if any(cue in lowered for cue in cues)
        ]
        return categories or ["factual_statement"]

    def _build_source_findings(self, passages: List[Dict[str, Any]], limit: int = 24) -> Dict[str, Any]:
        """Expose reviewable, bounded source passages for downstream legal workflows."""
        statements = []
        category_counts = Counter()
        for passage in passages:
            text = passage["text"]
            categories = self._statement_categories(text)
            has_date = any(pattern.search(text) for pattern in self.DATE_PATTERNS)
            has_reference = bool(self._extract_legal_references(text))
            has_money = bool(self._extract_money(text))
            material = categories != ["factual_statement"] or has_date or has_reference or has_money
            if not material:
                continue
            for category in categories:
                category_counts[category] += 1
            statements.append({
                "passage_id": passage["id"],
                "categories": categories,
                "excerpt": text[:320],
                "source_locator": {
                    "start_char": passage["start_char"],
                    "end_char": passage["end_char"],
                },
                "requires_review": any(category != "factual_statement" for category in categories),
                "confidence": "rule_based",
            })
            if len(statements) >= limit:
                break
        return {
            "source_passages": statements,
            "material_statement_count": len(statements),
            "category_counts": dict(sorted(category_counts.items())),
            "complete_statement_inventory": False,
        }

    def _normalize_date(self, raw: str) -> Optional[str]:
        cleaned = raw.strip().replace(".", "").replace(",", "")
        for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%d-%m-%Y", "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%y", "%d/%m/%y"):
            try:
                return datetime.datetime.strptime(cleaned, fmt).date().isoformat()
            except ValueError:
                pass

        parts = cleaned.lower().split()
        if len(parts) == 3:
            if parts[0].isdigit():
                day = int(parts[0])
                month = self.MONTHS.get(parts[1][:3], self.MONTHS.get(parts[1]))
                year = int(parts[2])
            else:
                month = self.MONTHS.get(parts[0][:3], self.MONTHS.get(parts[0]))
                day = int(parts[1])
                year = int(parts[2])
            if month:
                try:
                    return datetime.date(year, month, day).isoformat()
                except ValueError:
                    return None
        return None

    def _extract_contacts(self, text: str, metadata: Dict[str, Any]) -> Dict[str, List[str]]:
        emails = set(re.findall(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", text, flags=re.IGNORECASE))
        for key in ("from", "to", "cc"):
            value = metadata.get(key)
            if isinstance(value, str) and "@" in value:
                emails.add(value)
        phones = set(re.findall(r"(?:\+31|0031|0)\s?(?:\d[\s-]?){8,10}\b", text))
        return {"emails": sorted(emails), "phones": sorted(phones)}

    def _extract_parties(self, text: str, metadata: Dict[str, Any]) -> List[str]:
        candidates = set()
        for key in ("from", "to", "sender", "recipient"):
            value = metadata.get(key)
            if isinstance(value, str) and value.strip():
                candidates.add(value.strip())

        labels = r"(?:partij|eiser|gedaagde|huurder|verhuurder|werkgever|werknemer|client|landlord|tenant|employer|employee)"
        for match in re.finditer(labels + r"\s*[:\-]\s*([A-Z][A-Za-z .'-]{2,80})", text, flags=re.IGNORECASE):
            candidates.add(match.group(1).strip())

        return sorted(candidate for candidate in candidates if len(candidate) <= 120)

    def _extract_money(self, text: str) -> List[Dict[str, str]]:
        amounts = []
        pattern = re.compile(r"(?:EUR|euro|eur\.?)\s?\d[\d.,]*|\d[\d.,]*\s?(?:EUR|euro)", re.IGNORECASE)
        for match in pattern.finditer(text):
            amounts.append({"raw": match.group(0), "context": text[max(0, match.start() - 80) : match.end() + 80]})
        return amounts[:20]

    def _extract_legal_references(self, text: str) -> List[Dict[str, str]]:
        references = []
        patterns = {
            "ecli": r"\bECLI:[A-Z]{2}:[A-Z0-9]+:\d{4}:[A-Z0-9.]+\b",
            "case_number": r"\b(?:zaaknummer|kenmerk|referentie|dossiernummer|case no\.?|ref\.?)\s*[:#]?\s*([A-Z0-9][A-Z0-9./-]{3,})\b",
            "statute_article": r"\b(?:artikel|art\.?)\s+\d+[a-z]?(?::\d+[a-z]?)?\s*(?:bw|rv|sr|awb)?\b",
        }
        seen = set()
        for reference_type, pattern in patterns.items():
            for match in re.finditer(pattern, text, flags=re.IGNORECASE):
                raw = match.group(0).strip()
                key = (reference_type, raw.lower())
                if key not in seen:
                    seen.add(key)
                    references.append({"type": reference_type, "value": raw})
        return references

    def _detect_topics(self, text: str) -> List[Dict[str, Any]]:
        lowered = text.lower()
        topics = []
        for topic, keywords in self.LEGAL_TOPICS.items():
            hits = sorted({keyword for keyword in keywords if keyword in lowered})
            if hits:
                topics.append({"topic": topic, "score": min(1.0, len(hits) / 4), "matched_terms": hits[:8]})
        topics.sort(key=lambda item: item["score"], reverse=True)
        return topics

    def _classify_document_type(self, document_name: str, text: str, metadata: Dict[str, Any]) -> str:
        extension = os.path.splitext(document_name or metadata.get("file_path", ""))[1].lower()
        if metadata.get("document_type") == "email" or metadata.get("source") in {"gmail", "outlook"}:
            return "correspondence"
        if extension in {".jpg", ".jpeg", ".png", ".gif"}:
            return "image_evidence"

        lowered = f"{document_name} {text}".lower()
        matches = []
        priority = {
            "notice": 6,
            "decision": 5,
            "court_filing": 4,
            "contract": 3,
            "invoice": 2,
            "correspondence": 1,
        }
        for document_type, keywords in self.DOCUMENT_TYPE_KEYWORDS.items():
            hit_count = sum(1 for keyword in keywords if keyword in lowered)
            if hit_count:
                matches.append((hit_count, priority.get(document_type, 0), document_type))
        if matches:
            matches.sort(reverse=True)
            return matches[0][2]
        return metadata.get("document_type") or "unknown"

    def _select_key_sentences(self, sentences: List[str], limit: int = 6) -> List[str]:
        scored = []
        for sentence in sentences:
            lowered = sentence.lower()
            score = sum(1 for word in self.LEGAL_SIGNAL_WORDS if word in lowered)
            score += len(self._extract_legal_references(sentence)) * 2
            score += len(self._extract_money(sentence))
            score += 1 if any(pattern.search(sentence) for pattern in self.DATE_PATTERNS) else 0
            if score:
                scored.append((score, sentence))

        scored.sort(key=lambda item: item[0], reverse=True)
        selected = []
        for _, sentence in scored:
            if sentence not in selected:
                selected.append(sentence[:320])
            if len(selected) >= limit:
                break
        return selected

    def _select_sentences(self, sentences: List[str], words: List[str], limit: int) -> List[str]:
        selected = []
        for sentence in sentences:
            lowered = sentence.lower()
            if any(word in lowered for word in words):
                selected.append(sentence[:320])
            if len(selected) >= limit:
                break
        return selected

    def _detect_risks(self, sentences: List[str]) -> List[Dict[str, str]]:
        risks = []
        for sentence in sentences:
            lowered = sentence.lower()
            matched = [word for word in self.RISK_WORDS if word in lowered]
            if matched:
                risks.append({"signal": matched[0], "context": sentence[:260]})
            if len(risks) >= 8:
                break
        return risks

    def _build_chronology_events(self, dates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [
            {
                "date": item["normalized"],
                "description": item["context"],
                "source": "document_intelligence",
                "source_locator": item.get("source_locator") or {},
            }
            for item in dates
            if item.get("normalized")
        ]

    def _score_relevance(
        self,
        text: str,
        dates: List[Dict[str, str]],
        legal_references: List[Dict[str, str]],
        topics: List[Dict[str, Any]],
        key_sentences: List[str],
    ) -> float:
        if not text:
            return 0.0
        lowered = text.lower()
        keyword_hits = sum(1 for word in self.LEGAL_SIGNAL_WORDS if word in lowered)
        score = 0.2
        score += min(0.3, keyword_hits * 0.035)
        score += min(0.2, len(dates) * 0.05)
        score += min(0.25, len(legal_references) * 0.1)
        score += min(0.15, len(topics) * 0.05)
        score += min(0.05, len(key_sentences) * 0.01)
        return round(min(1.0, score), 2)

    def _suggest_evidence_role(self, document_type: str, topics: List[Dict[str, Any]], risks: List[Dict[str, str]]) -> str:
        if document_type in {"decision", "court_filing", "notice"}:
            return "procedural_anchor"
        if document_type == "contract":
            return "rights_and_obligations"
        if risks:
            return "risk_or_deadline"
        if topics:
            return "substantive_support"
        return "background"

    def _summarize(self, text: str, key_sentences: List[str]) -> str:
        if not text:
            return "No readable text was extracted from this document."
        if key_sentences:
            return " ".join(key_sentences[:3])
        words = text.split()
        if len(words) <= 70:
            return text
        return " ".join(words[:70]) + "..."

    def _timeline_summary(self, text: str) -> str:
        words = self._clean_text(text).split()
        if len(words) <= 28:
            return " ".join(words)
        return " ".join(words[:28]) + "..."

    def _timeline_quote(self, text: str) -> str:
        cleaned = self._clean_text(text)
        if len(cleaned) <= 180:
            return cleaned
        return cleaned[:177].rstrip() + "..."

    def timeline_event_fields(self, text: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
        """Return conservative who/did-what fields grounded in source text or envelope metadata."""
        metadata = metadata or {}
        actor = self._timeline_actor(text, metadata)
        action = self._timeline_action(text)
        return {
            "actor": actor,
            "action": action,
            "affected_party": self._timeline_affected_party(text, metadata, actor),
            "event_kind": self._timeline_event_kind(action, text),
        }

    def _timeline_actor(self, text: str, metadata: Dict[str, Any]) -> str:
        for key in ("from", "sender", "author", "created_by"):
            value = metadata.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

        cleaned = self._clean_text(text)
        verb_pattern = r"\b(sent|sends|received|receives|wrote|writes|stated|states|decided|decides|invoiced|demands|requested|requests|confirmed|confirms|explained|explains|filed|files|paid|pays|rejected|rejects|approved|approves)\b"
        match = re.search(verb_pattern, cleaned, flags=re.IGNORECASE)
        if match:
            candidate = cleaned[:match.start()].strip(" ,.;:-")
            if "," in candidate:
                candidate = candidate.rsplit(",", 1)[-1].strip()
            candidate = re.sub(
                r"^(?:on|op)\s+\d{4}[-/]\d{1,2}[-/]\d{1,2}\s*",
                "",
                candidate,
                flags=re.IGNORECASE,
            ).strip(" ,.;:-")
            words = candidate.split()
            if words:
                return " ".join(words[-4:])[:80]

        party_match = re.search(r"\b(CAK|NO|Noodzakelijk Online|Robert|client|lawyer|gemeente|landlord|tenant|employer|employee)\b", cleaned, flags=re.IGNORECASE)
        if party_match:
            return party_match.group(0)
        return "Unknown actor"

    def _timeline_action(self, text: str) -> str:
        lowered = self._clean_text(text).lower()
        action_map = [
            ("sent", "sent"),
            ("verzond", "sent"),
            ("received", "received"),
            ("ontving", "received"),
            ("wrote", "wrote"),
            ("schreef", "wrote"),
            ("stated", "stated"),
            ("verklaarde", "stated"),
            ("decided", "decided"),
            ("decision", "decided"),
            ("besloot", "decided"),
            ("beslissing", "decided"),
            ("invoic", "issued invoice"),
            ("factuur", "issued invoice"),
            ("demand", "demanded"),
            ("sommeerde", "demanded"),
            ("request", "requested"),
            ("verzocht", "requested"),
            ("confirm", "confirmed"),
            ("bevestigde", "confirmed"),
            ("explain", "explained"),
            ("lichtte toe", "explained"),
            ("file", "filed"),
            ("diende", "filed"),
            ("paid", "paid"),
            ("betaalde", "paid"),
            ("reject", "rejected"),
            ("wees af", "rejected"),
            ("approv", "approved"),
            ("keurde goed", "approved"),
            ("deadline", "set deadline"),
            ("uiterlijk", "set deadline"),
            ("termijn", "set deadline"),
            ("must", "created obligation"),
            ("shall", "created obligation"),
            ("moet", "created obligation"),
            ("dient", "created obligation"),
        ]
        for needle, action in action_map:
            if needle in lowered:
                return action
        return "documented"

    def _timeline_affected_party(self, text: str, metadata: Dict[str, Any], actor: str) -> str:
        for key in ("to", "recipient", "affected_party", "addressee"):
            value = metadata.get(key)
            if isinstance(value, str) and value.strip() and value.strip().lower() != actor.lower():
                return value.strip()[:255]

        cleaned = self._clean_text(text)
        patterns = (
            r"\b(?:stated|states|decided|requested|demanded|confirmed|verklaarde|besloot|verzocht|sommeerde|bevestigde)\s+(?:that\s+)?([A-Z][A-Za-z0-9 .'-]{1,60}?)\s+(?:must|shall|should|moet|dient)\b",
            r"\b(?:to|aan|tegen)\s+([A-Z][A-Za-z0-9 .'-]{1,60}?)(?:\s+on\s+behalf|\s+op\s+|[,.;:]|$)",
        )
        for pattern in patterns:
            match = re.search(pattern, cleaned)
            if match:
                candidate = match.group(1).strip(" ,.;:-")
                if candidate and candidate.lower() != actor.lower():
                    return candidate[:255]
        return ""

    def _timeline_event_kind(self, action: str, text: str) -> str:
        if action in {"sent", "received", "wrote", "stated", "requested", "confirmed", "explained", "demanded"}:
            return "communication"
        if action in {"decided", "approved", "rejected"}:
            return "decision"
        if action == "filed":
            return "filing"
        if action in {"paid", "issued invoice"}:
            return "financial"
        if action == "created obligation":
            return "obligation"
        if action == "set deadline":
            return "deadline"
        lowered = self._clean_text(text).lower()
        if any(term in lowered for term in ("hearing", "zitting", "hoorzitting")):
            return "hearing"
        return "event"

    def _timeline_sort_key(self, date_value: str) -> str:
        normalized = self._normalize_date(str(date_value))
        return normalized or str(date_value)

    def _confidence(self, text: str, legal_references: List[Dict[str, str]], dates: List[Dict[str, str]]) -> str:
        if len(text) < 40:
            return "low"
        if legal_references or len(dates) >= 2 or len(text) > 1000:
            return "high"
        return "medium"

    def top_terms(self, text: str, limit: int = 12) -> List[str]:
        words = re.findall(r"\b[a-zA-Z][a-zA-Z]{3,}\b", text.lower())
        stop_words = {
            "this",
            "that",
            "with",
            "from",
            "have",
            "will",
            "voor",
            "zijn",
            "naar",
            "door",
            "over",
            "heeft",
            "wordt",
        }
        counts = Counter(word for word in words if word not in stop_words)
        return [word for word, _ in counts.most_common(limit)]
