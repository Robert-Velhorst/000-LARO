"""
Updated app.py with integrated serverless architecture for Legal AI Platform

This file integrates the serverless architecture components with the main Flask application.
"""

import os
import sys
import logging
import datetime
import hashlib
import io
import ipaddress
import json
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode, urlsplit
from flask import Flask, request, jsonify, render_template, render_template_string, send_from_directory, send_file, session, redirect
from flask_sqlalchemy import SQLAlchemy
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.utils import secure_filename

# Import custom modules
from authentication import EmailAuthenticationSystem
from case_matching import LegalCaseMatcher
from document_aggregation import DocumentAggregator
from document_case_matching import rank_document_cases
from document_intelligence import DocumentIntelligenceEngine
from lawyer_outreach import LawyerOutreachSystem
from outreach_analytics import build_outreach_analytics
from dashboard_backend import BusinessMetricsDashboard
from graphql_bridge import init_app as init_graphql
from db_integration import init_app as init_db
from db_optimization import db_manager
from timeseries_manager import timeseries_manager
from serverless_architecture import init_app as init_serverless, publish_event
from serverless_functions import init_serverless_functions
from google_oauth import (
    GOOGLE_SCOPES,
    build_google_oauth_state,
    build_google_oauth_url,
    exchange_google_oauth_code,
    google_oauth_config,
)
from google_evidence import GoogleEvidenceConnector, GoogleEvidenceError
from google_token_store import LocalEncryptedTokenStore, TokenStoreError
from dutch_legal_taxonomy import (
    build_case_matching_profile,
    normalize_legal_fields,
    public_taxonomy,
)
from legal_ledger import init_legal_ledger
from outreach_discovery import OutreachDiscoveryError, OutreachTargetDiscovery
from case_bundle_export import CaseBundleExporter, CaseBundleExportError, DEFAULT_MAX_BUNDLE_BYTES

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger('legal_ai_platform')

# Initialize Flask app
app = Flask(__name__, static_folder='frontend', template_folder='frontend')
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', os.urandom(24).hex())
app.config['MAX_CONTENT_LENGTH'] = int(os.environ.get('LARO_MAX_UPLOAD_BYTES', 25 * 1024 * 1024))
app.config.setdefault('LARO_LOCAL_ACCOUNT_EMAIL', os.environ.get('LARO_LOCAL_ACCOUNT_EMAIL', 'robert.local@laro').strip().lower())
app.config.setdefault('SQLALCHEMY_DATABASE_URI', os.environ.get('LARO_APP_DB_URL', 'sqlite:///:memory:'))
app.config.setdefault('SQLALCHEMY_TRACK_MODIFICATIONS', False)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=0, x_proto=0, x_host=0, x_port=0, x_prefix=0)
db = SQLAlchemy(app)


@app.route('/favicon.ico')
def favicon():
    """Avoid a noisy browser 404 when a deployment has no custom icon."""
    return '', 204


def create_app(**config):
    """Compatibility app factory for tests and local integrations.

    The existing project is organized around a module-level Flask app. Returning
    that app keeps current routes/components intact while allowing tests and
    local tools to override configuration before using the shared extensions.
    """
    app.config.update(config)
    return app

# Initialize components
auth_system = EmailAuthenticationSystem(app)
case_matcher = LegalCaseMatcher()
dashboard = BusinessMetricsDashboard()
document_intelligence = DocumentIntelligenceEngine()

# Initialize GraphQL
init_graphql(app)

# Initialize database integration
init_db(app)

# Initialize serverless architecture
init_serverless(app)
init_serverless_functions()

# Initialize the local-first persistent legal case ledger
legal_ledger = init_legal_ledger(app)
google_token_store = LocalEncryptedTokenStore()
google_pull_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix='laro-google-pull')
case_analysis_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='laro-case-analysis')

def _ledger_actor():
    return str(session.get('user_email') or session.get('user_id') or 'anonymous')


def _local_session_owner_email():
    return str(app.config.get('LARO_LOCAL_ACCOUNT_EMAIL') or 'robert.local@laro').strip().lower()


def _is_loopback_request():
    try:
        original = request.environ.get('werkzeug.proxy_fix.orig', {})
        remote_address = original.get('REMOTE_ADDR') or request.remote_addr
        return ipaddress.ip_address(str(remote_address or '')).is_loopback
    except ValueError:
        return False


def _is_loopback_host(host):
    try:
        return str(host or '').strip().lower() == 'localhost' or ipaddress.ip_address(str(host or '')).is_loopback
    except ValueError:
        return False


def _ledger_case_access_allowed(case_id, external_user_id=None):
    """Keep all authenticated case routes scoped to their owning local user."""
    try:
        return legal_ledger.user_owns_case(int(case_id), external_user_id or _ledger_actor())
    except (TypeError, ValueError):
        return False


app.config['LARO_CASE_ACCESS_CHECK'] = _ledger_case_access_allowed


def _ledger_user_payload(data=None):
    payload = dict(data or {})
    payload.setdefault('user_id', _ledger_actor())
    if session.get('user_email'):
        payload.setdefault('user_email', session.get('user_email'))
    return payload


def _field_id(value):
    if isinstance(value, dict):
        return value.get('field_id') or value.get('id') or value.get('field_name')
    return value


def _legacy_case_from_ledger(case):
    return {
        'case_id': case['case_id'],
        'user_id': case['user_id'],
        'case_description': case.get('description', ''),
        'matched_fields': [{'field_id': case.get('legal_domain', 'unknown'), 'field_name': case.get('legal_domain', 'Unknown')}],
        'complexity': {'complexity_level': case.get('risk_level', 'medium')},
        'summary': case.get('current_summary', ''),
        'status': case.get('status', 'pending'),
        'postcode_or_city': '',
    }


def _case_for_legacy_endpoint(case_id):
    """Return legacy-shaped case data from the durable legal ledger."""
    ledger_case = legal_ledger.get_case(int(case_id))
    if ledger_case:
        return ledger_case, _legacy_case_from_ledger(ledger_case)
    return None, None


def _case_matching_payload(ledger_case, legacy_case, request_data):
    case_profile = build_case_matching_profile(
        ledger_case,
        documents=legal_ledger.list_documents(int(ledger_case['case_id'])) if ledger_case else [],
        claims=legal_ledger.list_claims(int(ledger_case['case_id'])) if ledger_case else [],
        contradictions=legal_ledger.list_contradictions(int(ledger_case['case_id'])) if ledger_case else [],
        deadlines=legal_ledger.list_deadlines(int(ledger_case['case_id'])) if ledger_case else [],
        obligations=legal_ledger.list_obligations(int(ledger_case['case_id'])) if ledger_case else [],
    )
    legal_domain = (ledger_case or {}).get('legal_domain') or 'unknown'
    manual_fields = request_data.get('legal_fields')
    requested_fields = (
        manual_fields
        or (legacy_case or {}).get('matched_fields')
        or ([legal_domain] if legal_domain else [])
    )
    if not isinstance(requested_fields, list):
        requested_fields = [requested_fields]
    legal_fields = normalize_legal_fields([
        field for field in (_field_id(item) for item in requested_fields)
        if field and str(field).strip().lower() not in {'unknown', 'general', 'general_law'}
    ])
    if not manual_fields:
        legal_fields = list(dict.fromkeys(
            legal_fields + case_profile.get('inferred_legal_fields', [])
        ))[:4]
    requested_topics = request_data.get('evidence_topics') or []
    if isinstance(requested_topics, str):
        requested_topics = [requested_topics]
    evidence_topics = list(dict.fromkeys([
        *[str(item).strip() for item in requested_topics if str(item).strip()],
        *case_profile.get('evidence_topics', []),
    ]))
    return {
        'description': (ledger_case or {}).get('description') or (legacy_case or {}).get('case_description', ''),
        'summary': (ledger_case or {}).get('current_summary') or (legacy_case or {}).get('summary', ''),
        'legal_fields': legal_fields,
        'manual_legal_field_override': bool(manual_fields),
        'complexity': (legacy_case or {}).get('complexity') or {'complexity_level': (ledger_case or {}).get('risk_level', 'medium')},
        'evidence_topics': evidence_topics,
        'case_profile': case_profile,
        'case_source_coverage': case_profile.get('source_coverage', {}),
        'desired_outcome': request_data.get('desired_outcome') or (ledger_case or {}).get('desired_outcome', ''),
        'urgency': request_data.get('urgency') or (ledger_case or {}).get('priority', 'normal'),
        'region': request_data.get('region') or request_data.get('location') or (ledger_case or {}).get('court_or_institution') or 'Netherlands',
        'postcode_or_city': request_data.get('postcode_or_city') or request_data.get('location') or (legacy_case or {}).get('postcode_or_city', ''),
        'radius_km': request_data.get('radius_km') or request_data.get('search_radius_km') or 50,
        'requires_financed_legal_aid': request_data.get('requires_financed_legal_aid', False),
        'prefer_specialization_association': request_data.get('prefer_specialization_association', True),
        'require_specialization_association': request_data.get('require_specialization_association', False),
        'nova_subject_ids': request_data.get('nova_subject_ids', []),
        'nova_specialization_ids': request_data.get('nova_specialization_ids', []),
        'lawyer_name': request_data.get('lawyer_name', ''),
        'max_results': request_data.get('max_results', 30),
    }


def _ledger_outreach_snapshot(case_id):
    records = []
    for item in legal_ledger.list_outreach(int(case_id)):
        records.append({
            **item,
            'outreach_id': item.get('id'),
            'target_type': 'lawyers',
            'category': 'lawyers',
            'sent_timestamp': item.get('sent_at') or item.get('created_at'),
            'lawyer_id': item.get('lawyer_email') or item.get('id'),
            'email': item.get('lawyer_email'),
        })
    snapshot = type('LedgerOutreachSnapshot', (), {})()
    snapshot.outreach_records = records
    snapshot.responses = legal_ledger.list_lawyer_responses(int(case_id))
    return snapshot


def _ledger_document_analysis_snapshot(case_id):
    """Return source-linked document intelligence from persisted ledger records."""
    documents_for_case = legal_ledger.list_documents(int(case_id))
    if not documents_for_case:
        return {}

    timeline = legal_ledger.list_timeline(int(case_id))
    claims = legal_ledger.list_claims(int(case_id))
    evidence_links = legal_ledger.list_evidence_links(int(case_id))
    contradictions = legal_ledger.list_contradictions(int(case_id))
    deadlines = legal_ledger.list_deadlines(int(case_id))
    missing_evidence = legal_ledger.list_missing_evidence(int(case_id))
    open_loops = legal_ledger.list_open_loops(int(case_id))

    links_by_document = {}
    target_links_by_document = {}
    for link in evidence_links:
        document_id = link.get('document_id')
        if document_id is None:
            continue
        links_by_document.setdefault(document_id, []).append(link)
        target_links_by_document.setdefault(document_id, {}).setdefault(
            f"{link.get('target_type')}:{link.get('target_id')}",
            [],
        ).append(link)

    def linked_targets(document_id, target_type, records):
        direct = []
        linked = target_links_by_document.get(document_id, {})
        for record in records:
            key = f"{target_type}:{record.get('id')}"
            if key in linked:
                direct.append({
                    **record,
                    'source_links': linked[key],
                })
        return direct

    def contradictions_for_document(document_id):
        matches = []
        for item in contradictions:
            refs = item.get('source_refs') or []
            if any(str(document_id) in json.dumps(ref, default=str) for ref in refs):
                matches.append(item)
        return matches

    analyses = {}
    for document in documents_for_case:
        document_id = document.get('document_id')
        analysis = ((document.get('metadata') or {}).get('legal_analysis') or {})
        source_links = links_by_document.get(document_id, [])
        document_timeline = [
            item for item in timeline
            if item.get('created_from_document_id') == document_id
        ]
        linked_timeline = linked_targets(document_id, 'event', timeline)
        analysis_payload = {
            **analysis,
            'document': {
                'document_id': document_id,
                'title': document.get('title') or document.get('original_filename') or 'Untitled document',
                'source_type': document.get('source_type'),
                'source_uri': document.get('source_uri'),
                'document_type': document.get('document_type'),
                'date_on_document': document.get('date_on_document'),
                'sender': document.get('sender'),
                'recipient': document.get('recipient'),
                'content_hash': document.get('content_hash'),
                'confidentiality_level': document.get('confidentiality_level'),
                'relevance_score': document.get('relevance_score'),
                'has_extracted_text': bool(document.get('extracted_text')),
                'summary': document.get('summary') or analysis.get('summary') or '',
            },
            'reading_status': {
                'readable': bool(analysis.get('readable') or document.get('extracted_text')),
                'word_count': (
                    ((analysis.get('processing') or {}).get('word_count'))
                    or len((document.get('extracted_text') or '').split())
                ),
                'source_links': len(source_links),
                'timeline_events': len({item.get('id') for item in [*document_timeline, *linked_timeline]}),
                'claims': len(linked_targets(document_id, 'claim', claims)),
                'open_review_items': (
                    len(contradictions_for_document(document_id))
                    + len([item for item in deadlines if item.get('source_document_id') == document_id and item.get('status') not in {'resolved', 'dismissed'}])
                    + len([item for item in missing_evidence if item.get('document_id') == document_id and item.get('status') not in {'resolved', 'dismissed'}])
                ),
            },
            'source_links': source_links,
            'timeline_events': [*document_timeline, *[
                item for item in linked_timeline
                if item.get('id') not in {event.get('id') for event in document_timeline}
            ]],
            'claims': linked_targets(document_id, 'claim', claims),
            'deadlines': [
                item for item in deadlines
                if item.get('source_document_id') == document_id
            ],
            'contradictions': contradictions_for_document(document_id),
            'missing_evidence': [
                item for item in missing_evidence
                if item.get('document_id') == document_id
            ],
            'open_loops': linked_targets(document_id, 'open_loop', open_loops),
            'legal_safety': {
                'source_analysis_only': True,
                'requires_human_review': True,
                'no_external_action_taken': True,
            },
        }
        if analysis_payload.get('document_type') is None:
            analysis_payload['document_type'] = document.get('document_type')
        analyses[document_id] = analysis_payload
    return analyses


def _upload_root():
    configured = os.environ.get('LARO_UPLOAD_ROOT')
    canonical = os.path.join(app.instance_path, 'uploads')
    legacy = os.path.join(app.instance_path, 'laro_uploads')
    root = configured or (legacy if os.path.isdir(legacy) and not os.path.exists(canonical) else canonical)
    os.makedirs(root, exist_ok=True)
    return root


def _case_upload_dir(case_id):
    path = os.path.join(_upload_root(), f'case_{int(case_id)}')
    os.makedirs(path, exist_ok=True)
    return path


def _safe_upload_name(filename):
    name = secure_filename(filename or 'uploaded-document')
    return name or 'uploaded-document'


def _store_upload_in_directory(directory, storage, *, stable_name=False):
    original_name = storage.filename or 'uploaded-document'
    safe_name = _safe_upload_name(original_name)
    contents = storage.read()
    digest = hashlib.sha256(contents).hexdigest()
    stem, extension = os.path.splitext(safe_name)
    if stable_name:
        stored_name = f"{digest[:20]}{extension.lower()}"
    else:
        prefix = f"{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S')}_{digest[:12]}"
        stored_name = f"{prefix}_{stem[:80]}{extension.lower()}"
    local_path = os.path.join(directory, stored_name)
    if not os.path.isfile(local_path):
        with open(local_path, 'wb') as handle:
            handle.write(contents)
    return {
        'original_name': original_name,
        'stored_name': stored_name,
        'local_path': local_path,
        'content_hash': digest,
        'size_bytes': len(contents),
        'extension': extension.lower().replace('.', '') or 'unknown',
    }


def _store_upload_file(case_id, storage):
    return _store_upload_in_directory(_case_upload_dir(case_id), storage)


def _inbox_upload_dir(actor):
    actor_key = hashlib.sha256(str(actor or 'anonymous').encode('utf-8')).hexdigest()[:16]
    path = os.path.join(_upload_root(), 'document_inbox', actor_key)
    os.makedirs(path, exist_ok=True)
    return path


def _store_inbox_upload_file(actor, storage):
    return _store_upload_in_directory(_inbox_upload_dir(actor), storage, stable_name=True)


def _safe_served_upload_path(local_path):
    if not local_path:
        return None
    resolved = os.path.abspath(local_path)
    upload_root = os.path.abspath(_upload_root())
    try:
        if os.path.commonpath([upload_root, resolved]) != upload_root:
            return None
    except ValueError:
        return None
    if not os.path.isfile(resolved):
        return None
    return resolved


def _timeline_suggestions_from_analysis(case_id, document, analysis, actor):
    source_confidence = _source_confidence_from_analysis(analysis)
    events = []
    for item in (analysis.get('evidence') or {}).get('chronology_events', [])[:12]:
        description = item.get('description') or ''
        event_fields = document_intelligence.timeline_event_fields(description, {
            **(document.get('metadata') or {}),
            'sender': document.get('sender') or '',
            'recipient': document.get('recipient') or '',
        })
        event = legal_ledger.add_event(case_id, {
            'event_date': item.get('date') or datetime.datetime.now(datetime.timezone.utc).date().isoformat(),
            'title': description or 'Timeline suggestion',
            'description': description,
            'event_type': 'suggested_from_document',
            'event_kind': item.get('event_kind') or event_fields['event_kind'],
            'actor': item.get('actor') or event_fields['actor'],
            'event_action': item.get('action') or event_fields['action'],
            'affected_party': item.get('affected_party') or event_fields['affected_party'],
            'source_confidence': source_confidence,
            'user_confirmed': False,
            'created_from_document_id': document['document_id'],
            'evidence_quote': description,
        }, actor=actor)
        if event:
            events.append(event)
    return events


def _source_confidence_from_analysis(analysis):
    confidence_map = {'low': 0.35, 'medium': 0.6, 'high': 0.85}
    raw_confidence = (analysis.get('processing') or {}).get('confidence', 0)
    return confidence_map.get(str(raw_confidence).lower(), raw_confidence)


def _context_preview(value, limit=180):
    cleaned = ' '.join(str(value or '').split())
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 1].rstrip() + '.'


def _deadline_title_from_context(context):
    lowered = (context or '').lower()
    if any(term in lowered for term in ('objection', 'bezwaar')):
        return 'Review objection deadline'
    if any(term in lowered for term in ('appeal', 'beroep')):
        return 'Review appeal deadline'
    if any(term in lowered for term in ('hearing', 'zitting')):
        return 'Review hearing date'
    if any(term in lowered for term in ('submit', 'indienen', 'aanleveren')):
        return 'Review submission deadline'
    return 'Review extracted deadline'


def _context_looks_like_deadline(context):
    lowered = f" {(context or '').lower()} "
    strong_terms = (
        'deadline', 'due', 'termijn', 'uiterlijk', 'bezwaar', 'objection',
        'beroep', 'appeal', 'submit', 'indienen', 'aanleveren', 'hearing',
        'zitting', 'court date', 'rechtbank'
    )
    return any(term in lowered for term in strong_terms) or ' by ' in lowered


def _open_loop_title_from_context(context):
    lowered = (context or '').lower()
    if any(term in lowered for term in ('objection', 'bezwaar')):
        return 'Decide objection response'
    if any(term in lowered for term in ('submit', 'indienen', 'aanleveren')):
        return 'Prepare required submission'
    if any(term in lowered for term in ('deadline', 'termijn', 'due')):
        return 'Confirm deadline action'
    if any(term in lowered for term in ('failure', 'risk', 'waive', 'vervallen')):
        return 'Assess legal risk signal'
    return 'Review extracted obligation'


def _obligation_title_from_context(context):
    lowered = (context or '').lower()
    if any(term in lowered for term in ('pay', 'payment', 'betaling', 'betalen', 'factuur', 'invoice')):
        return 'Review payment obligation'
    if any(term in lowered for term in ('submit', 'provide', 'indienen', 'aanleveren', 'verstrekken')):
        return 'Review submission obligation'
    if any(term in lowered for term in ('respond', 'reply', 'reageren', 'antwoord')):
        return 'Review response obligation'
    if any(term in lowered for term in ('repair', 'herstel', 'repareren')):
        return 'Review repair obligation'
    return 'Review extracted obligation'


def _obligation_responsible_party(case_id, context):
    lowered = f" {(context or '').lower()} "
    robert_markers = (
        ' robert must ', ' robert shall ', ' robert moet ', ' robert dient ',
        ' you must ', ' you shall ', ' you are required ', ' u moet ', ' u dient ',
    )
    if any(marker in lowered for marker in robert_markers):
        return 'Robert'

    case = legal_ledger.get_case(case_id) or {}
    named_matches = [
        party.get('name')
        for party in case.get('parties') or []
        if party.get('name') and party.get('name').lower() in lowered
    ]
    unique_matches = list(dict.fromkeys(named_matches))
    return unique_matches[0] if len(unique_matches) == 1 else 'unassigned'


def _obligation_due_date(context, facts):
    context_lower = (context or '').lower()
    context_words = set(re.findall(r'\b[a-zA-Z][a-zA-Z]{3,}\b', context_lower))
    candidates = []
    for item in (facts.get('dates') or []):
        normalized = str(item.get('normalized') or item.get('raw') or '').strip()
        raw = str(item.get('raw') or '').strip()
        date_context = str(item.get('context') or '').strip()
        if not normalized:
            continue
        token = raw if raw and raw.lower() in context_lower else normalized
        position = context_lower.find(token.lower())
        marker_score = 0
        if position >= 0:
            prefix = context_lower[max(0, position - 48):position]
            if re.search(r'(?:\bby|\bbefore|\bno later than|\buiterlijk|\bvo{1,2}r)\s+(?:on\s+)?$', prefix):
                marker_score = 4
            elif re.search(r'(?:\bdeadline|\bdue|\btermijn|\bvervaldatum)\D{0,24}$', prefix):
                marker_score = 3
        date_words = set(re.findall(r'\b[a-zA-Z][a-zA-Z]{3,}\b', date_context.lower()))
        union = context_words | date_words
        overlap = len(context_words & date_words) / len(union) if union else 0.0
        candidates.append((normalized, marker_score, overlap))

    if not candidates:
        return ''
    marked = sorted((item for item in candidates if item[1]), key=lambda item: (-item[1], -item[2], item[0]))
    if marked:
        return marked[0][0]
    unique_dates = list(dict.fromkeys(item[0] for item in candidates))
    if len(unique_dates) == 1 and max(item[2] for item in candidates) >= 0.35:
        return unique_dates[0]
    return ''


def _context_looks_like_claim(context):
    lowered = f" {(context or '').lower()} "
    claim_terms = (
        'stated', 'states', 'claim', 'claimed', 'alleges', 'alleged',
        'contends', 'decision', 'decided', 'refused', 'approved', 'denied',
        'must', 'should', 'owes', 'liable', 'responsible', 'dispute',
        'objected', 'bezwaar', 'besluit', 'vordering', 'factuur', 'betaling',
        'euro', 'eur', 'deadline', 'termijn', 'not', 'failed'
    )
    return any(term in lowered for term in claim_terms)


def _claim_suggestions_from_analysis(case_id, document, analysis, actor):
    source_confidence = _source_confidence_from_analysis(analysis)
    document_label = document.get('title') or document.get('original_filename') or f"document {document['document_id']}"
    suggestions = []
    evidence_links = []
    seen = set()

    candidate_sentences = []
    candidate_sentences.extend(analysis.get('key_sentences') or [])
    candidate_sentences.extend((analysis.get('facts') or {}).get('obligations') or [])
    for item in (analysis.get('facts') or {}).get('monetary_amounts') or []:
        candidate_sentences.append(item.get('context') or item.get('raw') or '')

    for raw_context in candidate_sentences:
        context = _context_preview(raw_context, 320)
        if not context or not _context_looks_like_claim(context):
            continue
        key = context.lower()
        if key in seen:
            continue
        seen.add(key)
        claim = legal_ledger.add_claim(case_id, {
            'asserted_by': 'document_intelligence',
            'position_role': 'source',
            'claim_type': 'document_statement',
            'statement': f"From {document_label}: {context}",
            'status': 'needs_review',
            'confidence': source_confidence,
        }, actor=actor)
        if not claim:
            continue
        suggestions.append(claim)
        link = _add_analysis_evidence_link(
            case_id,
            document,
            'claim',
            claim['id'],
            context,
            'suggests_claim',
            source_confidence,
            actor,
        )
        if link:
            evidence_links.append(link)
        if len(suggestions) >= 5:
            break

    return {
        'claim_suggestions': suggestions,
        'evidence_links': evidence_links,
    }


def _normalize_money_value(raw):
    digits = re.sub(r'[^0-9,.\-]', '', str(raw or ''))
    if not digits:
        return ''
    if ',' in digits and '.' in digits:
        digits = digits.replace('.', '').replace(',', '.')
    else:
        digits = digits.replace(',', '.')
    try:
        return f"{float(digits):.2f}"
    except ValueError:
        return digits


def _review_context_key(context, kind):
    lowered = f" {(context or '').lower()} "
    if any(term in lowered for term in ('bezwaar', 'objection')):
        return f"{kind}:objection"
    if any(term in lowered for term in ('beroep', 'appeal')):
        return f"{kind}:appeal"
    if any(term in lowered for term in ('deadline', 'termijn', 'uiterlijk', 'due')):
        return f"{kind}:deadline"
    if any(term in lowered for term in ('factuur', 'invoice', 'payment', 'betaling', 'pay ', 'paid', 'euro', 'eur')):
        return f"{kind}:payment"
    if any(term in lowered for term in ('besluit', 'decision', 'decided')):
        return f"{kind}:decision"
    if any(term in lowered for term in ('zitting', 'hearing', 'court date', 'rechtbank')):
        return f"{kind}:hearing"

    words = re.findall(r'\b[a-zA-Z][a-zA-Z]{3,}\b', lowered)
    stop_words = {
        'dated', 'date', 'from', 'with', 'that', 'this', 'voor', 'naar',
        'door', 'heeft', 'wordt', 'moet', 'must', 'shall', 'will'
    }
    signal = [word for word in words if word not in stop_words]
    return f"{kind}:{'-'.join(signal[:4])}" if signal else f"{kind}:general"


def _previous_document_analyses(case_id, current_document_id):
    records = []
    for doc in legal_ledger.list_documents(case_id):
        if doc.get('document_id') == current_document_id:
            continue
        analysis = ((doc.get('metadata') or {}).get('legal_analysis') or {})
        if not analysis:
            continue
        records.append({
            'document': doc,
            'analysis': analysis,
            'label': doc.get('title') or doc.get('original_filename') or f"document {doc.get('document_id')}",
        })
    return records


def _source_ref_for_review(document, label, context, **extra):
    payload = {
        'document_id': document.get('document_id'),
        'title': label,
        'snippet': _context_preview(context, 260),
    }
    payload.update({key: value for key, value in extra.items() if value not in (None, '')})
    return payload


def _existing_contradiction_keys(case_id):
    keys = set()
    for item in legal_ledger.list_contradictions(case_id):
        refs = item.get('source_refs') or []
        review_keys = sorted(ref.get('review_key') for ref in refs if ref.get('review_key'))
        if review_keys:
            keys.add(tuple(review_keys))
    return keys


def _contradiction_suggestions_from_analysis(case_id, document, analysis, actor):
    source_confidence = _source_confidence_from_analysis(analysis)
    document_label = document.get('title') or document.get('original_filename') or f"document {document['document_id']}"
    suggestions = []
    evidence_links = []
    existing = _existing_contradiction_keys(case_id)
    previous_docs = _previous_document_analyses(case_id, document.get('document_id'))

    current_dates = []
    for item in (analysis.get('facts') or {}).get('dates') or []:
        context = item.get('context') or ''
        normalized = item.get('normalized') or item.get('raw')
        if not context or not normalized:
            continue
        key = _review_context_key(context, 'date')
        current_dates.append((key, normalized, context))

    current_amounts = []
    for item in (analysis.get('facts') or {}).get('monetary_amounts') or []:
        context = item.get('context') or item.get('raw') or ''
        value = _normalize_money_value(item.get('raw'))
        if not context or not value:
            continue
        key = _review_context_key(context, 'amount')
        current_amounts.append((key, value, context, item.get('raw')))

    for previous in previous_docs:
        previous_doc = previous['document']
        previous_label = previous['label']
        previous_facts = previous['analysis'].get('facts') or {}

        for key, current_date, current_context in current_dates:
            for previous_item in previous_facts.get('dates') or []:
                previous_context = previous_item.get('context') or ''
                previous_date = previous_item.get('normalized') or previous_item.get('raw')
                if not previous_context or not previous_date:
                    continue
                if key != _review_context_key(previous_context, 'date') or current_date == previous_date:
                    continue
                review_key = tuple(sorted((
                    f"date:{key}:doc:{document.get('document_id')}:{current_date}",
                    f"date:{key}:doc:{previous_doc.get('document_id')}:{previous_date}",
                )))
                if review_key in existing:
                    continue
                refs = [
                    _source_ref_for_review(document, document_label, current_context, date=current_date, review_key=review_key[0]),
                    _source_ref_for_review(previous_doc, previous_label, previous_context, date=previous_date, review_key=review_key[1]),
                ]
                contradiction = legal_ledger.add_contradiction(case_id, {
                    'contradiction_type': 'date_conflict',
                    'title': 'Conflicting dates need review',
                    'description': f"{document_label} says {current_date}; {previous_label} says {previous_date}. Review the source snippets before confirming either date.",
                    'status': 'needs_review',
                    'severity': 'high' if 'deadline' in key or 'objection' in key else 'medium',
                    'source_refs': refs,
                }, actor=actor)
                if not contradiction:
                    continue
                suggestions.append(contradiction)
                existing.add(review_key)
                for source_doc, context in ((document, current_context), (previous_doc, previous_context)):
                    link = _add_analysis_evidence_link(
                        case_id,
                        source_doc,
                        'contradiction',
                        contradiction['id'],
                        context,
                        'conflicts_with',
                        source_confidence,
                        actor,
                    )
                    if link:
                        evidence_links.append(link)
                break

        for key, current_value, current_context, current_raw in current_amounts:
            for previous_item in previous_facts.get('monetary_amounts') or []:
                previous_context = previous_item.get('context') or previous_item.get('raw') or ''
                previous_value = _normalize_money_value(previous_item.get('raw'))
                if not previous_context or not previous_value:
                    continue
                if key != _review_context_key(previous_context, 'amount') or current_value == previous_value:
                    continue
                review_key = tuple(sorted((
                    f"amount:{key}:doc:{document.get('document_id')}:{current_value}",
                    f"amount:{key}:doc:{previous_doc.get('document_id')}:{previous_value}",
                )))
                if review_key in existing:
                    continue
                refs = [
                    _source_ref_for_review(document, document_label, current_context, amount=current_raw or current_value, review_key=review_key[0]),
                    _source_ref_for_review(previous_doc, previous_label, previous_context, amount=previous_item.get('raw') or previous_value, review_key=review_key[1]),
                ]
                contradiction = legal_ledger.add_contradiction(case_id, {
                    'contradiction_type': 'amount_conflict',
                    'title': 'Conflicting monetary amounts need review',
                    'description': f"{document_label} references {current_raw or current_value}; {previous_label} references {previous_item.get('raw') or previous_value}. Review before using either amount as fact.",
                    'status': 'needs_review',
                    'severity': 'medium',
                    'source_refs': refs,
                }, actor=actor)
                if not contradiction:
                    continue
                suggestions.append(contradiction)
                existing.add(review_key)
                for source_doc, context in ((document, current_context), (previous_doc, previous_context)):
                    link = _add_analysis_evidence_link(
                        case_id,
                        source_doc,
                        'contradiction',
                        contradiction['id'],
                        context,
                        'conflicts_with',
                        source_confidence,
                        actor,
                    )
                    if link:
                        evidence_links.append(link)
                break

        if len(suggestions) >= 6:
            break

    return {
        'contradiction_suggestions': suggestions,
        'evidence_links': evidence_links,
    }


def _missing_evidence_suggestions_from_analysis(case_id, document, analysis, actor):
    document_label = document.get('title') or document.get('original_filename') or f"document {document['document_id']}"
    source_confidence = _source_confidence_from_analysis(analysis)
    missing_terms = (
        'missing proof', 'missing evidence', 'ontbreekt', 'geen bewijs',
        'zonder bewijs', 'proof of payment', 'betalingsbewijs', 'receipt',
        'bon', 'bank statement', 'bankafschrift', 'not provided', 'not supplied'
    )
    candidates = []
    candidates.extend(analysis.get('key_sentences') or [])
    candidates.extend((analysis.get('facts') or {}).get('obligations') or [])
    candidates.extend((risk.get('context') or '') for risk in (analysis.get('risks') or []))

    suggestions = []
    evidence_links = []
    seen = set()
    for raw_context in candidates:
        context = _context_preview(raw_context, 300)
        lowered = context.lower()
        if not context or not any(term in lowered for term in missing_terms):
            continue
        key = lowered
        if key in seen:
            continue
        seen.add(key)
        warning = legal_ledger.add_missing_evidence_warning(case_id, {
            'document_id': document['document_id'],
            'warning_type': 'document_requested_evidence',
            'title': 'Document points to missing evidence',
            'description': f"Extracted from {document_label}: {context}",
            'suggested_action': 'Find or upload the referenced proof, or mark this as unavailable before relying on the related claim.',
            'status': 'needs_review',
            'severity': 'high' if any(term in lowered for term in ('deadline', 'termijn', 'court', 'rechtbank')) else 'medium',
        }, actor=actor)
        if not warning:
            continue
        suggestions.append(warning)
        link = _add_analysis_evidence_link(
            case_id,
            document,
            'missing_evidence',
            warning['id'],
            context,
            'indicates_gap',
            source_confidence,
            actor,
        )
        if link:
            evidence_links.append(link)
        if len(suggestions) >= 5:
            break

    return {
        'missing_evidence_suggestions': suggestions,
        'evidence_links': evidence_links,
    }


def _add_analysis_evidence_link(case_id, document, target_type, target_id, context, relationship, source_confidence, actor):
    if not target_id:
        return None
    try:
        return legal_ledger.add_evidence_link(case_id, {
            'document_id': document['document_id'],
            'target_type': target_type,
            'target_id': target_id,
            'snippet': _context_preview(context, 320),
            'relationship': relationship,
            'strength': 'medium',
            'source_confidence': source_confidence,
            'user_confirmed': False,
        }, actor=actor)
    except (KeyError, ValueError):
        return None


def _review_items_from_analysis(case_id, document, analysis, actor):
    facts = analysis.get('facts') or {}
    deadlines = []
    obligations = []
    open_loops = []
    evidence_links = []
    seen_deadlines = set()
    seen_loops = set()
    document_label = document.get('title') or document.get('original_filename') or f"document {document['document_id']}"
    source_confidence = _source_confidence_from_analysis(analysis)

    for item in (facts.get('dates') or [])[:20]:
        context = item.get('context') or ''
        due_date = item.get('normalized') or item.get('raw')
        key = (due_date, context.lower()[:120])
        if not due_date or key in seen_deadlines or not _context_looks_like_deadline(context):
            continue
        seen_deadlines.add(key)
        deadline = legal_ledger.add_deadline(case_id, {
            'due_date': due_date,
            'title': _deadline_title_from_context(context),
            'description': f"Extracted from {document_label}: {_context_preview(context, 260)}",
            'deadline_type': 'extracted_from_document',
            'status': 'needs_review',
            'source_document_id': document['document_id'],
            'requires_approval': True,
        }, actor=actor)
        if deadline:
            deadlines.append(deadline)
            link = _add_analysis_evidence_link(
                case_id,
                document,
                'deadline',
                deadline['id'],
                context,
                'suggests_deadline',
                source_confidence,
                actor,
            )
            if link:
                evidence_links.append(link)

    existing_obligation_keys = {
        (item.get('source_document_id'), (item.get('source_quote') or '').lower())
        for item in legal_ledger.list_obligations(case_id)
    }
    for raw_context in (facts.get('obligations') or [])[:10]:
        context = _context_preview(raw_context, 320)
        if not context:
            continue
        key = (document['document_id'], context.lower())
        if key in existing_obligation_keys:
            continue
        lowered = context.lower()
        risk_level = 'high' if any(term in lowered for term in ('deadline', 'termijn', 'failure', 'waive', 'urgent', 'spoed', 'court', 'rechtbank')) else 'medium'
        item = legal_ledger.add_obligation(case_id, {
            'title': _obligation_title_from_context(context),
            'description': f"Extracted from {document_label}: {context}",
            'responsible_party': _obligation_responsible_party(case_id, context),
            'obligation_type': 'extracted_from_document',
            'due_date': _obligation_due_date(context, facts),
            'status': 'needs_review',
            'risk_level': risk_level,
            'source_document_id': document['document_id'],
            'source_quote': context,
            'source_confidence': source_confidence,
            'user_confirmed': False,
        }, actor=actor)
        if not item:
            continue
        obligations.append(item)
        existing_obligation_keys.add(key)
        link = _add_analysis_evidence_link(
            case_id,
            document,
            'obligation',
            item['id'],
            context,
            'states_obligation',
            source_confidence,
            actor,
        )
        if link:
            evidence_links.append(link)

    loop_sources = []
    loop_sources.extend(facts.get('obligations') or [])
    loop_sources.extend((risk.get('context') or '') for risk in (analysis.get('risks') or []))
    for context in loop_sources[:10]:
        context = _context_preview(context, 260)
        if not context:
            continue
        key = context.lower()
        if key in seen_loops:
            continue
        seen_loops.add(key)
        lowered = context.lower()
        risk_level = 'high' if any(term in lowered for term in ('deadline', 'termijn', 'failure', 'waive', 'urgent', 'spoed')) else 'medium'
        item = legal_ledger.add_open_loop(case_id, {
            'title': _open_loop_title_from_context(context),
            'description': f"Extracted from {document_label}: {context}",
            'owner': 'robert',
            'status': 'open',
            'next_action': f"Review, confirm, and assign the action implied by: {context}",
            'risk_level': risk_level,
        }, actor=actor)
        if item:
            open_loops.append(item)
            link = _add_analysis_evidence_link(
                case_id,
                document,
                'open_loop',
                item['id'],
                context,
                'suggests_action',
                source_confidence,
                actor,
            )
            if link:
                evidence_links.append(link)

    return {
        'deadline_suggestions': deadlines,
        'obligation_suggestions': obligations,
        'open_loop_suggestions': open_loops,
        'evidence_links': evidence_links,
    }


def _enabled_flag(options, key, default=True):
    value = (options or {}).get(key, default)
    if isinstance(value, bool):
        return value
    return str(value).lower() not in {'0', 'false', 'no', 'off'}


def _analysis_artifacts_for_document(case_id, document, analysis, actor, options=None):
    suggested_events = []
    if _enabled_flag(options, 'create_timeline_suggestions', True):
        suggested_events = _timeline_suggestions_from_analysis(case_id, document, analysis, actor)

    review_items = {'deadline_suggestions': [], 'obligation_suggestions': [], 'open_loop_suggestions': []}
    if _enabled_flag(options, 'create_review_items', True):
        review_items = _review_items_from_analysis(case_id, document, analysis, actor)

    claim_items = {'claim_suggestions': [], 'evidence_links': []}
    if _enabled_flag(options, 'create_claim_suggestions', True):
        claim_items = _claim_suggestions_from_analysis(case_id, document, analysis, actor)

    contradiction_items = {'contradiction_suggestions': [], 'evidence_links': []}
    missing_items = {'missing_evidence_suggestions': [], 'evidence_links': []}
    if _enabled_flag(options, 'create_gap_suggestions', True):
        contradiction_items = _contradiction_suggestions_from_analysis(case_id, document, analysis, actor)
        missing_items = _missing_evidence_suggestions_from_analysis(case_id, document, analysis, actor)

    created_target_keys = {
        *{('event', item['id']) for item in suggested_events if item.get('id')},
        *{('deadline', item['id']) for item in review_items.get('deadline_suggestions', []) if item.get('id')},
        *{('obligation', item['id']) for item in review_items.get('obligation_suggestions', []) if item.get('id')},
        *{('open_loop', item['id']) for item in review_items.get('open_loop_suggestions', []) if item.get('id')},
        *{('claim', item['id']) for item in claim_items.get('claim_suggestions', []) if item.get('id')},
        *{('contradiction', item['id']) for item in contradiction_items.get('contradiction_suggestions', []) if item.get('id')},
        *{('missing_evidence', item['id']) for item in missing_items.get('missing_evidence_suggestions', []) if item.get('id')},
    }
    evidence_links = [
        link for link in legal_ledger.list_evidence_links(case_id)
        if link.get('document_id') == document.get('document_id')
        and (link.get('target_type'), link.get('target_id')) in created_target_keys
    ]

    return {
        'timeline_suggestions': suggested_events,
        **review_items,
        'claim_suggestions': claim_items.get('claim_suggestions', []),
        'contradiction_suggestions': contradiction_items.get('contradiction_suggestions', []),
        'missing_evidence_suggestions': missing_items.get('missing_evidence_suggestions', []),
        'evidence_links': evidence_links,
        'evidence_links_created': len(evidence_links),
    }


def _source_record_text(record):
    text = (
        record.get('extracted_text')
        or record.get('ocr_text')
        or record.get('content')
        or record.get('plain_text')
        or record.get('body')
        or record.get('snippet')
        or ''
    )
    if text:
        return document_intelligence.extract_text_from_document({'content': text})
    return document_intelligence.extract_text_from_document(record)


def _source_record_uri(source_type, source_id, record):
    explicit = (
        record.get('source_uri')
        or record.get('source_url')
        or record.get('web_view_link')
        or record.get('document_url')
        or record.get('url')
        or ''
    )
    if explicit:
        return explicit
    normalized = str(source_type or '').lower()
    if source_id:
        if normalized in {'gmail', 'google_mail'}:
            return f"gmail://message/{source_id}"
        if normalized in {'gdrive', 'google_drive', 'drive'}:
            return f"gdrive://file/{source_id}"
        if normalized == 'outlook':
            return f"outlook://message/{source_id}"
        if normalized == 'onedrive':
            return f"onedrive://file/{source_id}"
    return ''


def _source_record_title(record):
    return (
        record.get('title')
        or record.get('subject')
        or record.get('document_name')
        or record.get('name')
        or record.get('original_filename')
        or 'Imported source document'
    )


def _persist_imported_source_document(case_id, record, source_type, meta_tag, actor, options):
    title = _source_record_title(record)
    source_id = record.get('source_id') or record.get('id') or record.get('message_id') or record.get('file_id')
    source_uri = _source_record_uri(record.get('source_type') or record.get('source') or source_type, source_id, record)
    extracted_text = _source_record_text(record)
    analysis = document_intelligence.analyze_text(
        extracted_text,
        document_name=title,
        metadata={
            **(record.get('metadata') or {}),
            'source_type': record.get('source_type') or record.get('source') or source_type,
            'source_id': source_id,
            'source_uri': source_uri,
            'meta_tag': meta_tag,
            'document_type': record.get('document_type') or record.get('mime_type') or record.get('type') or 'imported_source',
            'sender': record.get('sender') or record.get('from') or '',
            'recipient': record.get('recipient') or record.get('to') or '',
        },
        case_context=legal_ledger.get_case(case_id),
    )
    document = legal_ledger.add_document(case_id, {
        'source_type': record.get('source_type') or record.get('source') or source_type or 'external_source',
        'source_uri': source_uri,
        'original_filename': record.get('original_filename') or record.get('filename') or title,
        'document_type': analysis.get('document_type') or record.get('document_type') or record.get('mime_type') or 'imported_source',
        'date_on_document': record.get('date_on_document') or record.get('date') or record.get('internal_date') or '',
        'sender': record.get('sender') or record.get('from') or '',
        'recipient': record.get('recipient') or record.get('to') or '',
        'title': title,
        'extracted_text': extracted_text,
        'summary': analysis.get('summary') or '',
        'relevance_score': (analysis.get('evidence') or {}).get('relevance_score', 0),
        'confidentiality_level': record.get('confidentiality_level') or options.get('confidentiality_level') or 'normal',
        'metadata': {
            **(record.get('metadata') or {}),
            'legal_analysis': analysis,
            'import_mode': 'source_batch_import',
            'meta_tag': meta_tag,
            'source_record_id': source_id,
            'source_record_labels': record.get('labels') or record.get('tags') or [],
        },
        'extraction_method': f"source_batch_import_{source_type or record.get('source_type') or 'unknown'}",
    }, actor=actor)
    if not document:
        return None
    return {
        'document': document,
        'analysis': analysis,
        **_analysis_artifacts_for_document(case_id, document, analysis, actor, options),
    }


def _import_source_records(case_id, data, records, *, source_type, meta_tag, actor):
    """Persist source records once, with stable source-URI deduplication."""
    existing_source_uris = {
        item.get('source_uri')
        for item in legal_ledger.list_documents(case_id)
        if item.get('source_uri')
    }
    imported = []
    skipped = []
    artifact_counts = {
        'timeline_suggestions': 0,
        'deadline_suggestions': 0,
        'obligation_suggestions': 0,
        'open_loop_suggestions': 0,
        'claim_suggestions': 0,
        'contradiction_suggestions': 0,
        'missing_evidence_suggestions': 0,
        'evidence_links': 0,
    }

    for index, record in enumerate(records):
        if not isinstance(record, dict):
            skipped.append({'index': index, 'reason': 'record_must_be_object'})
            continue
        source_id = record.get('source_id') or record.get('id') or record.get('message_id') or record.get('file_id')
        normalized_source_type = record.get('source_type') or record.get('source') or source_type
        source_uri = _source_record_uri(normalized_source_type, source_id, record)
        if source_uri and source_uri in existing_source_uris:
            skipped.append({'index': index, 'source_uri': source_uri, 'reason': 'duplicate_source_uri'})
            continue

        result = _persist_imported_source_document(case_id, record, normalized_source_type, meta_tag, actor, data)
        if not result:
            skipped.append({'index': index, 'source_uri': source_uri, 'reason': 'not_persisted'})
            continue

        document = result['document']
        if document.get('source_uri'):
            existing_source_uris.add(document['source_uri'])
        imported.append(result)
        for key in artifact_counts:
            value = result.get(key)
            artifact_counts[key] += len(value) if isinstance(value, list) else int(value or 0)

    db_manager.invalidate_cache('documents')
    return {
        'case_id': case_id,
        'source_type': source_type,
        'meta_tag': meta_tag,
        'imported_count': len(imported),
        'skipped_count': len(skipped),
        'imported_documents': imported,
        'skipped_documents': skipped,
        'artifact_counts': artifact_counts,
        'comprehension': legal_ledger.case_comprehension_dossier(case_id),
    }


def _google_record_word_count(record):
    """Count only text received from Google; the number is progress evidence, not an estimate."""
    text = " ".join(str(record.get(key) or "") for key in (
        'content', 'plain_text', 'extracted_text', 'ocr_text', 'body', 'description',
    ))
    return len(re.findall(r"\S+", text))


def _merge_import_artifacts(target, source):
    for key in target:
        target[key] += int((source or {}).get(key) or 0)


def _run_google_pull_job(job_id, case_id, job_data, actor):
    """Run a read-only Google pull with durable, inspectable local progress."""
    source = str(job_data.get('source') or 'gmail').strip().lower()
    query = str(job_data.get('query') or '').strip()
    max_items = int(job_data.get('max_items') or 50)
    days_back = job_data.get('days_back')
    sort_order = str(job_data.get('sort_order') or 'newest').strip().lower()
    import_data = {
        'confidentiality_level': job_data.get('confidentiality_level') or 'normal',
        'source': source,
        'query': query,
        'meta_tag': query,
    }
    artifacts = {
        'timeline_suggestions': 0,
        'deadline_suggestions': 0,
        'obligation_suggestions': 0,
        'open_loop_suggestions': 0,
        'claim_suggestions': 0,
        'contradiction_suggestions': 0,
        'missing_evidence_suggestions': 0,
        'evidence_links': 0,
    }
    imported_documents = []
    skipped_documents = []
    try:
        legal_ledger.update_evidence_import_job(case_id, job_id, {
            'status': 'running',
            'stage': f'Searching {"Gmail" if source == "gmail" else "Google Drive"}',
        }, actor=actor)
        token_response = google_token_store.load(actor, 'google')
        if not token_response:
            raise GoogleEvidenceError('Google is not connected for this local LARO account')
        config = google_oauth_config()
        if not config['configured']:
            raise GoogleEvidenceError('Google OAuth is not configured on this local LARO installation')
        connector = GoogleEvidenceConnector(
            token_response,
            client_id=config['client_id'],
            client_secret=config['client_secret'],
            scopes=GOOGLE_SCOPES,
        )
        records, refreshed_token = connector.fetch(
            source,
            query,
            max_items,
            days_back=days_back,
            sort_order=sort_order,
        )
        if refreshed_token:
            google_token_store.save(actor, 'google', refreshed_token)

        records = list(records or [])
        total_words = sum(_google_record_word_count(record) for record in records if isinstance(record, dict))
        estimated_seconds = max(3, min(900, len(records) * 2 + ((total_words + 159) // 160)))
        legal_ledger.update_evidence_import_job(case_id, job_id, {
            'stage': f'Found {len(records)} source item{"s" if len(records) != 1 else ""}; reading locally',
            'total_items': len(records),
            'total_words': total_words,
            'estimated_total_seconds': estimated_seconds,
        }, actor=actor)

        for index, record in enumerate(records):
            if not isinstance(record, dict):
                skipped_documents.append({'index': index, 'reason': 'record_must_be_object'})
                legal_ledger.update_evidence_import_job(case_id, job_id, {
                    'stage': f'Skipped invalid source item {index + 1} of {len(records)}',
                    'completed_items': index + 1,
                    'skipped_count': len(skipped_documents),
                }, actor=actor)
                continue
            title = str(record.get('title') or record.get('original_filename') or f'Source item {index + 1}')
            legal_ledger.update_evidence_import_job(case_id, job_id, {
                'stage': f'Reading source item {index + 1} of {len(records)}',
                'current_item': title[:255],
            }, actor=actor)
            partial = _import_source_records(
                case_id,
                import_data,
                [record],
                source_type='google',
                meta_tag=query,
                actor=actor,
            )
            imported_documents.extend(partial.get('imported_documents') or [])
            skipped_documents.extend(partial.get('skipped_documents') or [])
            _merge_import_artifacts(artifacts, partial.get('artifact_counts') or {})
            legal_ledger.update_evidence_import_job(case_id, job_id, {
                'stage': f'Analysed source item {index + 1} of {len(records)}',
                'completed_items': index + 1,
                'processed_words': min(total_words, sum(_google_record_word_count(item) for item in records[:index + 1] if isinstance(item, dict))),
                'imported_count': len(imported_documents),
                'skipped_count': len(skipped_documents),
                'current_item': title[:255],
            }, actor=actor)

        result = {
            'case_id': case_id,
            'source_type': 'google',
            'meta_tag': query,
            'imported_count': len(imported_documents),
            'skipped_count': len(skipped_documents),
            'artifact_counts': artifacts,
            'connector': {
                'provider': 'google',
                'source': source,
                'mode': 'read_only',
                'credentials_refreshed': bool(refreshed_token),
            },
        }
        legal_ledger.record_case_activity(
            case_id,
            'google_sources_pulled',
            actor=actor,
            source='google_readonly_connector',
            details={
                'source': source,
                'query': query,
                'days_back': days_back,
                'sort_order': sort_order,
                'fetched_count': len(records),
                'imported_count': result['imported_count'],
                'skipped_count': result['skipped_count'],
                'credentials_refreshed': bool(refreshed_token),
                'job_id': job_id,
            },
            risk_level='medium',
        )
        legal_ledger.update_evidence_import_job(case_id, job_id, {
            'status': 'completed',
            'stage': 'Evidence imported and case ledger refreshed',
            'completed_items': len(records),
            'processed_words': total_words,
            'imported_count': result['imported_count'],
            'skipped_count': result['skipped_count'],
            'result': result,
        }, actor=actor)
    except (GoogleEvidenceError, TokenStoreError, ValueError) as exc:
        legal_ledger.update_evidence_import_job(case_id, job_id, {
            'status': 'failed',
            'stage': 'Google evidence import needs attention',
            'error': str(exc),
            'imported_count': len(imported_documents),
            'skipped_count': len(skipped_documents),
        }, actor=actor)
    except Exception:
        logger.exception('Google evidence import job failed')
        legal_ledger.update_evidence_import_job(case_id, job_id, {
            'status': 'failed',
            'stage': 'Google evidence import failed unexpectedly',
            'error': 'Local Google evidence import failed unexpectedly. Review the connection and try again.',
            'imported_count': len(imported_documents),
            'skipped_count': len(skipped_documents),
        }, actor=actor)


def _readable_case_analysis_documents(case_id):
    return [
        item for item in legal_ledger.list_documents(case_id)
        if str(item.get('extracted_text') or item.get('ocr_text') or '').strip()
    ]


def _case_analysis_workload(documents):
    source_texts = [str(item.get('extracted_text') or item.get('ocr_text') or '') for item in documents]
    total_words = sum(len(re.findall(r'\S+', text)) for text in source_texts)
    total_characters = sum(len(re.sub(r'\s+', ' ', text).strip()) for text in source_texts)
    provider = document_intelligence.semantic_provider.provider
    if provider == 'ollama':
        estimated_seconds = max(8, min(43200, int(total_words / 90) + (len(documents) * 3)))
    else:
        estimated_seconds = max(2, min(900, int(total_words / 10000) + len(documents)))
    return {
        'provider': provider,
        'model': document_intelligence.semantic_provider.model,
        'total_documents': len(documents),
        'total_words': total_words,
        'total_characters': total_characters,
        'estimated_total_seconds': estimated_seconds,
    }


def _persist_case_analysis_run(case_id, analysis, actor):
    return legal_ledger.create_case_analysis_run(case_id, {
        'analysis_type': 'cross_document',
        'status': analysis.get('status') or 'needs_review',
        'provider': analysis.get('provider') or 'rule_based',
        'model': analysis.get('model') or '',
        'content': analysis,
        'source_documents': analysis.get('source_documents') or [],
    }, actor=actor)


def _run_case_analysis_job(job_id, case_id, actor):
    """Run an inspectable full-source analysis without keeping a request open."""
    try:
        ledger_case = legal_ledger.get_case(case_id)
        if not ledger_case:
            raise ValueError('Case not found')
        documents = _readable_case_analysis_documents(case_id)
        if not documents:
            raise ValueError('No readable source documents are available. Recover source text before running a case-wide analysis.')
        workload = _case_analysis_workload(documents)
        legal_ledger.update_case_analysis_job(case_id, job_id, {
            **workload,
            'status': 'running',
            'stage': 'Preparing every readable source for local analysis',
        }, actor=actor)

        def record_progress(progress):
            total_chunks = max(0, int(progress.get('total_chunks') or 0))
            total_words = max(0, int(progress.get('total_words') or workload['total_words']))
            estimated_seconds = workload['estimated_total_seconds']
            if workload['provider'] == 'ollama' and total_chunks:
                estimated_seconds = max(8, min(43200, total_chunks * max(5, int(total_words / max(1, total_chunks * 90)) + 3)))
            legal_ledger.update_case_analysis_job(case_id, job_id, {
                'status': 'running',
                'stage': str(progress.get('stage') or 'Reading local source batches')[:255],
                'current_item': str(progress.get('current_item') or '')[:255],
                'total_documents': max(0, int(progress.get('total_documents') or workload['total_documents'])),
                'completed_documents': max(0, int(progress.get('completed_documents') or 0)),
                'total_chunks': total_chunks,
                'completed_chunks': max(0, int(progress.get('completed_chunks') or 0)),
                'total_words': total_words,
                'processed_words': max(0, int(progress.get('processed_words') or 0)),
                'total_characters': max(0, int(progress.get('total_characters') or workload['total_characters'])),
                'processed_characters': max(0, int(progress.get('processed_characters') or 0)),
                'estimated_total_seconds': estimated_seconds,
            }, actor=actor)

        analysis = document_intelligence.semantic_provider.analyze_case(
            documents,
            ledger_case,
            progress_callback=record_progress,
        )
        if analysis.get('status') != 'completed':
            raise ValueError((analysis.get('limitations') or ['Case-wide local analysis is not available.'])[0])
        run = _persist_case_analysis_run(case_id, analysis, actor)
        if not run:
            raise ValueError('Case not found')
        coverage = analysis.get('source_coverage') or {}
        result = {
            'run_id': run['id'],
            'findings_count': len((analysis.get('findings') or [])),
            'review_questions_count': len((analysis.get('review_questions') or [])),
            'timeline_suggestions_count': len((analysis.get('timeline_suggestions') or [])),
            'source_coverage': coverage,
            'requires_human_review': True,
            'source_preserved': True,
        }
        legal_ledger.update_case_analysis_job(case_id, job_id, {
            'status': 'completed',
            'stage': 'Full-source reading stored for cited review',
            'current_item': '',
            'completed_documents': workload['total_documents'],
            'completed_chunks': int(coverage.get('chunks_total') or analysis.get('analysis_batches') or workload['total_documents']),
            'total_chunks': int(coverage.get('chunks_total') or analysis.get('analysis_batches') or workload['total_documents']),
            'processed_words': workload['total_words'],
            'processed_characters': workload['total_characters'],
            'run_id': run['id'],
            'result': result,
        }, actor=actor)
        legal_ledger.record_case_activity(
            case_id,
            'full_source_case_analysis_completed',
            actor=actor,
            source='local_case_analysis_job',
            details={
                'job_id': job_id,
                'run_id': run['id'],
                'provider': analysis.get('provider') or 'rule_based',
                'model': analysis.get('model') or '',
                'source_documents': int(coverage.get('sources_readable') or workload['total_documents']),
                'coverage_percent': coverage.get('coverage_percent'),
                'analysis_batches': analysis.get('analysis_batches'),
            },
            risk_level='low',
        )
    except ValueError as exc:
        legal_ledger.update_case_analysis_job(case_id, job_id, {
            'status': 'failed',
            'stage': 'Full-source analysis needs attention',
            'error': str(exc),
        }, actor=actor)
    except Exception:
        logger.exception('Full-source case analysis job failed')
        legal_ledger.update_case_analysis_job(case_id, job_id, {
            'status': 'failed',
            'stage': 'Full-source analysis failed unexpectedly',
            'error': 'Local case analysis failed unexpectedly. The source documents were not changed; review the local model and try again.',
        }, actor=actor)


def _stage_document_inbox_source(data):
    """Analyze and persist a source before its case is known."""
    payload = dict(data or {})
    text = str(payload.get('extracted_text') or payload.get('ocr_text') or payload.get('content') or '')
    title = (
        payload.get('title')
        or payload.get('original_filename')
        or payload.get('document_name')
        or 'Untitled inbox document'
    )
    if not text.strip() and not payload.get('local_path') and title == 'Untitled inbox document':
        raise ValueError('Add source text or choose a local file before staging a document')

    analysis = document_intelligence.analyze_text(
        text,
        document_name=title,
        metadata={
            **(payload.get('metadata') or {}),
            'source_type': payload.get('source_type') or payload.get('source') or 'manual_text',
            'source_uri': payload.get('source_uri') or '',
            'original_filename': payload.get('original_filename') or title,
            'document_type': payload.get('document_type') or payload.get('type') or 'unknown',
            'sender': payload.get('sender') or payload.get('from') or '',
            'recipient': payload.get('recipient') or payload.get('to') or '',
            'date_on_document': payload.get('date_on_document') or payload.get('document_date') or '',
        },
        case_context=None,
    ) if text.strip() else {
        'document_type': payload.get('document_type') or payload.get('type') or 'unreadable_source',
        'summary': '',
        'topics': [],
        'facts': {},
        'processing': {'word_count': 0, 'readable': False, 'analysis_method': 'metadata_only'},
    }
    staged_payload = {
        **payload,
        'title': title,
        'source_type': payload.get('source_type') or payload.get('source') or 'manual_text',
        'document_type': analysis.get('document_type') or payload.get('document_type') or 'unknown',
        'summary': analysis.get('summary') or payload.get('summary') or '',
        'extracted_text': text,
        'analysis': analysis,
        'metadata': {
            **(payload.get('metadata') or {}),
            'document_inbox': True,
            'case_assignment_requires_review': True,
        },
    }
    matches = rank_document_cases(
        {**staged_payload, 'analysis': analysis},
        legal_ledger.list_cases(_ledger_actor()),
        limit=3,
    )
    item = legal_ledger.stage_document_inbox_item(
        _ledger_actor(),
        staged_payload,
        suggested_matches=matches,
        email=session.get('user_email'),
        actor=_ledger_actor(),
    )
    return {
        'item': item,
        'analysis': analysis,
        'suggested_matches': item.get('suggested_matches') or [],
        'requires_human_review': True,
        'external_action_taken': False,
        'source_preserved': True,
    }


@app.route('/api/health', methods=['GET'])
def health():
    """Local readiness check for the Flask app and legal ledger."""
    return jsonify({
        'status': 'ok',
        'service': 'LARO',
        'ledger': 'ready',
        'local_first': True
    }), 200


@app.route('/api/cases', methods=['GET'])
@auth_system._require_auth
def list_ledger_cases():
    ledger_cases = legal_ledger.list_cases(_ledger_actor())
    return jsonify({'cases': ledger_cases, 'count': len(ledger_cases)}), 200


@app.route('/api/cases', methods=['POST'])
@auth_system._require_auth
def create_ledger_case():
    data = _ledger_user_payload(request.json or {})
    created = legal_ledger.create_case(data, actor=_ledger_actor())
    db_manager.invalidate_cache('cases')
    return jsonify(created), 201


@app.route('/api/cases/command-center', methods=['GET'])
@app.route('/api/command-center', methods=['GET'])
@app.route('/api/dashboard/command-center', methods=['GET'])
@auth_system._require_auth
def get_ledger_command_center():
    return jsonify(legal_ledger.command_center(_ledger_actor())), 200


@app.route('/api/cases/<int:case_id>/operating-state', methods=['GET'])
@auth_system._require_auth
def get_ledger_case_operating_state(case_id):
    state = legal_ledger.case_operating_state(case_id)
    if not state:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(state), 200


@app.route('/api/cases/<int:case_id>/review-queue', methods=['GET'])
@auth_system._require_auth
def get_ledger_case_review_queue(case_id):
    queue = legal_ledger.case_review_queue(case_id)
    if not queue:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(queue), 200


@app.route('/api/cases/<int:case_id>', methods=['GET'])
@auth_system._require_auth
def get_ledger_case(case_id):
    case = legal_ledger.get_case(case_id)
    if not case:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(case), 200


@app.route('/api/cases/<int:case_id>', methods=['PATCH'])
@auth_system._require_auth
def update_ledger_case(case_id):
    updated = legal_ledger.update_case(case_id, request.json or {}, actor=_ledger_actor())
    if not updated:
        return jsonify({'error': 'Case not found'}), 404
    db_manager.invalidate_cache('cases')
    return jsonify(updated), 200


@app.route('/api/cases/<int:case_id>/identifiers', methods=['GET'])
@auth_system._require_auth
def list_ledger_case_identifiers(case_id):
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    identifiers = legal_ledger.list_case_identifiers(case_id)
    return jsonify({'case_id': case_id, 'identifiers': identifiers, 'count': len(identifiers)}), 200


@app.route('/api/cases/<int:case_id>/identifiers', methods=['POST'])
@auth_system._require_auth
def create_ledger_case_identifier(case_id):
    try:
        identifier = legal_ledger.add_case_identifier(case_id, request.json or {}, actor=_ledger_actor())
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not identifier:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(identifier), 201


@app.route('/api/case-identifiers/lookup', methods=['GET'])
@auth_system._require_auth
def lookup_ledger_case_identifier():
    value = request.args.get('identifier') or request.args.get('value') or ''
    if not value.strip():
        return jsonify({'error': 'identifier query parameter is required'}), 400
    match = legal_ledger.lookup_case_identifier(
        value,
        external_user_id=_ledger_actor(),
        identifier_type=request.args.get('type') or request.args.get('identifier_type'),
        source_party=request.args.get('source_party'),
    )
    if not match:
        return jsonify({'error': 'Case identifier not found'}), 404
    return jsonify(match), 200


@app.route('/api/document-inbox', methods=['GET'])
@auth_system._require_auth
def list_document_inbox():
    status = request.args.get('status')
    items = legal_ledger.list_document_inbox_items(
        _ledger_actor(),
        status=status,
        limit=request.args.get('limit', 50),
    )
    return jsonify({
        'items': items,
        'count': len(items),
        'needs_review_count': sum(1 for item in items if item.get('status') == 'needs_review'),
    }), 200


@app.route('/api/document-inbox', methods=['POST'])
@auth_system._require_auth
def stage_document_inbox():
    try:
        result = _stage_document_inbox_source(request.json or {})
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    db_manager.invalidate_cache('documents')
    return jsonify(result), 200 if result['item'].get('duplicate') else 201


@app.route('/api/document-inbox/upload', methods=['POST'])
@auth_system._require_auth
def upload_document_inbox():
    file_item = request.files.get('file')
    if not file_item or not file_item.filename:
        return jsonify({'error': 'A file field named file is required'}), 400
    stored = _store_inbox_upload_file(_ledger_actor(), file_item)
    extracted_text = document_intelligence.extract_text_from_file(stored['local_path'])
    try:
        result = _stage_document_inbox_source({
            'source_type': request.form.get('source_type') or 'manual_upload',
            'source_uri': f"local://document-inbox/{stored['content_hash'][:20]}/{stored['stored_name']}",
            'original_filename': stored['original_name'],
            'local_path': stored['local_path'],
            'content_hash': stored['content_hash'],
            'document_type': stored['extension'],
            'title': request.form.get('title') or stored['original_name'],
            'extracted_text': extracted_text,
            'confidentiality_level': request.form.get('confidentiality_level') or 'normal',
            'metadata': {
                'stored_name': stored['stored_name'],
                'size_bytes': stored['size_bytes'],
                'upload_mode': 'case_neutral_document_inbox',
            },
        })
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    db_manager.invalidate_cache('documents')
    result['storage'] = {
        'content_hash': stored['content_hash'],
        'size_bytes': stored['size_bytes'],
        'kept_local': True,
    }
    return jsonify(result), 200 if result['item'].get('duplicate') else 201


@app.route('/api/document-inbox/<int:item_id>', methods=['GET'])
@auth_system._require_auth
def get_document_inbox_item(item_id):
    item = legal_ledger.get_document_inbox_item(item_id, _ledger_actor())
    if not item:
        return jsonify({'error': 'Inbox document not found'}), 404
    return jsonify(item), 200


@app.route('/api/document-inbox/<int:item_id>', methods=['PATCH'])
@auth_system._require_auth
def review_document_inbox_item(item_id):
    try:
        item = legal_ledger.review_document_inbox_item(
            item_id,
            _ledger_actor(),
            (request.json or {}).get('action'),
            actor=_ledger_actor(),
        )
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not item:
        return jsonify({'error': 'Inbox document not found'}), 404
    db_manager.invalidate_cache('documents')
    return jsonify(item), 200


@app.route('/api/document-inbox/<int:item_id>/link', methods=['POST'])
@auth_system._require_auth
def link_document_inbox_item(item_id):
    try:
        case_id = int((request.json or {}).get('case_id'))
    except (TypeError, ValueError):
        return jsonify({'error': 'A valid case_id is required'}), 400
    if not _ledger_case_access_allowed(case_id):
        return jsonify({'error': 'Case not found'}), 404
    try:
        result = legal_ledger.link_document_inbox_item(
            item_id,
            case_id,
            _ledger_actor(),
            actor=_ledger_actor(),
        )
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not result or not result.get('document'):
        return jsonify({'error': 'Inbox document or case not found'}), 404

    artifacts = {
        'timeline_suggestions': [],
        'deadline_suggestions': [],
        'obligation_suggestions': [],
        'open_loop_suggestions': [],
        'claim_suggestions': [],
        'contradiction_suggestions': [],
        'missing_evidence_suggestions': [],
        'evidence_links': [],
        'evidence_links_created': 0,
    }
    if result.get('created') and result.get('analysis'):
        artifacts = _analysis_artifacts_for_document(
            case_id,
            result['document'],
            result['analysis'],
            _ledger_actor(),
        )
    db_manager.invalidate_cache('documents')
    return jsonify({
        **result,
        **artifacts,
        'source_preserved': True,
        'requires_human_review': True,
        'external_action_taken': False,
    }), 201 if result.get('created') else 200


@app.route('/api/cases/<int:case_id>/documents', methods=['GET'])
@auth_system._require_auth
def list_ledger_documents(case_id):
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    return jsonify({'case_id': case_id, 'documents': legal_ledger.list_documents(case_id)}), 200


@app.route('/api/cases/<int:case_id>/documents', methods=['POST'])
@auth_system._require_auth
def create_ledger_document(case_id):
    ledger_case = legal_ledger.get_case(case_id)
    if not ledger_case:
        return jsonify({'error': 'Case not found'}), 404

    data = request.json or {}
    text = data.get('extracted_text') or data.get('ocr_text') or data.get('content') or ''
    should_analyze = _enabled_flag(data, 'analyze', False)
    analysis = None
    if should_analyze and text:
        document_name = data.get('title') or data.get('original_filename') or data.get('document_name') or 'Pasted legal text'
        analysis = document_intelligence.analyze_text(
            text,
            document_name=document_name,
            metadata={
                'source_type': data.get('source_type') or 'manual_text',
                'original_filename': data.get('original_filename') or document_name,
                'document_type': data.get('document_type') or 'manual_note',
                'sender': data.get('sender') or '',
                'recipient': data.get('recipient') or '',
                'date_on_document': data.get('date_on_document') or '',
            },
            case_context=ledger_case,
        )
        existing_metadata = data.get('metadata') or {}
        data = {
            **data,
            'source_type': data.get('source_type') or 'manual_text',
            'source_uri': data.get('source_uri') or f"manual://case/{case_id}/documents/{hashlib.sha256(text.encode('utf-8')).hexdigest()[:16]}",
            'document_type': analysis.get('document_type') or data.get('document_type') or 'manual_note',
            'summary': analysis.get('summary') or data.get('summary') or '',
            'relevance_score': (analysis.get('evidence') or {}).get('relevance_score', data.get('relevance_score') or 0),
            'metadata': {
                **existing_metadata,
                'legal_analysis': analysis,
                'input_mode': 'pasted_text_fast_add',
            },
            'extraction_method': 'document_intelligence_pasted_text',
        }

    document = legal_ledger.add_document(case_id, data, actor=_ledger_actor())
    if not document:
        return jsonify({'error': 'Case not found'}), 404
    if analysis:
        return jsonify({
            'document': document,
            'analysis': analysis,
            **_analysis_artifacts_for_document(case_id, document, analysis, _ledger_actor(), data),
            'storage': {
                'source_uri': document.get('source_uri'),
                'content_hash': document.get('content_hash'),
                'size_bytes': len(text.encode('utf-8')),
            },
        }), 201
    return jsonify(document), 201


@app.route('/api/cases/<int:case_id>/documents/import-sources', methods=['POST'])
@auth_system._require_auth
def import_ledger_source_documents(case_id):
    ledger_case = legal_ledger.get_case(case_id)
    if not ledger_case:
        return jsonify({'error': 'Case not found'}), 404

    data = request.json or {}
    records = data.get('documents') or data.get('items') or data.get('records') or []
    if not isinstance(records, list) or not records:
        return jsonify({'error': 'A non-empty documents array is required'}), 400

    source_type = data.get('source_type') or data.get('source') or 'external_source'
    meta_tag = data.get('meta_tag') or data.get('tag') or data.get('query') or ''
    return jsonify(_import_source_records(
        case_id,
        data,
        records,
        source_type=source_type,
        meta_tag=meta_tag,
        actor=_ledger_actor(),
    )), 201


@app.route('/api/cases/<int:case_id>/documents/pull-google', methods=['POST'])
@auth_system._require_auth
def pull_google_case_documents(case_id):
    """Read explicitly queried Gmail/Drive items into one local case ledger."""
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404

    data = request.json or {}
    source = str(data.get('source') or 'gmail').strip().lower()
    query = str(data.get('query') or data.get('meta_tag') or data.get('tag') or '').strip()
    if not query:
        return jsonify({'error': 'Enter a Gmail search or Google Drive query before pulling sources'}), 400

    actor = _ledger_actor()
    try:
        token_response = google_token_store.load(actor, 'google')
    except TokenStoreError as exc:
        return jsonify({'error': str(exc)}), 503
    if not token_response:
        return jsonify({'error': 'Google is not connected for this local LARO account'}), 409

    config = google_oauth_config()
    if not config['configured']:
        return jsonify({'error': 'Google OAuth is not configured on this local LARO installation'}), 503

    try:
        connector = GoogleEvidenceConnector(
            token_response,
            client_id=config['client_id'],
            client_secret=config['client_secret'],
            scopes=GOOGLE_SCOPES,
        )
        records, refreshed_token = connector.fetch(source, query, data.get('max_items', 50))
        if refreshed_token:
            google_token_store.save(actor, 'google', refreshed_token)
    except (GoogleEvidenceError, TokenStoreError) as exc:
        return jsonify({'error': str(exc)}), 502

    result = _import_source_records(
        case_id,
        data,
        records,
        source_type='google',
        meta_tag=query,
        actor=actor,
    )
    legal_ledger.record_case_activity(
        case_id,
        'google_sources_pulled',
        actor=actor,
        source='google_readonly_connector',
        details={
            'source': source,
            'query': query,
            'fetched_count': len(records),
            'imported_count': result['imported_count'],
            'skipped_count': result['skipped_count'],
            'credentials_refreshed': bool(refreshed_token),
        },
        risk_level='medium',
    )
    return jsonify({
        **result,
        'connector': {
            'provider': 'google',
            'source': source,
            'mode': 'read_only',
            'credentials_refreshed': bool(refreshed_token),
        },
    }), 201


@app.route('/api/cases/<int:case_id>/documents/pull-google/jobs', methods=['POST'])
@auth_system._require_auth
def start_google_case_document_pull_job(case_id):
    """Start a durable, read-only Google pull that the local UI can poll for real progress."""
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    data = request.json or {}
    source = str(data.get('source') or 'gmail').strip().lower()
    query = str(data.get('query') or data.get('meta_tag') or data.get('tag') or '').strip()
    if source not in {'gmail', 'google_drive'}:
        return jsonify({'error': 'source must be gmail or google_drive'}), 400
    if not query:
        return jsonify({'error': 'Enter a Gmail search or Google Drive query before pulling sources'}), 400
    try:
        max_items = min(100, max(1, int(data.get('max_items') or 50)))
    except (TypeError, ValueError):
        return jsonify({'error': 'max_items must be a number between 1 and 100'}), 400
    raw_days_back = data.get('days_back')
    if raw_days_back in {None, ''}:
        days_back = None
    else:
        try:
            days_back = min(3650, max(1, int(raw_days_back)))
        except (TypeError, ValueError):
            return jsonify({'error': 'days_back must be a number between 1 and 3650'}), 400
    sort_order = str(data.get('sort_order') or 'newest').strip().lower()
    if sort_order not in {'newest', 'oldest'}:
        return jsonify({'error': 'sort_order must be newest or oldest'}), 400

    actor = _ledger_actor()
    try:
        token_response = google_token_store.load(actor, 'google')
    except TokenStoreError as exc:
        return jsonify({'error': str(exc)}), 503
    if not token_response:
        return jsonify({'error': 'Google is not connected for this local LARO account'}), 409
    if not google_oauth_config()['configured']:
        return jsonify({'error': 'Google OAuth is not configured on this local LARO installation'}), 503

    job_data = {
        'provider': 'google',
        'source': source,
        'query': query,
        'max_items': max_items,
        'days_back': days_back,
        'sort_order': sort_order,
        'confidentiality_level': data.get('confidentiality_level') or 'normal',
    }
    job = legal_ledger.create_evidence_import_job(case_id, job_data, actor=actor)
    if not job:
        return jsonify({'error': 'Case not found'}), 404
    google_pull_executor.submit(_run_google_pull_job, job['job_id'], case_id, job_data, actor)
    return jsonify({
        'job': job,
        'status_url': f'/api/cases/{case_id}/documents/pull-google/jobs/{job["job_id"]}',
        'message': 'Google evidence pull started locally. LARO will show actual source and word progress as records arrive.',
    }), 202


@app.route('/api/cases/<int:case_id>/documents/pull-google/jobs', methods=['GET'])
@auth_system._require_auth
def list_google_case_document_pull_jobs(case_id):
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    status = request.args.get('status')
    return jsonify({'jobs': legal_ledger.list_evidence_import_jobs(case_id, status=status)}), 200


@app.route('/api/cases/<int:case_id>/documents/pull-google/jobs/<int:job_id>', methods=['GET'])
@auth_system._require_auth
def get_google_case_document_pull_job(case_id, job_id):
    job = legal_ledger.get_evidence_import_job(case_id, job_id)
    if not job:
        return jsonify({'error': 'Google evidence import job not found'}), 404
    return jsonify({'job': job}), 200


@app.route('/api/cases/<int:case_id>/documents/<int:document_id>', methods=['GET'])
@auth_system._require_auth
def get_ledger_document(case_id, document_id):
    document = legal_ledger.get_document(case_id, document_id)
    if not document:
        return jsonify({'error': 'Document not found'}), 404
    can_open_file = bool(_safe_served_upload_path(document.get('local_path')))
    return jsonify({
        'document': document,
        'can_open_file': can_open_file,
        'file_url': f'/api/cases/{case_id}/documents/{document_id}/file' if can_open_file else None,
    }), 200


@app.route('/api/cases/<int:case_id>/documents/<int:document_id>/versions', methods=['GET'])
@auth_system._require_auth
def list_ledger_document_versions(case_id, document_id):
    versions = legal_ledger.list_document_versions(case_id, document_id)
    if versions is None:
        return jsonify({'error': 'Document not found'}), 404
    return jsonify({'case_id': case_id, 'document_id': document_id, 'versions': versions}), 200


@app.route('/api/cases/<int:case_id>/documents/<int:document_id>/recover-text', methods=['POST'])
@auth_system._require_auth
def recover_ledger_document_text(case_id, document_id):
    """Analyze recovered text while preserving the original source and extraction history."""
    ledger_case = legal_ledger.get_case(case_id)
    document = legal_ledger.get_document(case_id, document_id)
    if not ledger_case or not document:
        return jsonify({'error': 'Document not found'}), 404
    data = request.json or {}
    recovered_text = str(data.get('extracted_text') or data.get('ocr_text') or data.get('content') or '').strip()
    extraction_method = str(data.get('extraction_method') or '').strip()
    if not recovered_text:
        local_path = document.get('local_path') or ''
        if local_path and _safe_served_upload_path(local_path):
            recovered_text = document_intelligence.extract_text_from_file(local_path)
            extraction_method = extraction_method or 'local_file_reextract'
    if not recovered_text:
        return jsonify({
            'error': 'No readable text is available from this source. Paste recovered text or upload a text-readable copy.',
            'source_preserved': True,
        }), 409

    analysis = document_intelligence.analyze_text(
        recovered_text,
        document_name=document.get('title') or document.get('original_filename') or 'Recovered evidence text',
        metadata={
            **(document.get('metadata') or {}),
            'source_type': document.get('source_type'),
            'original_filename': document.get('original_filename'),
            'document_type': document.get('document_type'),
            'sender': document.get('sender'),
            'recipient': document.get('recipient'),
        },
        case_context=ledger_case,
    )
    was_readable = bool(str(document.get('extracted_text') or document.get('ocr_text') or '').strip())
    recovered = legal_ledger.update_document_extraction(case_id, document_id, {
        'extracted_text': recovered_text,
        'ocr_text': data.get('ocr_text') or '',
        'summary': analysis.get('summary') or document.get('summary') or '',
        'relevance_score': (analysis.get('evidence') or {}).get('relevance_score', document.get('relevance_score') or 0),
        'extraction_method': extraction_method or 'manual_text_recovery',
        'metadata': {
            **(document.get('metadata') or {}),
            'legal_analysis': analysis,
        },
    }, actor=_ledger_actor())
    if not recovered:
        return jsonify({'error': 'Document not found'}), 404
    artifacts = _analysis_artifacts_for_document(
        case_id,
        recovered,
        analysis,
        _ledger_actor(),
        {
            **data,
            'create_timeline_suggestions': not was_readable or _enabled_flag(data, 'force_rebuild_artifacts', False),
            'create_review_items': not was_readable or _enabled_flag(data, 'force_rebuild_artifacts', False),
            'create_claim_suggestions': not was_readable or _enabled_flag(data, 'force_rebuild_artifacts', False),
            'create_gap_suggestions': not was_readable or _enabled_flag(data, 'force_rebuild_artifacts', False),
        },
    )
    return jsonify({
        'document': recovered,
        'analysis': analysis,
        'source_preserved': True,
        'created_artifacts': not was_readable or _enabled_flag(data, 'force_rebuild_artifacts', False),
        **artifacts,
    }), 200


@app.route('/api/cases/<int:case_id>/documents/<int:document_id>/reanalyze', methods=['POST'])
@auth_system._require_auth
def reanalyze_ledger_document(case_id, document_id):
    """Refresh derived source analysis without changing the document or extraction version."""
    ledger_case = legal_ledger.get_case(case_id)
    document = legal_ledger.get_document(case_id, document_id)
    if not ledger_case or not document:
        return jsonify({'error': 'Document not found'}), 404
    text = str(document.get('extracted_text') or document.get('ocr_text') or '').strip()
    if not text:
        return jsonify({
            'error': 'No readable text is available to analyze. Recover text first while preserving the original source.',
            'source_preserved': True,
        }), 409
    analysis = document_intelligence.analyze_text(
        text,
        document_name=document.get('title') or document.get('original_filename') or 'Source document',
        metadata={
            **(document.get('metadata') or {}),
            'source_type': document.get('source_type'),
            'original_filename': document.get('original_filename'),
            'document_type': document.get('document_type'),
            'sender': document.get('sender'),
            'recipient': document.get('recipient'),
        },
        case_context=ledger_case,
    )
    refreshed = legal_ledger.update_document_analysis(case_id, document_id, {
        'legal_analysis': analysis,
        'summary': analysis.get('summary') or document.get('summary') or '',
        'relevance_score': (analysis.get('evidence') or {}).get('relevance_score', document.get('relevance_score') or 0),
    }, actor=_ledger_actor())
    if not refreshed:
        return jsonify({'error': 'Document not found'}), 404
    return jsonify({
        'document': refreshed,
        'analysis': analysis,
        'source_preserved': True,
        'extraction_version_unchanged': True,
        'created_artifacts': False,
    }), 200


@app.route('/api/cases/<int:case_id>/case-analysis', methods=['GET'])
@auth_system._require_auth
def list_ledger_case_analysis(case_id):
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    runs = legal_ledger.list_case_analysis_runs(case_id)
    return jsonify({'case_id': case_id, 'runs': runs, 'latest': runs[0] if runs else None}), 200


@app.route('/api/cases/<int:case_id>/case-analysis/jobs', methods=['POST'])
@auth_system._require_auth
def start_ledger_case_analysis_job(case_id):
    """Start or resume one durable full-source local analysis for this case."""
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    documents = _readable_case_analysis_documents(case_id)
    if not documents:
        return jsonify({
            'error': 'No readable source documents are available. Recover source text before running a case-wide analysis.',
            'source_preserved': True,
        }), 409
    active = next((
        item for item in legal_ledger.list_case_analysis_jobs(case_id)
        if item.get('status') in {'queued', 'running'}
    ), None)
    if active:
        return jsonify({
            'job': active,
            'status_url': f'/api/cases/{case_id}/case-analysis/jobs/{active["job_id"]}',
            'reused_active_job': True,
        }), 200
    actor = _ledger_actor()
    job = legal_ledger.create_case_analysis_job(
        case_id,
        _case_analysis_workload(documents),
        actor=actor,
    )
    if not job:
        return jsonify({'error': 'Case not found'}), 404
    case_analysis_executor.submit(_run_case_analysis_job, job['job_id'], case_id, actor)
    return jsonify({
        'job': job,
        'status_url': f'/api/cases/{case_id}/case-analysis/jobs/{job["job_id"]}',
        'message': 'Full-source local analysis started. LARO will show actual document, batch, word, and time progress.',
        'reused_active_job': False,
    }), 202


@app.route('/api/cases/<int:case_id>/case-analysis/jobs', methods=['GET'])
@auth_system._require_auth
def list_ledger_case_analysis_jobs(case_id):
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    return jsonify({
        'case_id': case_id,
        'jobs': legal_ledger.list_case_analysis_jobs(case_id, status=request.args.get('status')),
    }), 200


@app.route('/api/cases/<int:case_id>/case-analysis/jobs/<int:job_id>', methods=['GET'])
@auth_system._require_auth
def get_ledger_case_analysis_job(case_id, job_id):
    job = legal_ledger.get_case_analysis_job(case_id, job_id)
    if not job:
        return jsonify({'error': 'Case analysis job not found'}), 404
    return jsonify({'job': job}), 200


@app.route('/api/cases/<int:case_id>/case-analysis', methods=['POST'])
@auth_system._require_auth
def create_ledger_case_analysis(case_id):
    """Create a review-only, cross-document local synthesis for this case."""
    ledger_case = legal_ledger.get_case(case_id)
    if not ledger_case:
        return jsonify({'error': 'Case not found'}), 404
    readable_documents = _readable_case_analysis_documents(case_id)
    if not readable_documents:
        return jsonify({
            'error': 'No readable source documents are available. Recover source text before running a case-wide analysis.',
            'source_preserved': True,
        }), 409
    analysis = document_intelligence.semantic_provider.analyze_case(readable_documents, ledger_case)
    if analysis.get('status') != 'completed':
        return jsonify({
            'error': (analysis.get('limitations') or ['Case-wide local analysis is not available.'])[0],
            'analysis': analysis,
            'source_preserved': True,
        }), 409
    run = _persist_case_analysis_run(case_id, analysis, _ledger_actor())
    if not run:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify({
        'run': run,
        'source_preserved': True,
        'created_artifacts': False,
        'requires_human_review': True,
    }), 201


@app.route('/api/cases/<int:case_id>/case-analysis/review-items/<int:item_id>', methods=['PATCH'])
@auth_system._require_auth
def update_ledger_case_analysis_review_item(case_id, item_id):
    """Apply a cited case-wide observation only after an explicit ledger choice."""
    payload = request.json or {}
    try:
        item = legal_ledger.update_case_analysis_review_item(
            case_id,
            item_id,
            payload,
            actor=_ledger_actor(),
        )
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not item:
        return jsonify({'error': 'Case analysis review item not found'}), 404
    return jsonify({
        'review_item': item,
        'source_preserved': True,
        'confirmation_applied': payload.get('action') == 'confirm_timeline',
        'requires_human_review': item.get('status') == 'converted' and payload.get('action') != 'confirm_timeline',
    }), 200


@app.route('/api/cases/<int:case_id>/documents/<int:document_id>/file', methods=['GET'])
@auth_system._require_auth
def open_ledger_document_file(case_id, document_id):
    document = legal_ledger.get_document(case_id, document_id)
    if not document:
        return jsonify({'error': 'Document not found'}), 404
    local_path = document.get('local_path') or ''
    resolved = os.path.abspath(local_path) if local_path else ''
    if local_path and os.path.isfile(resolved) and not _safe_served_upload_path(local_path):
        return jsonify({'error': 'Document file is outside the LARO upload store'}), 403
    safe_path = _safe_served_upload_path(local_path)
    if not safe_path:
        return jsonify({'error': 'No local file is available for this document'}), 404
    download_name = document.get('original_filename') or document.get('title') or os.path.basename(safe_path)
    return send_file(safe_path, as_attachment=False, download_name=download_name)


@app.route('/api/cases/<int:case_id>/documents/upload', methods=['POST'])
@auth_system._require_auth
def upload_ledger_document(case_id):
    ledger_case = legal_ledger.get_case(case_id)
    if not ledger_case:
        return jsonify({'error': 'Case not found'}), 404

    file_item = request.files.get('file')
    if not file_item or not file_item.filename:
        return jsonify({'error': 'A file field named file is required'}), 400

    stored = _store_upload_file(case_id, file_item)
    extracted_text = document_intelligence.extract_text_from_file(stored['local_path'])
    analysis = document_intelligence.analyze_text(
        extracted_text,
        document_name=stored['original_name'],
        metadata={
            'source_type': 'manual_upload',
            'original_filename': stored['original_name'],
            'document_type': stored['extension'],
        },
        case_context=ledger_case,
    )
    title = request.form.get('title') or stored['original_name']
    document = legal_ledger.add_document(case_id, {
        'source_type': 'manual_upload',
        'source_uri': f"local://case/{case_id}/documents/{stored['stored_name']}",
        'original_filename': stored['original_name'],
        'local_path': stored['local_path'],
        'content_hash': stored['content_hash'],
        'document_type': analysis.get('document_type') or stored['extension'],
        'title': title,
        'extracted_text': extracted_text,
        'summary': analysis.get('summary') or '',
        'relevance_score': (analysis.get('evidence') or {}).get('relevance_score', 0),
        'confidentiality_level': request.form.get('confidentiality_level') or 'normal',
        'metadata': {
            'legal_analysis': analysis,
            'stored_name': stored['stored_name'],
            'size_bytes': stored['size_bytes'],
            'upload_mode': 'local_first_manual_upload',
        },
        'extraction_method': 'document_intelligence_upload',
    }, actor=_ledger_actor())
    if not document:
        return jsonify({'error': 'Case not found'}), 404

    analysis_artifacts = _analysis_artifacts_for_document(case_id, document, analysis, _ledger_actor(), request.form)

    return jsonify({
        'document': document,
        'analysis': analysis,
        **analysis_artifacts,
        'storage': {
            'source_uri': document.get('source_uri'),
            'content_hash': stored['content_hash'],
            'size_bytes': stored['size_bytes'],
        },
    }), 201


@app.route('/api/cases/<int:case_id>/timeline', methods=['GET'])
@auth_system._require_auth
def list_ledger_timeline(case_id):
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    return jsonify({'case_id': case_id, 'timeline': legal_ledger.list_timeline(case_id)}), 200


@app.route('/api/cases/<int:case_id>/timeline', methods=['POST'])
@auth_system._require_auth
def create_ledger_event(case_id):
    event = legal_ledger.add_event(case_id, request.json or {}, actor=_ledger_actor())
    if not event:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(event), 201


@app.route('/api/cases/<int:case_id>/timeline/<int:event_id>', methods=['PATCH'])
@auth_system._require_auth
def update_ledger_event(case_id, event_id):
    try:
        event = legal_ledger.update_event(case_id, event_id, request.json or {}, actor=_ledger_actor())
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not event:
        return jsonify({'error': 'Timeline event not found'}), 404
    return jsonify(event), 200


@app.route('/api/cases/<int:case_id>/claims', methods=['GET'])
@auth_system._require_auth
def list_ledger_claims(case_id):
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    return jsonify({'case_id': case_id, 'claims': legal_ledger.list_claims(case_id)}), 200


@app.route('/api/cases/<int:case_id>/claims', methods=['POST'])
@auth_system._require_auth
def create_ledger_claim(case_id):
    try:
        claim = legal_ledger.add_claim(case_id, request.json or {}, actor=_ledger_actor())
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not claim:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(claim), 201


@app.route('/api/cases/<int:case_id>/positions', methods=['GET'])
@auth_system._require_auth
def get_case_position_matrix(case_id):
    matrix = legal_ledger.case_position_matrix(case_id)
    if not matrix:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(matrix), 200


@app.route('/api/cases/<int:case_id>/claims/<int:claim_id>', methods=['PATCH'])
@auth_system._require_auth
def update_ledger_claim(case_id, claim_id):
    try:
        claim = legal_ledger.update_claim(case_id, claim_id, request.json or {}, actor=_ledger_actor())
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not claim:
        return jsonify({'error': 'Claim not found'}), 404
    return jsonify(claim), 200


@app.route('/api/cases/<int:case_id>/evidence', methods=['GET'])
@auth_system._require_auth
def list_ledger_evidence(case_id):
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    return jsonify({'case_id': case_id, 'evidence_links': legal_ledger.list_evidence_links(case_id)}), 200


@app.route('/api/cases/<int:case_id>/evidence', methods=['POST'])
@auth_system._require_auth
def create_ledger_evidence(case_id):
    try:
        link = legal_ledger.add_evidence_link(case_id, request.json or {}, actor=_ledger_actor())
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not link:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(link), 201


@app.route('/api/cases/<int:case_id>/evidence/<int:link_id>', methods=['PATCH'])
@auth_system._require_auth
def update_ledger_evidence(case_id, link_id):
    try:
        link = legal_ledger.update_evidence_link(case_id, link_id, request.json or {}, actor=_ledger_actor())
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not link:
        return jsonify({'error': 'Evidence link not found'}), 404
    return jsonify(link), 200


@app.route('/api/cases/<int:case_id>/contradictions', methods=['GET'])
@auth_system._require_auth
def list_ledger_contradictions(case_id):
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    return jsonify({'case_id': case_id, 'contradictions': legal_ledger.list_contradictions(case_id)}), 200


@app.route('/api/cases/<int:case_id>/contradictions', methods=['POST'])
@auth_system._require_auth
def create_ledger_contradiction(case_id):
    contradiction = legal_ledger.add_contradiction(case_id, request.json or {}, actor=_ledger_actor())
    if not contradiction:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(contradiction), 201


@app.route('/api/cases/<int:case_id>/contradictions/<int:contradiction_id>', methods=['PATCH'])
@auth_system._require_auth
def update_ledger_contradiction(case_id, contradiction_id):
    try:
        contradiction = legal_ledger.update_contradiction(case_id, contradiction_id, request.json or {}, actor=_ledger_actor())
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not contradiction:
        return jsonify({'error': 'Contradiction not found'}), 404
    return jsonify(contradiction), 200


@app.route('/api/cases/<int:case_id>/missing-evidence', methods=['GET'])
@auth_system._require_auth
def list_ledger_missing_evidence(case_id):
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    warnings = legal_ledger.list_missing_evidence(case_id)
    return jsonify({'case_id': case_id, 'missing_evidence': warnings, 'count': len(warnings)}), 200


@app.route('/api/cases/<int:case_id>/missing-evidence', methods=['POST'])
@auth_system._require_auth
def create_ledger_missing_evidence(case_id):
    warning = legal_ledger.add_missing_evidence_warning(case_id, request.json or {}, actor=_ledger_actor())
    if not warning:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(warning), 201


@app.route('/api/cases/<int:case_id>/missing-evidence/<int:warning_id>', methods=['PATCH'])
@auth_system._require_auth
def update_ledger_missing_evidence(case_id, warning_id):
    try:
        warning = legal_ledger.update_missing_evidence_warning(case_id, warning_id, request.json or {}, actor=_ledger_actor())
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not warning:
        return jsonify({'error': 'Missing-evidence warning not found'}), 404
    return jsonify(warning), 200


@app.route('/api/cases/<int:case_id>/deadlines', methods=['GET'])
@auth_system._require_auth
def list_ledger_deadlines(case_id):
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    return jsonify({'case_id': case_id, 'deadlines': legal_ledger.list_deadlines(case_id)}), 200


@app.route('/api/cases/<int:case_id>/deadlines', methods=['POST'])
@auth_system._require_auth
def create_ledger_deadline(case_id):
    deadline = legal_ledger.add_deadline(case_id, request.json or {}, actor=_ledger_actor())
    if not deadline:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(deadline), 201


@app.route('/api/cases/<int:case_id>/deadlines/<int:deadline_id>', methods=['PATCH'])
@auth_system._require_auth
def update_ledger_deadline(case_id, deadline_id):
    try:
        deadline = legal_ledger.update_deadline(case_id, deadline_id, request.json or {}, actor=_ledger_actor())
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not deadline:
        return jsonify({'error': 'Deadline not found'}), 404
    return jsonify(deadline), 200


@app.route('/api/cases/<int:case_id>/obligations', methods=['GET'])
@auth_system._require_auth
def list_ledger_obligations(case_id):
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    return jsonify({'case_id': case_id, 'obligations': legal_ledger.list_obligations(case_id)}), 200


@app.route('/api/cases/<int:case_id>/obligations', methods=['POST'])
@auth_system._require_auth
def create_ledger_obligation(case_id):
    payload = request.json or {}
    source_document_id = payload.get('source_document_id')
    if source_document_id and not str(payload.get('source_quote') or '').strip():
        return jsonify({'error': 'An exact source_quote is required when linking an obligation to a document'}), 400
    try:
        item = legal_ledger.add_obligation(case_id, payload, actor=_ledger_actor())
    except (TypeError, ValueError) as exc:
        return jsonify({'error': str(exc)}), 400
    if not item:
        return jsonify({'error': 'Case not found'}), 404
    if source_document_id:
        try:
            link = legal_ledger.add_evidence_link(case_id, {
                'document_id': source_document_id,
                'target_type': 'obligation',
                'target_id': item['id'],
                'snippet': payload.get('source_quote') or '',
                'relationship': 'states_obligation',
                'strength': 'medium',
                'source_confidence': payload.get('source_confidence') or 0.0,
                'user_confirmed': False,
            }, actor=_ledger_actor())
            if link:
                item['evidence_link'] = link
        except (KeyError, TypeError, ValueError):
            pass
    return jsonify(item), 201


@app.route('/api/cases/<int:case_id>/obligations/<int:obligation_id>', methods=['PATCH'])
@auth_system._require_auth
def update_ledger_obligation(case_id, obligation_id):
    try:
        item = legal_ledger.update_obligation(case_id, obligation_id, request.json or {}, actor=_ledger_actor())
    except (TypeError, ValueError) as exc:
        return jsonify({'error': str(exc)}), 400
    if not item:
        return jsonify({'error': 'Obligation not found'}), 404
    return jsonify(item), 200


@app.route('/api/cases/<int:case_id>/open-loops', methods=['GET'])
@auth_system._require_auth
def list_ledger_open_loops(case_id):
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    return jsonify({'case_id': case_id, 'open_loops': legal_ledger.list_open_loops(case_id)}), 200


@app.route('/api/cases/<int:case_id>/open-loops', methods=['POST'])
@auth_system._require_auth
def create_ledger_open_loop(case_id):
    item = legal_ledger.add_open_loop(case_id, request.json or {}, actor=_ledger_actor())
    if not item:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(item), 201


@app.route('/api/cases/<int:case_id>/open-loops/<int:loop_id>', methods=['PATCH'])
@auth_system._require_auth
def update_ledger_open_loop(case_id, loop_id):
    try:
        item = legal_ledger.update_open_loop(case_id, loop_id, request.json or {}, actor=_ledger_actor())
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not item:
        return jsonify({'error': 'Open loop not found'}), 404
    return jsonify(item), 200


@app.route('/api/cases/<int:case_id>/outreach', methods=['GET'])
@auth_system._require_auth
def list_ledger_outreach(case_id):
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    return jsonify({'case_id': case_id, 'outreach': legal_ledger.list_outreach(case_id)}), 200


@app.route('/api/cases/<int:case_id>/outreach', methods=['POST'])
@auth_system._require_auth
def create_ledger_outreach(case_id):
    outreach = legal_ledger.create_outreach_draft(case_id, request.json or {}, actor=_ledger_actor())
    if not outreach:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(outreach), 201


@app.route('/api/cases/<int:case_id>/outreach/responses', methods=['GET'])
@auth_system._require_auth
def list_ledger_outreach_responses(case_id):
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    responses = legal_ledger.list_lawyer_responses(case_id)
    return jsonify({'case_id': case_id, 'responses': responses, 'count': len(responses)}), 200


@app.route('/api/cases/<int:case_id>/outreach/<int:outreach_id>/responses', methods=['GET'])
@auth_system._require_auth
def list_ledger_outreach_item_responses(case_id, outreach_id):
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    responses = legal_ledger.list_lawyer_responses(case_id, outreach_id=outreach_id)
    return jsonify({'case_id': case_id, 'outreach_id': outreach_id, 'responses': responses, 'count': len(responses)}), 200


@app.route('/api/cases/<int:case_id>/outreach/<int:outreach_id>/responses', methods=['POST'])
@auth_system._require_auth
def record_ledger_outreach_response(case_id, outreach_id):
    response = legal_ledger.add_lawyer_response(case_id, outreach_id, request.json or {}, actor=_ledger_actor())
    if not response:
        return jsonify({'error': 'Outreach record not found for this case'}), 404
    return jsonify(response), 201


@app.route('/api/cases/<int:case_id>/drafts', methods=['GET'])
@auth_system._require_auth
def list_ledger_drafts(case_id):
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    drafts = legal_ledger.list_drafts(case_id)
    return jsonify({'case_id': case_id, 'drafts': drafts, 'count': len(drafts)}), 200


@app.route('/api/cases/<int:case_id>/drafts', methods=['POST'])
@auth_system._require_auth
def create_ledger_draft(case_id):
    draft = legal_ledger.create_draft(case_id, request.json or {}, actor=_ledger_actor())
    if not draft:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(draft), 201


@app.route('/api/cases/<int:case_id>/drafts/generate', methods=['POST'])
@auth_system._require_auth
def generate_ledger_case_draft(case_id):
    """Create a local source-linked internal brief from the persisted case dossier."""
    try:
        draft = legal_ledger.generate_case_brief(
            case_id,
            (request.json or {}).get('draft_type') or 'lawyer_summary',
            actor=_ledger_actor(),
        )
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not draft:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify({'draft': draft, 'source_preserved': True, 'external_action_taken': False}), 201


@app.route('/api/cases/<int:case_id>/drafts/<int:draft_id>', methods=['GET'])
@auth_system._require_auth
def get_ledger_draft(case_id, draft_id):
    draft = legal_ledger.get_draft(case_id, draft_id)
    if not draft:
        return jsonify({'error': 'Draft not found'}), 404
    return jsonify(draft), 200


@app.route('/api/cases/<int:case_id>/drafts/<int:draft_id>', methods=['PATCH'])
@auth_system._require_auth
def update_ledger_draft(case_id, draft_id):
    try:
        draft = legal_ledger.update_draft(case_id, draft_id, request.json or {}, actor=_ledger_actor())
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not draft:
        return jsonify({'error': 'Draft not found'}), 404
    return jsonify(draft), 200


@app.route('/api/cases/<int:case_id>/papertrail', methods=['GET'])
@auth_system._require_auth
def get_ledger_papertrail(case_id):
    graph = legal_ledger.papertrail_graph(case_id)
    if not graph:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(graph), 200


@app.route('/api/cases/<int:case_id>/summary', methods=['GET'])
@auth_system._require_auth
def get_ledger_summary(case_id):
    summary = legal_ledger.case_summary(case_id)
    if not summary:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(summary), 200


@app.route('/api/cases/<int:case_id>/comprehension', methods=['GET'])
@auth_system._require_auth
def get_ledger_comprehension(case_id):
    dossier = legal_ledger.case_comprehension_dossier(case_id)
    if not dossier:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(dossier), 200


@app.route('/api/cases/<int:case_id>/red-line', methods=['GET'])
@auth_system._require_auth
def get_ledger_red_line(case_id):
    red_line = legal_ledger.red_line_thread(case_id)
    if not red_line:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(red_line), 200


@app.route('/api/cases/<int:case_id>/bundle', methods=['GET'])
@auth_system._require_auth
def get_ledger_bundle(case_id):
    if not _ledger_case_access_allowed(case_id):
        return jsonify({'error': 'Case not found'}), 404
    bundle = legal_ledger.case_bundle(case_id)
    if not bundle:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(bundle), 200


@app.route('/api/cases/<int:case_id>/bundle/download', methods=['GET'])
@auth_system._require_auth
def download_ledger_bundle(case_id):
    if not _ledger_case_access_allowed(case_id):
        return jsonify({'error': 'Case not found'}), 404
    bundle = legal_ledger.case_bundle(case_id)
    if not bundle:
        return jsonify({'error': 'Case not found'}), 404
    approval = bundle.get('external_sharing_approval') or {}
    if not bundle.get('external_sharing_allowed'):
        legal_ledger.record_case_activity(
            case_id,
            'case_bundle_export_blocked',
            actor=_ledger_actor(),
            source='bundle_export',
            details={
                'share_status': bundle.get('share_status'),
                'approval_stale': bool(bundle.get('approval_stale')),
                'bundle_snapshot_hash': bundle.get('bundle_snapshot_hash'),
                'external_file_created': False,
            },
            risk_level='high',
            approval_id=approval.get('id'),
        )
        return jsonify({
            'error': 'A current approved bundle snapshot is required before download',
            'approval_required': True,
            'external_sharing_allowed': False,
            'share_status': bundle.get('share_status'),
            'approval_stale': bool(bundle.get('approval_stale')),
        }), 409

    try:
        max_bytes = int(os.environ.get('LARO_BUNDLE_MAX_BYTES') or DEFAULT_MAX_BUNDLE_BYTES)
    except (TypeError, ValueError):
        max_bytes = DEFAULT_MAX_BUNDLE_BYTES
    exporter = CaseBundleExporter(
        safe_file_resolver=_safe_served_upload_path,
        max_uncompressed_bytes=max_bytes,
    )
    try:
        exported = exporter.build(bundle, bundle.get('document_index') or [])
    except CaseBundleExportError as exc:
        return jsonify({'error': str(exc)}), 409

    manifest = exported['manifest']
    legal_ledger.record_case_activity(
        case_id,
        'case_bundle_exported',
        actor=_ledger_actor(),
        source='bundle_export',
        details={
            'bundle_snapshot_hash': bundle.get('bundle_snapshot_hash'),
            'archive_sha256': exported['archive_sha256'],
            'archive_size_bytes': exported['archive_size_bytes'],
            'entry_count': len(manifest.get('entries') or []),
            'omitted_entry_count': len(manifest.get('omitted_entries') or []),
            'external_message_sent': False,
        },
        risk_level='high',
        approval_id=approval.get('id'),
    )
    response = send_file(
        io.BytesIO(exported['archive_bytes']),
        mimetype='application/zip',
        as_attachment=True,
        download_name=exported['download_name'],
        max_age=0,
    )
    response.headers['Cache-Control'] = 'no-store, max-age=0'
    response.headers['X-LARO-Approval-Id'] = str(approval.get('id') or '')
    response.headers['X-LARO-Bundle-SHA256'] = exported['archive_sha256']
    response.headers['X-LARO-Snapshot-SHA256'] = str(bundle.get('bundle_snapshot_hash') or '')
    return response


@app.route('/api/cases/<int:case_id>/bundle/share-approval', methods=['POST'])
@auth_system._require_auth
def request_ledger_bundle_share_approval(case_id):
    if not _ledger_case_access_allowed(case_id):
        return jsonify({'error': 'Case not found'}), 404
    approval = legal_ledger.request_case_bundle_share_approval(
        case_id,
        actor=_ledger_actor(),
        reason=(request.json or {}).get('reason', '')
    )
    if not approval:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(approval), 201


@app.route('/api/approvals', methods=['GET'])
@auth_system._require_auth
def list_ledger_approvals():
    case_id = request.args.get('case_id', type=int)
    status = request.args.get('status')
    if case_id is not None and not _ledger_case_access_allowed(case_id):
        return jsonify({'error': 'Case not found'}), 404
    approvals = legal_ledger.list_approvals(case_id=case_id, status=status, external_user_id=_ledger_actor())
    return jsonify({'approvals': approvals, 'count': len(approvals)}), 200


@app.route('/api/approvals/<int:approval_id>', methods=['PATCH'])
@auth_system._require_auth
def resolve_ledger_approval(approval_id):
    if not legal_ledger.user_owns_approval(approval_id, _ledger_actor()):
        return jsonify({'error': 'Approval not found'}), 404
    data = request.json or {}
    try:
        approval = legal_ledger.resolve_approval(
            approval_id,
            data.get('status'),
            actor=_ledger_actor(),
            reason=data.get('reason', '')
        )
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not approval:
        return jsonify({'error': 'Approval not found'}), 404
    return jsonify(approval), 200


@app.route('/api/audit', methods=['GET'])
@auth_system._require_auth
def list_ledger_audit():
    case_id = request.args.get('case_id', type=int)
    if case_id is not None and not _ledger_case_access_allowed(case_id):
        return jsonify({'error': 'Case not found'}), 404
    events = legal_ledger.list_audit_events(case_id=case_id, external_user_id=_ledger_actor())
    return jsonify({'audit_events': events, 'count': len(events)}), 200

# Static routes
@app.route('/')
def index():
    return send_from_directory('frontend', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('frontend', path)


def _safe_local_return_to(return_to):
    candidate = str(return_to or '/dashboard_dark.html').strip()
    parsed = urlsplit(candidate)
    if parsed.scheme or parsed.netloc or not parsed.path.startswith('/') or candidate.startswith('//'):
        return '/dashboard_dark.html'
    return candidate


def _google_oauth_result_page(return_to, status, message=None):
    return_to = _safe_local_return_to(return_to)
    status_text = 'Google connected' if status == 'connected' else 'Google connection needs attention'
    message_text = message or (
        'Google is connected. LARO can now pull Gmail and Drive evidence.'
        if status == 'connected'
        else 'Google OAuth did not complete.'
    )
    payload = {
        'type': 'laro-google-oauth',
        'status': status,
        'message': message_text,
        'returnTo': return_to,
    }
    return render_template_string("""
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{{ status_text }}</title>
    <style>
        body {
            align-items: center;
            background: #070d1a;
            color: #f4f7fb;
            display: flex;
            font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            justify-content: center;
            margin: 0;
            min-height: 100vh;
        }
        main {
            background: #0b1528;
            border: 1px solid #22314c;
            border-radius: 8px;
            max-width: 520px;
            padding: 1.35rem;
            width: calc(100% - 2rem);
        }
        h1 { font-size: 1.35rem; margin: 0 0 0.55rem; }
        p { color: #9aa8bf; line-height: 1.5; margin: 0 0 1rem; }
        .actions { display: flex; flex-wrap: wrap; gap: 0.65rem; }
        button, a {
            border-radius: 8px;
            cursor: pointer;
            display: inline-flex;
            font: inherit;
            font-weight: 800;
            min-height: 40px;
            padding: 0.6rem 0.9rem;
            text-decoration: none;
        }
        button {
            background: #ff6b00;
            border: 1px solid #ff6b00;
            color: #fff;
        }
        a {
            background: transparent;
            border: 1px solid #22314c;
            color: #f4f7fb;
        }
    </style>
</head>
<body>
    <main>
        <h1>{{ status_text }}</h1>
        <p>{{ message_text }}</p>
        <div class="actions">
            <button id="closeWindow" type="button">Close</button>
            <a id="returnLink" href="{{ return_to }}">Return to LARO</a>
        </div>
    </main>
    <script>
        const payload = {{ payload|tojson }};
        if (window.opener && !window.opener.closed) {
            window.opener.postMessage(payload, window.location.origin);
        }
        document.getElementById("closeWindow").addEventListener("click", () => {
            window.close();
            if (!window.closed) window.location.href = payload.returnTo || "/dashboard_dark.html";
        });
        if (payload.status === "connected" && window.opener && !window.opener.closed) {
            window.setTimeout(() => window.close(), 900);
        }
    </script>
</body>
</html>
""", status_text=status_text, message_text=message_text, return_to=return_to, payload=payload)


def _dashboard_redirect(return_to, status, message=None, popup=False):
    target = _safe_local_return_to(return_to)
    if popup:
        return _google_oauth_result_page(target, status, message)
    separator = '&' if '?' in target else '?'
    params = {'google': status}
    if message:
        params['message'] = message
    return redirect(f"{target}{separator}{urlencode(params)}")


@app.route('/api/google/oauth/status', methods=['GET'])
@auth_system._require_auth
def google_oauth_status():
    """Expose Google OAuth connection state for auto-updating dashboard UI."""
    user_key = _ledger_actor()
    connection = legal_ledger.get_external_connection(user_key, 'google') or {}
    credential_vault = google_token_store.status(user_key, 'google')
    connected = bool(connection.get('connected') or connection.get('status') == 'connected')
    config = google_oauth_config()
    return jsonify({
        'configured': config['configured'],
        'connected': connected,
        'connected_at': connection.get('connected_at'),
        'scopes': connection.get('scopes') or GOOGLE_SCOPES,
        'authorize_url': '/api/google/oauth/start',
        'status_source': 'legal_ledger',
        'credential_vault': credential_vault,
        'message': (
            'Google OAuth is connected.'
            if connected
            else 'Google OAuth is ready.' if config['configured']
            else 'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI to enable Google OAuth.'
        )
    }), 200


@app.route('/api/google/oauth/start', methods=['GET'])
def start_google_oauth():
    """Start the real Google OAuth authorization-code flow."""
    return_to = _safe_local_return_to(request.args.get('return_to'))
    popup = request.args.get('popup') in {'1', 'true', 'yes'}
    if not session.get('user_email'):
        return _dashboard_redirect(return_to, 'oauth_error', 'Authenticate with LARO before connecting Google.', popup=popup)
    state = build_google_oauth_state()
    session['google_oauth_state'] = state
    session['google_oauth_return_to'] = return_to
    session['google_oauth_popup'] = popup

    try:
        return redirect(build_google_oauth_url(state))
    except ValueError as exc:
        return _dashboard_redirect(return_to, 'oauth_unconfigured', str(exc), popup=popup)


@app.route('/api/google/oauth/callback', methods=['GET'])
def google_oauth_callback():
    """Receive the Google OAuth callback and mark the session as connected."""
    return_to = session.get('google_oauth_return_to', '/dashboard_dark.html')
    popup = bool(session.get('google_oauth_popup'))
    expected_state = session.get('google_oauth_state')
    received_state = request.args.get('state')

    if not session.get('user_email'):
        return _dashboard_redirect(return_to, 'oauth_error', 'The LARO session expired before Google OAuth completed.', popup=popup)

    if request.args.get('error'):
        return _dashboard_redirect(return_to, 'oauth_error', request.args.get('error'), popup=popup)

    if not expected_state or expected_state != received_state:
        return _dashboard_redirect(return_to, 'oauth_error', 'Invalid OAuth state', popup=popup)

    code = request.args.get('code')
    if not code:
        return _dashboard_redirect(return_to, 'oauth_error', 'Missing authorization code', popup=popup)

    try:
        token_response = exchange_google_oauth_code(code)
    except Exception as exc:
        logger.exception('Google OAuth token exchange failed')
        return _dashboard_redirect(return_to, 'oauth_error', f'Token exchange failed: {exc}', popup=popup)

    user_key = _ledger_actor()
    try:
        google_token_store.save(user_key, 'google', token_response)
    except TokenStoreError as exc:
        logger.warning('Google OAuth token could not be stored in the local encrypted vault: %s', exc)
        return _dashboard_redirect(return_to, 'oauth_error', 'Google credentials could not be stored securely on this device.', popup=popup)

    legal_ledger.save_external_connection(
        user_key,
        'google',
        email=session.get('user_email'),
        status='connected',
        scopes=GOOGLE_SCOPES,
        token_response=token_response,
        metadata={'oauth_flow': 'authorization_code'},
        actor=user_key,
    )
    session.pop('google_oauth_state', None)
    session.pop('google_oauth_return_to', None)
    session.pop('google_oauth_popup', None)
    return _dashboard_redirect(return_to, 'connected', popup=popup)

# API routes for case matching
@app.route('/api/case/analyze', methods=['POST'])
@auth_system._require_auth
def analyze_case():
    data = request.json
    
    if 'case_description' not in data:
        return jsonify({'error': 'Case description is required'}), 400
    
    case_description = data['case_description']
    
    # Analyze case with AI
    matched_fields = case_matcher.match_legal_fields(case_description)
    complexity = case_matcher.analyze_case_complexity(case_description)
    summary = case_matcher.generate_case_summary(case_description)
    
    # Store case data durably in the legal ledger. Older prototype routes read
    # through the ledger compatibility helpers instead of a transient mirror.
    ledger_user_id = _ledger_actor()
    user_id = session.get('user_id', ledger_user_id)
    primary_field = _field_id(matched_fields[0]) if matched_fields else 'unknown'
    ledger_case = legal_ledger.create_case({
        'user_id': ledger_user_id,
        'user_email': session.get('user_email'),
        'title': data.get('title') or f"{primary_field} case",
        'description': case_description,
        'legal_domain': primary_field,
        'current_summary': summary,
        'risk_level': complexity.get('complexity_level', 'Medium').lower(),
        'status': 'pending',
    }, actor=_ledger_actor())
    case_id = ledger_case['case_id']
    
    # Publish case created event for serverless processing
    publish_event('case.created', {
        'case_id': case_id,
        'case_data': {
            'description': case_description,
            'user_id': user_id,
            'legal_fields': matched_fields
        }
    })
    
    # Record case creation event in time-series database
    timeseries_manager.record_case_event(
        case_id=str(case_id),
        event_type='created',
        category=matched_fields[0] if matched_fields else 'UNKNOWN',
        user_id=str(user_id),
        details={
            'complexity': complexity,
            'field_count': len(matched_fields)
        }
    )
    
    # Invalidate cache for cases
    db_manager.invalidate_cache('cases')
    
    return jsonify({
        'case_id': case_id,
        'matched_fields': matched_fields,
        'complexity': complexity,
        'summary': summary
    }), 201

# API routes for document aggregation
@app.route('/api/documents/aggregate', methods=['POST'])
@auth_system._require_auth
def aggregate_documents():
    data = request.json

    if 'case_id' not in data:
        return jsonify({'error': 'Case ID is required'}), 400
    
    case_id = data['case_id']
    user_id = session.get('user_id', 0)
    
    # Imported material is always attached to a persisted legal case.
    ledger_case = legal_ledger.get_case(case_id)
    if not ledger_case:
        return jsonify({'error': 'Case not found'}), 404
    legacy_google_sources = {'gmail', 'gdrive', 'google_drive'}
    if str(data.get('source') or '').strip().lower() in legacy_google_sources:
        return jsonify({
            'error': 'Google imports require the case-level read-only connector.',
            'next_action': 'Connect Google, then use POST /api/cases/<case_id>/documents/pull-google with an explicit query.',
            'read_only': True,
        }), 409
    # Create document aggregator
    aggregator = DocumentAggregator(case_id=case_id, user_id=user_id)
    max_items = data.get('max_items', 80)
    sort_order = str(data.get('sort_order', 'newest') or 'newest').strip().lower()
    days_back = data.get('days_back')

    def _coerce_int(raw, fallback=1, min_value=1, max_value=500):
        try:
            if raw is None:
                return fallback
            value = int(raw)
            if value < min_value:
                return min_value
            if value > max_value:
                return max_value
            return value
        except (TypeError, ValueError):
            return fallback

    def _parse_datetime(value):
        if not value:
            return None
        if isinstance(value, (datetime.datetime, datetime.date)):
            parsed = datetime.datetime.fromisoformat(str(value))
            return parsed.replace(tzinfo=None)
        if isinstance(value, (int, float)):
            try:
                return datetime.datetime.fromtimestamp(value / 1000 if value > 1e12 else value)
            except (OverflowError, OSError, ValueError, TypeError):
                return None
        parsed = None
        if isinstance(value, str):
            try:
                parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                pass
        if isinstance(parsed, datetime.datetime):
            parsed = parsed.replace(tzinfo=None)
        return parsed

    def _filter_by_days(items):
        if days_back is None:
            return items
        cutoff_days = _coerce_int(days_back, 3650, 1, 3650)
        cutoff = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) - datetime.timedelta(days=cutoff_days)
        filtered = []
        for item in items:
            raw_date = (
                item.get('date')
                or item.get('event_date')
                or item.get('created_at')
                or item.get('upload_date')
                or item.get('published')
                or item.get('timestamp')
            )
            parsed = _parse_datetime(raw_date)
            if not parsed or parsed >= cutoff:
                filtered.append(item)
        return filtered

    max_items = _coerce_int(max_items, 80, 10, 300)
    if sort_order not in {'newest', 'oldest'}:
        sort_order = 'newest'

    # Process documents based on source
    if data.get('source') == 'gmail':
        emails = aggregator.fetch_emails('gmail', data.get('query', ''), max_emails=max_items)
        emails = _filter_by_days(emails)
        emails = sorted(
            emails,
            key=lambda item: _parse_datetime(
                item.get('date')
                or item.get('created_at')
                or item.get('upload_date')
                or ''
            ) or datetime.datetime.min,
            reverse=(sort_order == 'newest')
        )[:max_items]
    elif data.get('source') == 'outlook':
        emails = aggregator.fetch_emails('outlook', data.get('query', ''), max_emails=max_items)
        emails = _filter_by_days(emails)
        emails = sorted(
            emails,
            key=lambda item: _parse_datetime(
                item.get('date')
                or item.get('created_at')
                or item.get('upload_date')
                or ''
            ) or datetime.datetime.min,
            reverse=(sort_order == 'newest')
        )[:max_items]
    elif data.get('source') == 'gdrive':
        files = aggregator.fetch_cloud_files('gdrive', data.get('folder_path'))
        files = _filter_by_days(files)
        files = sorted(
            files,
            key=lambda item: _parse_datetime(
                item.get('date')
                or item.get('created_at')
                or item.get('upload_date')
                or ''
            ) or datetime.datetime.min,
            reverse=(sort_order == 'newest')
        )[:max_items]
    elif data.get('source') == 'onedrive':
        files = aggregator.fetch_cloud_files('onedrive', data.get('folder_path'))
        files = _filter_by_days(files)
        files = sorted(
            files,
            key=lambda item: _parse_datetime(
                item.get('date')
                or item.get('created_at')
                or item.get('upload_date')
                or ''
            ) or datetime.datetime.min,
            reverse=(sort_order == 'newest')
        )[:max_items]
    elif data.get('source') == 'manual' and 'file_path' in data:
        document = aggregator.process_manual_upload(data['file_path'], data.get('document_name'))
    
    # Generate evidence trail
    evidence_trail = aggregator.generate_evidence_trail()
    evidence_timeline = aggregator.generate_evidence_timeline()
    
    # Generate red line thread
    red_line_thread = aggregator.generate_red_line_thread()
    
    # Calculate resource usage
    resource_usage = aggregator.calculate_resource_usage()
    
    # Store documents
    case_documents = aggregator.get_all_documents()
    legacy_document_analysis = {
        doc.get('document_id'): doc.get('legal_analysis', {})
        for doc in case_documents
    }

    persisted_documents = []
    persisted_events = []
    persisted_evidence_links = []
    persisted_claims = []
    persisted_deadlines = []
    persisted_obligations = []
    persisted_open_loops = []
    persisted_contradictions = []
    persisted_missing_evidence = []
    for doc in case_documents:
        analysis = doc.get('legal_analysis') or {}
        persisted = legal_ledger.add_document(case_id, {
            'source_type': doc.get('source', data.get('source', 'unknown')),
            'source_uri': doc.get('source_url') or doc.get('web_view_link') or '',
            'original_filename': doc.get('document_name') or doc.get('name') or '',
            'document_type': doc.get('document_type', 'unknown'),
            'title': doc.get('document_name') or doc.get('name') or 'Evidence document',
            'extracted_text': doc.get('content', ''),
            'summary': doc.get('content_summary') or doc.get('summary') or '',
            'relevance_score': analysis.get('evidence', {}).get('relevance_score', 0),
            'metadata': {
                'legal_analysis': analysis,
                'aggregation_source_id': doc.get('document_id') or doc.get('id'),
                'aggregation_source': data.get('source', doc.get('source', 'unknown')),
                'aggregation_query': data.get('query') or data.get('folder_path') or '',
            },
            'extraction_method': f"document_aggregation_{data.get('source', doc.get('source', 'unknown'))}",
        }, actor=_ledger_actor())
        if persisted:
            persisted_documents.append(persisted)
            artifacts = _analysis_artifacts_for_document(case_id, persisted, analysis, _ledger_actor(), data)
            persisted_events.extend(artifacts.get('timeline_suggestions', []))
            persisted_evidence_links.extend(artifacts.get('evidence_links', []))
            persisted_claims.extend(artifacts.get('claim_suggestions', []))
            persisted_deadlines.extend(artifacts.get('deadline_suggestions', []))
            persisted_obligations.extend(artifacts.get('obligation_suggestions', []))
            persisted_open_loops.extend(artifacts.get('open_loop_suggestions', []))
            persisted_contradictions.extend(artifacts.get('contradiction_suggestions', []))
            persisted_missing_evidence.extend(artifacts.get('missing_evidence_suggestions', []))

    # Process each document with serverless function
    for doc in case_documents:
        # Publish document for serverless processing
        publish_event('document.uploaded', {
            'document_id': doc['document_id'],
            'document_data': {
                'case_id': case_id,
                'document_name': doc.get('document_name'),
                'content': doc.get('content', ''),
                'type': doc.get('document_type', 'UNKNOWN'),
                'document_type': doc.get('document_type', 'UNKNOWN'),
                'source': doc.get('source', 'unknown'),
                'source_url': doc.get('source_url')
            }
        })
    
    # Record document aggregation event in time-series database
    timeseries_manager.record_case_event(
        case_id=str(case_id),
        event_type='documents_aggregated',
        category=ledger_case.get('legal_domain') or 'UNKNOWN',
        user_id=str(user_id),
        details={
            'document_count': len(case_documents),
            'source': data.get('source', 'unknown'),
            'processing_time_ms': resource_usage.get('processing_time_ms', 0)
        }
    )
    
    # Invalidate cache for documents
    db_manager.invalidate_cache('documents')
    
    return jsonify({
        'case_id': case_id,
        'document_count': len(case_documents),
        'evidence_trail': evidence_trail,
        'evidence_timeline': evidence_timeline,
        'red_line_thread': red_line_thread,
        'document_analysis': legacy_document_analysis,
        'persisted_documents': persisted_documents,
        'persisted_timeline': persisted_events,
        'persisted_evidence_links': persisted_evidence_links,
        'persisted_claims': persisted_claims,
        'persisted_deadlines': persisted_deadlines,
        'persisted_obligations': persisted_obligations,
        'persisted_open_loops': persisted_open_loops,
        'persisted_contradictions': persisted_contradictions,
        'persisted_missing_evidence': persisted_missing_evidence,
        'comprehension': legal_ledger.case_comprehension_dossier(case_id),
        'resource_usage': resource_usage
    }), 200

@app.route('/api/documents/<int:case_id>', methods=['GET'])
@auth_system._require_auth
def get_documents(case_id):
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    ledger_documents = legal_ledger.list_documents(case_id)
    user_id = session.get('user_id', 0)
    timeseries_manager.record_user_activity(
        user_id=str(user_id),
        activity_type='view',
        resource='documents',
        details={
            'case_id': case_id,
            'document_count': len(ledger_documents),
            'storage': 'legal_ledger',
        }
    )
    return jsonify({
        'case_id': case_id,
        'documents': ledger_documents,
        'storage': 'legal_ledger',
    }), 200

@app.route('/api/documents/<int:case_id>/analysis', methods=['GET'])
@auth_system._require_auth
def get_document_analysis(case_id):
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    analyses = _ledger_document_analysis_snapshot(case_id)
    return jsonify({
        'case_id': case_id,
        'document_count': len(analyses),
        'analysis': analyses,
        'storage': 'legal_ledger',
    }), 200

@app.route('/api/documents/<int:case_id>/timeline', methods=['GET'])
@auth_system._require_auth
def get_evidence_timeline(case_id):
    if not legal_ledger.get_case(case_id):
        return jsonify({'error': 'Case not found'}), 404
    ledger_timeline = legal_ledger.list_timeline(case_id)
    comprehension = legal_ledger.case_comprehension_dossier(case_id) or {}
    return jsonify({
        'case_id': case_id,
        'event_count': len(ledger_timeline),
        'timeline': ledger_timeline,
        'source_linked_timeline': comprehension.get('chronology', []),
        'storage': 'legal_ledger',
    }), 200


@app.route('/api/lawyers/taxonomy', methods=['GET'])
@auth_system._require_auth
def get_lawyer_matching_taxonomy():
    """Expose the official NOvA-area vocabulary used by case matching."""
    return jsonify(public_taxonomy()), 200


@app.route('/api/lawyers/match', methods=['POST'])
@auth_system._require_auth
def match_case_lawyers():
    data = request.json or {}

    if 'case_id' not in data:
        return jsonify({'error': 'Case ID is required'}), 400

    try:
        case_id = int(data['case_id'])
    except (TypeError, ValueError):
        return jsonify({'error': 'Case ID must be a number'}), 400
    if not _ledger_case_access_allowed(case_id):
        return jsonify({'error': 'Case not found'}), 404
    ledger_case, legacy_case = _case_for_legacy_endpoint(case_id)
    if not legacy_case:
        return jsonify({'error': 'Case not found'}), 404

    case_data = _case_matching_payload(ledger_case, legacy_case, data)

    from serverless_functions import match_lawyers
    result = match_lawyers({
        'case_id': case_id,
        'case_data': case_data,
        'match_preferences': case_data,
        'candidate_lawyers': data.get('candidate_lawyers') or data.get('lawyers'),
        'max_results': data.get('max_results', 30)
    }, {})

    if result.get('statusCode') != 200:
        return jsonify(result.get('body', {'error': 'Unable to match lawyers'})), result.get('statusCode', 500)

    result['body'].setdefault('case_profile', case_data.get('case_profile') or {})

    legal_ledger.save_match_result(
        case_id,
        'lawyers',
        result['body'],
        criteria=case_data,
        actor=_ledger_actor(),
        source=result['body'].get('source_mode') or 'serverless_matching',
    )
    return jsonify(result['body']), 200

@app.route('/api/lawyers/<int:case_id>/matches', methods=['GET'])
@auth_system._require_auth
def get_case_lawyer_matches(case_id):
    persisted = legal_ledger.get_match_result(case_id, 'lawyers')
    if persisted:
        return jsonify(persisted.get('payload') or {}), 200

    return jsonify({'error': 'No lawyer matches found for this case'}), 404


@app.route('/api/outreach/directory/targets', methods=['GET'])
@auth_system._require_auth
def list_outreach_directory_targets():
    target_type = request.args.get('target_type') or request.args.get('category')
    status = request.args.get('status')
    try:
        targets = legal_ledger.list_outreach_directory_targets(target_type=target_type, status=status)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    return jsonify({'targets': targets, 'count': len(targets)}), 200


@app.route('/api/outreach/directory/import', methods=['POST'])
@auth_system._require_auth
def import_outreach_directory_targets():
    data = request.get_json(silent=True)
    records = data if isinstance(data, list) else (data or {}).get('targets') or (data or {}).get('records') or []
    if not isinstance(records, list) or not records:
        return jsonify({'error': 'Provide a non-empty targets list'}), 400
    try:
        targets = legal_ledger.import_outreach_directory_targets(records, actor=_ledger_actor())
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    return jsonify({
        'targets': targets,
        'count': len(targets),
        'status': 'needs_review',
        'message': 'Imported targets need review before matching can use them.',
    }), 201


@app.route('/api/outreach/directory/discover', methods=['POST'])
@auth_system._require_auth
def discover_outreach_directory_targets():
    """Search public web results only after an explicit local user action.

    The submitted query is the only value sent to the external search provider;
    candidate results are immediately placed behind the directory review gate.
    """
    data = request.get_json(silent=True) or {}
    if not data.get('confirm_external_search'):
        return jsonify({'error': 'Confirm the external query before searching public sources'}), 400
    try:
        discovery = OutreachTargetDiscovery().discover(
            target_type=data.get('target_type') or data.get('category'),
            query=data.get('query'),
            limit=data.get('limit') or data.get('max_results') or 10,
        )
        targets = legal_ledger.import_outreach_directory_targets(
            discovery['candidates'],
            actor=_ledger_actor(),
            audit_source='web_search',
            audit_action='discovered_for_review',
        ) if discovery['candidates'] else []
    except (OutreachDiscoveryError, ValueError) as exc:
        return jsonify({'error': str(exc)}), 400
    return jsonify({
        **{key: value for key, value in discovery.items() if key != 'candidates'},
        'targets': targets,
        'count': len(targets),
        'status': 'needs_review',
        'message': 'Public search candidates were added for review. Only approved records can be matched.',
    }), 201


@app.route('/api/outreach/directory/discover-case', methods=['POST'])
@auth_system._require_auth
def discover_case_outreach_directory_targets():
    """Build a sourced review queue from privacy-safe case-area queries."""
    data = request.get_json(silent=True) or {}
    if not data.get('confirm_external_search'):
        return jsonify({'error': 'Confirm the derived external queries before searching public sources'}), 400
    try:
        case_id = int(data.get('case_id'))
    except (TypeError, ValueError):
        return jsonify({'error': 'Case ID must be a number'}), 400
    if not _ledger_case_access_allowed(case_id):
        return jsonify({'error': 'Case not found'}), 404

    ledger_case, legacy_case = _case_for_legacy_endpoint(case_id)
    if not legacy_case:
        return jsonify({'error': 'Case not found'}), 404
    case_data = _case_matching_payload(ledger_case, legacy_case, data)
    target_type = data.get('target_type') or data.get('category')
    try:
        discovery = OutreachTargetDiscovery().discover_for_case(
            target_type=target_type,
            legal_fields=case_data.get('legal_fields') or [],
            limit=data.get('limit') or data.get('max_results') or 40,
            max_queries=data.get('max_queries') or 6,
        )
        targets = legal_ledger.import_outreach_directory_targets(
            discovery['candidates'],
            actor=_ledger_actor(),
            audit_source='case_web_search',
            audit_action='case_discovered_for_review',
        ) if discovery['candidates'] else []
    except (OutreachDiscoveryError, ValueError) as exc:
        legal_ledger.record_case_activity(
            case_id,
            'outreach_directory_case_discovery_failed',
            actor=_ledger_actor(),
            source='case_web_search',
            details={
                'target_type': str(target_type or '').strip().lower(),
                'legal_fields': case_data.get('legal_fields') or [],
                'error': str(exc),
                'raw_case_text_shared': False,
            },
            risk_level='low',
        )
        return jsonify({'error': str(exc)}), 400

    coverage = discovery.get('coverage') or {}
    legal_ledger.record_case_activity(
        case_id,
        'outreach_directory_case_discovery',
        actor=_ledger_actor(),
        source='case_web_search',
        details={
            'target_type': str(target_type or '').strip().lower(),
            'provider': discovery.get('provider'),
            'planned_query_count': coverage.get('planned_query_count', 0),
            'completed_query_count': coverage.get('completed_query_count', 0),
            'failed_query_count': coverage.get('failed_query_count', 0),
            'candidate_count': len(targets),
            'legal_fields': coverage.get('legal_fields') or [],
            'raw_case_text_shared': False,
        },
        risk_level='low',
    )
    return jsonify({
        **{key: value for key, value in discovery.items() if key != 'candidates'},
        'targets': targets,
        'count': len(targets),
        'status': 'needs_review',
        'case_id': case_id,
        'case_profile': {
            'selected_legal_fields': case_data.get('legal_fields') or [],
            'source_coverage': case_data.get('case_source_coverage') or {},
            'raw_case_text_shared': False,
        },
        'message': 'Case-aware public candidates were added for review. Only approved records can be matched.',
    }), 201


@app.route('/api/outreach/directory/targets/<int:target_id>', methods=['PATCH'])
@auth_system._require_auth
def update_outreach_directory_target(target_id):
    try:
        target = legal_ledger.update_outreach_directory_target(target_id, request.json or {}, actor=_ledger_actor())
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if not target:
        return jsonify({'error': 'Outreach directory target not found'}), 404
    return jsonify(target), 200


@app.route('/api/outreach/targets/match', methods=['POST'])
@auth_system._require_auth
def match_case_outreach_targets():
    data = request.json or {}

    if 'case_id' not in data:
        return jsonify({'error': 'Case ID is required'}), 400

    try:
        case_id = int(data['case_id'])
    except (TypeError, ValueError):
        return jsonify({'error': 'Case ID must be a number'}), 400
    if not _ledger_case_access_allowed(case_id):
        return jsonify({'error': 'Case not found'}), 404
    ledger_case, legacy_case = _case_for_legacy_endpoint(case_id)
    if not legacy_case:
        return jsonify({'error': 'Case not found'}), 404

    target_type = str(data.get('target_type') or data.get('category') or 'media').strip().lower()
    case_data = {
        **_case_matching_payload(ledger_case, legacy_case, data),
        'target_type': target_type,
    }

    candidate_targets = data.get('candidate_targets') or data.get('targets')
    candidate_source_mode = None
    candidate_source_details = None
    if candidate_targets is None:
        try:
            approved_targets = legal_ledger.list_outreach_directory_targets(target_type=target_type, status='approved')
        except ValueError as exc:
            return jsonify({'error': str(exc)}), 400
        if approved_targets:
            candidate_targets = approved_targets
            candidate_source_mode = 'approved_directory'
            candidate_source_details = {
                'source': 'LARO reviewed outreach directory',
                'approved_target_count': len(approved_targets),
            }

    from serverless_functions import match_outreach_targets
    result = match_outreach_targets({
        'case_id': case_id,
        'case_data': case_data,
        'target_type': target_type,
        'candidate_targets': candidate_targets,
        'candidate_source_mode': candidate_source_mode,
        'candidate_source_details': candidate_source_details,
        'max_results': data.get('max_results', 30)
    }, {})

    if result.get('statusCode') != 200:
        return jsonify(result.get('body', {'error': 'Unable to match outreach targets'})), result.get('statusCode', 500)

    result['body'].setdefault('case_profile', case_data.get('case_profile') or {})

    legal_ledger.save_match_result(
        case_id,
        target_type,
        result['body'],
        criteria=case_data,
        actor=_ledger_actor(),
        source=result['body'].get('source_mode') or 'serverless_matching',
    )
    return jsonify(result['body']), 200

@app.route('/api/outreach/<int:case_id>/targets/<target_type>', methods=['GET'])
@auth_system._require_auth
def get_case_outreach_target_matches(case_id, target_type):
    normalized_type = str(target_type or '').strip().lower()
    persisted = legal_ledger.get_match_result(case_id, normalized_type)
    if persisted:
        return jsonify(persisted.get('payload') or {}), 200

    return jsonify({'error': f'No {normalized_type} outreach matches found for this case'}), 404

@app.route('/api/outreach/<int:case_id>/analytics', methods=['GET'])
@auth_system._require_auth
def get_case_outreach_analytics(case_id):
    ledger_case, legacy_case = _case_for_legacy_endpoint(case_id)
    if not legacy_case:
        return jsonify({'error': 'Case not found'}), 404

    outreach_snapshot = _ledger_outreach_snapshot(case_id)
    persisted_matches = {
        item['match_type']: item.get('payload') or {}
        for item in legal_ledger.list_match_results(case_id)
    }
    target_match_results = {
        key: value
        for key, value in persisted_matches.items()
        if key != 'lawyers'
    }
    analytics = build_outreach_analytics(
        case_id=case_id,
        outreach_campaign=outreach_snapshot,
        lawyer_match_result=persisted_matches.get('lawyers'),
        target_match_results=target_match_results
    )
    return jsonify(analytics), 200

# API routes for lawyer outreach
@app.route('/api/outreach/start', methods=['POST'])
@auth_system._require_auth
def start_outreach():
    data = request.json or {}

    if 'case_id' not in data or 'legal_field' not in data:
        return jsonify({'error': 'Case ID and legal field are required'}), 400

    try:
        case_id = int(data['case_id'])
    except (TypeError, ValueError):
        return jsonify({'error': 'Case ID must be a number'}), 400
    if not _ledger_case_access_allowed(case_id):
        return jsonify({'error': 'Case not found'}), 404
    legal_field = data['legal_field']
    user_id = session.get('user_id', 0)
    ledger_case, legacy_case = _case_for_legacy_endpoint(case_id)
    if not legacy_case:
        return jsonify({'error': 'Case not found'}), 404

    case_summary = (
        legacy_case.get('summary')
        or (ledger_case or {}).get('current_summary')
        or (ledger_case or {}).get('description')
        or legacy_case.get('case_description', '')
    )
    max_lawyers = int(data.get('max_lawyers', 30) or 30)

    # Match lawyers using serverless function, but never send from this route.
    from serverless_functions import match_lawyers
    match_preferences = {
        'postcode_or_city': data.get('postcode_or_city') or data.get('location') or legacy_case.get('postcode_or_city', ''),
        'radius_km': data.get('radius_km') or data.get('search_radius_km') or 50,
        'requires_financed_legal_aid': data.get('requires_financed_legal_aid', False),
        'prefer_specialization_association': data.get('prefer_specialization_association', True),
        'evidence_topics': data.get('evidence_topics', []),
        'max_results': max_lawyers
    }
    lawyer_matching_result = match_lawyers({
        'case_id': case_id,
        'case_data': {
            'legal_fields': [legal_field],
            'summary': case_summary,
            'description': legacy_case.get('case_description', ''),
            'complexity': legacy_case.get('complexity', {})
        },
        'match_preferences': match_preferences,
        'candidate_lawyers': data.get('candidate_lawyers') or data.get('lawyers'),
        'max_results': max_lawyers
    }, {})

    matched_lawyers = []
    if lawyer_matching_result.get('statusCode') == 200:
        lawyer_match_payload = lawyer_matching_result.get('body', {})
        matched_lawyers = lawyer_match_payload.get('matched_lawyers', [])
        legal_ledger.save_match_result(
            case_id,
            'lawyers',
            lawyer_match_payload,
            criteria={
                'case_data': {
                    'legal_fields': [legal_field],
                    'summary': case_summary,
                    'description': legacy_case.get('case_description', ''),
                    'complexity': legacy_case.get('complexity', {})
                },
                'match_preferences': match_preferences,
                'max_results': max_lawyers,
            },
            actor=_ledger_actor(),
            source=lawyer_match_payload.get('source_mode') or 'serverless_matching',
        )

    outreach_drafts = []
    for lawyer in matched_lawyers[:max_lawyers]:
        lawyer_name = (
            lawyer.get('name')
            or lawyer.get('lawyer_name')
            or ' '.join(part for part in [lawyer.get('first_name'), lawyer.get('last_name')] if part)
            or 'Unknown lawyer'
        )
        lawyer_email = lawyer.get('email') or lawyer.get('lawyer_email') or lawyer.get('contact_email')
        if not lawyer_email:
            continue
        draft = legal_ledger.create_outreach_draft(case_id, {
            'lawyer_name': lawyer_name,
            'lawyer_email': lawyer_email,
            'legal_field': legal_field,
            'subject': f'Draft case inquiry: {legal_field}',
            'draft_body': (
                'Draft only. Do not send without explicit approval.\n\n'
                f'Legal field: {legal_field}\n\n'
                f'Case summary:\n{case_summary or "No case summary recorded yet."}'
            )
        }, actor=_ledger_actor())
        if draft:
            draft['match_score'] = lawyer.get('score') or lawyer.get('match_score')
            outreach_drafts.append(draft)

    timeseries_manager.record_case_event(
        case_id=str(case_id),
        event_type='outreach_drafts_prepared',
        category=legal_field,
        user_id=str(user_id),
        details={
            'draft_count': len(outreach_drafts),
            'matched_lawyer_count': len(matched_lawyers),
            'max_lawyers': max_lawyers,
            'external_messages_sent': 0,
            'approval_required': True
        }
    )

    return jsonify({
        'case_id': case_id,
        'outreach_count': len(outreach_drafts),
        'draft_count': len(outreach_drafts),
        'matched_lawyer_count': len(matched_lawyers),
        'external_messages_sent': 0,
        'approval_required': True,
        'status': 'waiting_approval',
        'legal_field': legal_field,
        'drafts': outreach_drafts
    }), 200

@app.route('/api/outreach/<int:case_id>/status', methods=['GET'])
@auth_system._require_auth
def get_outreach_status(case_id):
    ledger_outreach = legal_ledger.list_outreach(case_id)
    ledger_responses = legal_ledger.list_lawyer_responses(case_id)
    if not ledger_outreach:
        return jsonify({'error': 'No outreach campaign found for this case'}), 404
    statuses = [item.get('status') for item in ledger_outreach]
    response_types = [item.get('response_type') for item in ledger_responses]
    stats = {
        'total_outreach': len(ledger_outreach),
        'waiting_approval': sum(1 for status in statuses if status == 'waiting_approval'),
        'approved_to_send': sum(1 for status in statuses if status == 'approved_to_send'),
        'approval_rejected': sum(1 for status in statuses if status == 'approval_rejected'),
        'sent': sum(1 for status in statuses if status == 'sent'),
        'responses_received': len(ledger_responses),
        'interested_lawyers_count': sum(1 for response_type in response_types if response_type == 'interested'),
        'more_info_requests': sum(1 for response_type in response_types if response_type == 'more_info'),
        'unavailable_responses': sum(1 for response_type in response_types if response_type in {'unavailable', 'rejected'}),
        'external_messages_sent': 0,
        'approval_required': True,
    }
    return jsonify({
        'case_id': case_id,
        'statistics': stats,
        'responses': ledger_responses,
        'accepted_cases': [],
        'outreach_records': ledger_outreach,
        'approval_required': True,
        'external_messages_sent': 0,
    }), 200

@app.route('/api/outreach/<int:case_id>/follow-up', methods=['POST'])
@auth_system._require_auth
def send_follow_ups(case_id):
    ledger_outreach = legal_ledger.list_outreach(case_id)
    if not ledger_outreach:
        return jsonify({'error': 'No outreach campaign found for this case'}), 404

    return jsonify({
        'case_id': case_id,
        'error': 'Follow-ups require approval-gated ledger drafts before any external legal communication.',
        'follow_ups_sent': 0,
        'external_messages_sent': 0,
        'approval_required': True,
        'status': 'blocked_until_approved'
    }), 409

# API routes for user cases
@app.route('/api/user/cases', methods=['GET'])
@auth_system._require_auth
def get_user_cases():
    user_id = session.get('user_id', 0)
    ledger_cases = legal_ledger.list_cases(_ledger_actor())
    timeseries_manager.record_user_activity(
        user_id=str(user_id),
        activity_type='list',
        resource='cases'
    )
    
    return jsonify({
        'user_id': user_id,
        'cases': ledger_cases
    }), 200

@app.route('/api/case/<int:case_id>', methods=['GET'])
@auth_system._require_auth
def get_case(case_id):
    ledger_case = legal_ledger.get_case(case_id)
    if ledger_case:
        user_id = session.get('user_id', 0)
        timeseries_manager.record_user_activity(
            user_id=str(user_id),
            activity_type='view',
            resource='case',
            details={
                'case_id': case_id,
                'category': ledger_case.get('legal_domain', 'unknown')
            }
        )
        return jsonify(ledger_case), 200

    if not ledger_case:
        return jsonify({'error': 'Case not found'}), 404
    return jsonify(ledger_case), 200

# API routes for resource usage and billing
@app.route('/api/billing/<int:case_id>', methods=['GET'])
@auth_system._require_auth
def get_billing(case_id):
    ledger_case, legacy_case = _case_for_legacy_endpoint(case_id)
    if not legacy_case:
        return jsonify({'error': 'Case not found'}), 404
    
    # Calculate resource usage
    resource_usage = {
        'ai_processing_time_ms': 0,
        'storage_bytes_used': 0,
        'email_count': 0,
        'follow_up_count': 0,
        'total_resource_cost': 0,
        'user_charge': 0
    }
    
    # Add document aggregation resource usage
    ledger_documents = legal_ledger.list_documents(case_id)
    resource_usage['storage_bytes_used'] += sum(
        len((document.get('extracted_text') or '').encode('utf-8'))
        for document in ledger_documents
    )
    
    # Calculate user charge (resource cost x 2)
    resource_usage['user_charge'] = resource_usage['total_resource_cost'] * 2
    
    # Record billing check event in time-series database
    user_id = session.get('user_id', 0)
    timeseries_manager.record_user_activity(
        user_id=str(user_id),
        activity_type='check_billing',
        resource='billing',
        details={
            'case_id': case_id,
            'total_cost': resource_usage['user_charge']
        }
    )
    
    return jsonify({
        'case_id': case_id,
        'resource_usage': resource_usage
    }), 200

# API route for metrics dashboard
@app.route('/api/metrics', methods=['GET'])
@auth_system._require_auth
def get_metrics():
    # Get query parameters
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    category = request.args.get('category')
    
    # Convert string dates to datetime objects if provided
    from datetime import datetime
    start_time = datetime.fromisoformat(start_date) if start_date else None
    end_time = datetime.fromisoformat(end_date) if end_date else None
    
    # Get metrics from time-series database
    case_metrics = timeseries_manager.get_case_metrics(
        start_time=start_time,
        end_time=end_time,
        category=category
    )
    
    # Record metrics view event in time-series database
    user_id = session.get('user_id', 0)
    timeseries_manager.record_user_activity(
        user_id=str(user_id),
        activity_type='view',
        resource='metrics',
        details={
            'start_date': start_date,
            'end_date': end_date,
            'category': category
        }
    )
    
    return jsonify(case_metrics), 200

# API route for system metrics
@app.route('/api/system/metrics', methods=['GET'])
@auth_system._require_auth
def get_system_metrics():
    # Get query parameters
    metric_type = request.args.get('type', 'cpu_usage')
    
    # Get system metrics from time-series database
    system_metrics = timeseries_manager.get_system_metrics(
        metric_type=metric_type
    )
    
    # Record system metrics view event in time-series database
    user_id = session.get('user_id', 0)
    timeseries_manager.record_user_activity(
        user_id=str(user_id),
        activity_type='view',
        resource='system_metrics',
        details={
            'metric_type': metric_type
        }
    )
    
    return jsonify(system_metrics), 200

# API route for serverless functions
@app.route('/api/serverless/functions', methods=['GET'])
@auth_system._require_auth
def get_serverless_functions():
    # Get serverless functions from serverless manager
    serverless_manager = app.config.get('serverless_manager')
    if not serverless_manager:
        return jsonify({'error': 'Serverless manager not initialized'}), 500
    
    functions = serverless_manager.list_functions()
    
    return jsonify({
        'functions': functions
    }), 200

# API route for event history
@app.route('/api/serverless/events', methods=['GET'])
@auth_system._require_auth
def get_event_history():
    # Get event type filter
    event_type = request.args.get('type')
    
    # Get event bus from app config
    event_bus = app.config.get('event_bus')
    if not event_bus:
        return jsonify({'error': 'Event bus not initialized'}), 500
    
    # Get event history
    events = event_bus.get_event_history(event_type)
    
    return jsonify({
        'events': events
    }), 200

# Local-first bootstrap for the configured machine owner. The regular password
# login remains registered by authentication.py at /api/auth/login.
@app.route('/api/auth/session-login', methods=['POST'])
def session_login():
    if not _is_loopback_request():
        return jsonify({'error': 'Local session bootstrap is available only from this machine'}), 403

    data = request.get_json(silent=True) or {}
    owner_email = _local_session_owner_email()
    email = str(data.get('email') or owner_email).strip().lower()
    if email != owner_email:
        return jsonify({'error': 'Local session bootstrap is restricted to the configured local account'}), 403

    user_id = int(hashlib.sha256(email.encode('utf-8')).hexdigest()[:8], 16)
    
    # Set user ID in session
    session['user_id'] = user_id
    session['user_email'] = email
    session['user_type'] = 'user'
    session_token = auth_system._create_session(email, 'user')
    
    # Publish user login event for serverless processing
    from serverless_functions import publish_user_login_event
    publish_user_login_event(
        user_id=user_id,
        ip_address=request.remote_addr,
        user_agent=request.headers.get('User-Agent', '')
    )
    
    return jsonify({
        'user_id': user_id,
        'email': email,
        'token': session_token
    }), 200

# User search handler
@app.route('/api/search', methods=['GET'])
@auth_system._require_auth
def search():
    query = request.args.get('q')
    if not query:
        return jsonify({'error': 'Query is required'}), 400
    
    user_id = session.get('user_id', 0)
    
    # Publish user search event for serverless processing
    from serverless_functions import publish_user_search_event
    publish_user_search_event(
        user_id=user_id,
        query=query,
        filters=request.args.to_dict()
    )
    
    try:
        limit = min(100, max(1, int(request.args.get('limit', 50))))
    except (TypeError, ValueError):
        limit = 50
    try:
        case_id = int(request.args.get('case_id')) if request.args.get('case_id') else None
    except (TypeError, ValueError):
        return jsonify({'error': 'case_id must be a number'}), 400

    return jsonify(legal_ledger.search_ledger(
        query,
        external_user_id=_ledger_actor(),
        case_id=case_id,
        limit=limit,
    )), 200

# Error handlers
@app.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Not found'}), 404

@app.errorhandler(500)
def server_error(error):
    logger.error(f"Server error: {error}")
    
    # Record error event in time-series database
    timeseries_manager.record_system_metric(
        metric_type='error',
        value=1.0,
        component='api_server',
        details={
            'error_type': '500',
            'error_message': str(error)
        }
    )
    
    return jsonify({'error': 'Internal server error'}), 500

# Main entry point
if __name__ == '__main__':
    # Record application start event
    timeseries_manager.record_system_metric(
        metric_type='application_start',
        value=1.0,
        component='main',
        details={
            'version': '1.0.0',
            'environment': os.environ.get('FLASK_ENV', 'development')
        }
    )
    
    host = os.environ.get('LARO_HOST', '127.0.0.1').strip()
    if not _is_loopback_host(host):
        raise RuntimeError('LARO only binds to localhost. Use a local reverse proxy only after adding explicit access controls.')
    port = int(os.environ.get('LARO_FLASK_PORT', os.environ.get('PORT', 8768)))
    debug = os.environ.get('LARO_DEBUG', '').strip().lower() in {'1', 'true', 'yes'}
    app.run(host=host, port=port, debug=debug, use_reloader=debug)
