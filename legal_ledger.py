"""
Persistent legal case ledger for LARO.

This module is the local-first operating layer that turns LARO from an
in-memory outreach prototype into a durable legal evidence ledger. It uses
SQLAlchemy with SQLite by default, while keeping the schema portable enough for
future Postgres use.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
from contextlib import contextmanager
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import urlparse

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    create_engine,
    inspect,
    text as sql_text,
)
from sqlalchemy.orm import declarative_base, relationship, scoped_session, sessionmaker


Base = declarative_base()


CLAIM_EVIDENCE_RELATIONSHIPS = {"supports", "disputes", "context"}
CLAIM_POSITION_ROLES = {"client", "counterparty", "institution", "court", "third_party", "source", "unknown"}
CLAIM_MATERIALITY_LEVELS = {"low", "medium", "high", "critical"}


def utcnow() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)


def _json_dump(value: Any) -> str:
    return json.dumps(value if value is not None else {}, ensure_ascii=True, sort_keys=True)


def _json_load(value: Optional[str], fallback: Any = None) -> Any:
    if value in (None, ""):
        return fallback
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return fallback


def _iso(value: Optional[_dt.datetime]) -> Optional[str]:
    return value.isoformat() + "Z" if value else None


class LedgerUser(Base):
    __tablename__ = "ledger_users"

    id = Column(Integer, primary_key=True)
    external_user_id = Column(String(120), nullable=False, unique=True, index=True)
    email = Column(String(255))
    display_name = Column(String(255))
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    cases = relationship("LegalCase", back_populates="user")
    external_connections = relationship("ExternalConnection", back_populates="user", cascade="all, delete-orphan")
    document_inbox_items = relationship("DocumentInboxItem", back_populates="user", cascade="all, delete-orphan")


class ExternalConnection(Base):
    __tablename__ = "external_connections"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("ledger_users.id"), nullable=False, index=True)
    provider = Column(String(80), nullable=False, index=True)
    status = Column(String(80), default="connected", index=True)
    scopes_json = Column(Text, default="[]")
    token_fingerprint = Column(String(128), default="")
    metadata_json = Column(Text, default="{}")
    connected_at = Column(DateTime, default=utcnow, nullable=False)
    disconnected_at = Column(DateTime)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    user = relationship("LedgerUser", back_populates="external_connections")


class LegalCase(Base):
    __tablename__ = "legal_cases"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("ledger_users.id"), nullable=False, index=True)
    title = Column(String(255), nullable=False)
    description = Column(Text, default="")
    legal_domain = Column(String(120), default="unknown")
    status = Column(String(80), default="pending", index=True)
    priority = Column(String(40), default="normal")
    desired_outcome = Column(Text, default="")
    current_summary = Column(Text, default="")
    opposing_parties = Column(Text, default="[]")
    court_or_institution = Column(String(255), default="")
    risk_level = Column(String(40), default="medium")
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)
    archived_at = Column(DateTime)

    user = relationship("LedgerUser", back_populates="cases")
    documents = relationship("CaseDocument", back_populates="case", cascade="all, delete-orphan")
    events = relationship("CaseEvent", back_populates="case", cascade="all, delete-orphan")
    claims = relationship("LegalClaim", back_populates="case", cascade="all, delete-orphan")
    contradictions = relationship("Contradiction", back_populates="case", cascade="all, delete-orphan")
    missing_evidence = relationship("MissingEvidenceWarning", back_populates="case", cascade="all, delete-orphan")
    deadlines = relationship("Deadline", back_populates="case", cascade="all, delete-orphan")
    obligations = relationship("Obligation", back_populates="case", cascade="all, delete-orphan")
    open_loops = relationship("OpenLoop", back_populates="case", cascade="all, delete-orphan")
    outreach = relationship("LawyerOutreach", back_populates="case", cascade="all, delete-orphan")
    identifiers = relationship("CaseIdentifier", back_populates="case", cascade="all, delete-orphan")
    match_results = relationship("MatchResult", back_populates="case", cascade="all, delete-orphan")
    analysis_runs = relationship("CaseAnalysisRun", back_populates="case", cascade="all, delete-orphan")
    analysis_jobs = relationship("CaseAnalysisJob", back_populates="case", cascade="all, delete-orphan")
    analysis_review_items = relationship("CaseAnalysisReviewItem", back_populates="case", cascade="all, delete-orphan")


class CaseIdentifier(Base):
    __tablename__ = "case_identifiers"

    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("legal_cases.id"), nullable=False, index=True)
    identifier_type = Column(String(80), default="external_reference", index=True)
    identifier_value = Column(String(255), nullable=False, index=True)
    source_party = Column(String(255), default="")
    source_type = Column(String(80), default="")
    source_uri = Column(Text, default="")
    notes = Column(Text, default="")
    metadata_json = Column(Text, default="{}")
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    case = relationship("LegalCase", back_populates="identifiers")


class Party(Base):
    __tablename__ = "parties"

    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("legal_cases.id"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    party_type = Column(String(80), default="unknown")
    role = Column(String(120), default="")
    contact = Column(Text, default="{}")
    notes = Column(Text, default="")
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class CaseDocument(Base):
    __tablename__ = "case_documents"

    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("legal_cases.id"), nullable=False, index=True)
    source_type = Column(String(80), default="manual", index=True)
    source_uri = Column(Text, default="")
    original_filename = Column(String(255), default="")
    local_path = Column(Text, default="")
    content_hash = Column(String(128), index=True)
    document_type = Column(String(80), default="unknown", index=True)
    date_on_document = Column(String(40), default="")
    sender = Column(String(255), default="")
    recipient = Column(String(255), default="")
    title = Column(String(255), default="")
    ocr_text = Column(Text, default="")
    extracted_text = Column(Text, default="")
    summary = Column(Text, default="")
    relevance_score = Column(Float, default=0.0)
    confidentiality_level = Column(String(80), default="normal")
    metadata_json = Column(Text, default="{}")
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    case = relationship("LegalCase", back_populates="documents")
    versions = relationship("DocumentVersion", back_populates="document", cascade="all, delete-orphan")


class DocumentVersion(Base):
    __tablename__ = "document_versions"

    id = Column(Integer, primary_key=True)
    document_id = Column(Integer, ForeignKey("case_documents.id"), nullable=False, index=True)
    version_label = Column(String(80), default="initial")
    extraction_method = Column(String(120), default="manual")
    text_hash = Column(String(128), index=True)
    extracted_text = Column(Text, default="")
    metadata_json = Column(Text, default="{}")
    created_at = Column(DateTime, default=utcnow, nullable=False)

    document = relationship("CaseDocument", back_populates="versions")


class DocumentInboxItem(Base):
    __tablename__ = "document_inbox_items"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("ledger_users.id"), nullable=False, index=True)
    source_type = Column(String(80), default="manual", index=True)
    source_uri = Column(Text, default="")
    original_filename = Column(String(255), default="")
    local_path = Column(Text, default="")
    content_hash = Column(String(128), nullable=False, index=True)
    document_type = Column(String(80), default="unknown", index=True)
    date_on_document = Column(String(40), default="")
    sender = Column(String(255), default="")
    recipient = Column(String(255), default="")
    title = Column(String(255), default="")
    ocr_text = Column(Text, default="")
    extracted_text = Column(Text, default="")
    summary = Column(Text, default="")
    confidentiality_level = Column(String(80), default="normal")
    analysis_json = Column(Text, default="{}")
    metadata_json = Column(Text, default="{}")
    suggested_matches_json = Column(Text, default="[]")
    suggested_case_id = Column(Integer, ForeignKey("legal_cases.id"), index=True)
    match_score = Column(Float, default=0.0)
    status = Column(String(40), default="needs_review", nullable=False, index=True)
    linked_case_id = Column(Integer, ForeignKey("legal_cases.id"), index=True)
    linked_document_id = Column(Integer, ForeignKey("case_documents.id"), index=True)
    linked_at = Column(DateTime)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    user = relationship("LedgerUser", back_populates="document_inbox_items")


class CaseEvent(Base):
    __tablename__ = "case_events"

    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("legal_cases.id"), nullable=False, index=True)
    event_date = Column(String(40), nullable=False, index=True)
    event_type = Column(String(80), default="event")
    event_kind = Column(String(80), default="event")
    title = Column(String(255), nullable=False)
    description = Column(Text, default="")
    actor = Column(String(255), default="")
    action = Column(String(120), default="")
    affected_party = Column(String(255), default="")
    source_confidence = Column(Float, default=0.0)
    user_confirmed = Column(Boolean, default=False)
    created_from_document_id = Column(Integer, ForeignKey("case_documents.id"))
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    case = relationship("LegalCase", back_populates="events")


class EvidenceLink(Base):
    __tablename__ = "evidence_links"

    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("legal_cases.id"), nullable=False, index=True)
    document_id = Column(Integer, ForeignKey("case_documents.id"), nullable=False, index=True)
    target_type = Column(String(80), nullable=False)
    target_id = Column(Integer, nullable=False, index=True)
    snippet = Column(Text, default="")
    relationship = Column(String(80), default="supports")
    strength = Column(String(40), default="medium")
    source_confidence = Column(Float, default=0.0)
    user_confirmed = Column(Boolean, default=False)
    created_at = Column(DateTime, default=utcnow, nullable=False)


class LegalClaim(Base):
    __tablename__ = "legal_claims"

    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("legal_cases.id"), nullable=False, index=True)
    asserted_by = Column(String(255), default="user")
    position_role = Column(String(80), default="unknown")
    subject_party = Column(String(255), default="")
    claim_type = Column(String(80), default="factual")
    materiality = Column(String(40), default="medium")
    statement = Column(Text, nullable=False)
    status = Column(String(80), default="unreviewed")
    confidence = Column(Float, default=0.0)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    case = relationship("LegalCase", back_populates="claims")


class Contradiction(Base):
    __tablename__ = "contradictions"

    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("legal_cases.id"), nullable=False, index=True)
    contradiction_type = Column(String(80), default="conflict")
    title = Column(String(255), nullable=False)
    description = Column(Text, default="")
    status = Column(String(80), default="needs_review")
    severity = Column(String(40), default="medium")
    source_refs = Column(Text, default="[]")
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    case = relationship("LegalCase", back_populates="contradictions")


class MissingEvidenceWarning(Base):
    __tablename__ = "missing_evidence_warnings"

    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("legal_cases.id"), nullable=False, index=True)
    claim_id = Column(Integer, ForeignKey("legal_claims.id"), index=True)
    document_id = Column(Integer, ForeignKey("case_documents.id"), index=True)
    warning_type = Column(String(80), default="unsupported_claim")
    title = Column(String(255), nullable=False)
    description = Column(Text, default="")
    suggested_action = Column(Text, default="")
    status = Column(String(80), default="needs_review")
    severity = Column(String(40), default="medium")
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    case = relationship("LegalCase", back_populates="missing_evidence")


class Deadline(Base):
    __tablename__ = "deadlines"

    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("legal_cases.id"), nullable=False, index=True)
    due_date = Column(String(40), nullable=False, index=True)
    title = Column(String(255), nullable=False)
    description = Column(Text, default="")
    deadline_type = Column(String(80), default="action")
    status = Column(String(80), default="open")
    source_document_id = Column(Integer, ForeignKey("case_documents.id"))
    requires_approval = Column(Boolean, default=True)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    case = relationship("LegalCase", back_populates="deadlines")


class Obligation(Base):
    __tablename__ = "obligations"

    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("legal_cases.id"), nullable=False, index=True)
    title = Column(String(255), nullable=False)
    description = Column(Text, default="")
    responsible_party = Column(String(255), default="unassigned", index=True)
    beneficiary_party = Column(String(255), default="")
    obligation_type = Column(String(80), default="action")
    due_date = Column(String(40), default="", index=True)
    status = Column(String(80), default="needs_review", index=True)
    risk_level = Column(String(40), default="medium")
    source_document_id = Column(Integer, ForeignKey("case_documents.id"), index=True)
    source_quote = Column(Text, default="")
    source_confidence = Column(Float, default=0.0)
    user_confirmed = Column(Boolean, default=False)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    case = relationship("LegalCase", back_populates="obligations")


class OpenLoop(Base):
    __tablename__ = "open_loops"

    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("legal_cases.id"), nullable=False, index=True)
    title = Column(String(255), nullable=False)
    description = Column(Text, default="")
    owner = Column(String(120), default="robert")
    status = Column(String(80), default="open")
    next_action = Column(Text, default="")
    risk_level = Column(String(40), default="medium")
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    case = relationship("LegalCase", back_populates="open_loops")


class LawyerOutreach(Base):
    __tablename__ = "lawyer_outreach"

    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("legal_cases.id"), nullable=False, index=True)
    lawyer_name = Column(String(255), default="")
    lawyer_email = Column(String(255), default="")
    legal_field = Column(String(120), default="")
    subject = Column(String(255), default="")
    draft_body = Column(Text, default="")
    status = Column(String(80), default="draft")
    approval_id = Column(Integer, ForeignKey("approvals.id"))
    sent_at = Column(DateTime)
    follow_up_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    case = relationship("LegalCase", back_populates="outreach")


class LawyerResponse(Base):
    __tablename__ = "lawyer_responses"

    id = Column(Integer, primary_key=True)
    outreach_id = Column(Integer, ForeignKey("lawyer_outreach.id"), nullable=False, index=True)
    response_type = Column(String(80), default="unclassified")
    content = Column(Text, default="")
    received_at = Column(DateTime, default=utcnow, nullable=False)
    created_at = Column(DateTime, default=utcnow, nullable=False)


class MatchResult(Base):
    __tablename__ = "match_results"

    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("legal_cases.id"), nullable=False, index=True)
    match_type = Column(String(80), nullable=False, index=True)
    source = Column(String(120), default="serverless_matching")
    criteria_json = Column(Text, default="{}")
    payload_json = Column(Text, default="{}")
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    case = relationship("LegalCase", back_populates="match_results")


class OutreachDirectoryTarget(Base):
    __tablename__ = "outreach_directory_targets"

    id = Column(Integer, primary_key=True)
    target_type = Column(String(40), nullable=False, index=True)
    name = Column(String(255), nullable=False, index=True)
    subtype = Column(String(120), default="")
    parent_org = Column(String(255), default="")
    description = Column(Text, default="")
    topics_json = Column(Text, default="[]")
    legal_fields_json = Column(Text, default="[]")
    audience_json = Column(Text, default="[]")
    channels_json = Column(Text, default="[]")
    region = Column(String(120), default="Netherlands")
    url = Column(Text, default="")
    contact_url = Column(Text, default="")
    source_url = Column(Text, nullable=False)
    source_label = Column(String(255), default="")
    source_retrieved_at = Column(DateTime)
    confidence = Column(String(40), default="unknown")
    status = Column(String(40), default="needs_review", index=True)
    metadata_json = Column(Text, default="{}")
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class Draft(Base):
    __tablename__ = "drafts"

    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("legal_cases.id"), nullable=False, index=True)
    draft_type = Column(String(80), default="summary")
    title = Column(String(255), nullable=False)
    body = Column(Text, default="")
    status = Column(String(80), default="draft")
    risk_level = Column(String(40), default="medium")
    approval_id = Column(Integer, ForeignKey("approvals.id"))
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class CaseAnalysisRun(Base):
    __tablename__ = "case_analysis_runs"

    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("legal_cases.id"), nullable=False, index=True)
    analysis_type = Column(String(80), default="cross_document", index=True)
    status = Column(String(80), default="needs_review", index=True)
    provider = Column(String(80), default="rule_based")
    model = Column(String(255), default="")
    content_json = Column(Text, default="{}")
    source_snapshot_json = Column(Text, default="[]")
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    case = relationship("LegalCase", back_populates="analysis_runs")
    review_items = relationship("CaseAnalysisReviewItem", back_populates="analysis_run", cascade="all, delete-orphan")


class CaseAnalysisJob(Base):
    """Durable progress state for a local, full-source case reading."""

    __tablename__ = "case_analysis_jobs"

    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("legal_cases.id"), nullable=False, index=True)
    run_id = Column(Integer, ForeignKey("case_analysis_runs.id"))
    provider = Column(String(80), default="rule_based", nullable=False)
    model = Column(String(255), default="")
    status = Column(String(40), default="queued", nullable=False, index=True)
    stage = Column(String(255), default="Queued")
    current_item = Column(String(255), default="")
    total_documents = Column(Integer, default=0)
    completed_documents = Column(Integer, default=0)
    total_chunks = Column(Integer, default=0)
    completed_chunks = Column(Integer, default=0)
    total_words = Column(Integer, default=0)
    processed_words = Column(Integer, default=0)
    total_characters = Column(Integer, default=0)
    processed_characters = Column(Integer, default=0)
    estimated_total_seconds = Column(Integer, default=0)
    error = Column(Text, default="")
    result_json = Column(Text, default="{}")
    started_at = Column(DateTime)
    completed_at = Column(DateTime)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    case = relationship("LegalCase", back_populates="analysis_jobs")


class CaseAnalysisReviewItem(Base):
    """A cited case-wide observation held for explicit ledger review.

    The item is an internal work item, not a confirmed fact.  A user must
    deliberately convert it into a timeline proposal, claim, contradiction, or
    follow-up.
    """

    __tablename__ = "case_analysis_review_items"

    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("legal_cases.id"), nullable=False, index=True)
    analysis_run_id = Column(Integer, ForeignKey("case_analysis_runs.id"), nullable=False, index=True)
    finding_key = Column(String(120), nullable=False, index=True)
    item_type = Column(String(80), default="finding", index=True)
    title = Column(String(255), nullable=False)
    description = Column(Text, default="")
    source_refs = Column(Text, default="[]")
    status = Column(String(80), default="needs_review", index=True)
    target_type = Column(String(80), default="")
    target_id = Column(Integer)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)

    case = relationship("LegalCase", back_populates="analysis_review_items")
    analysis_run = relationship("CaseAnalysisRun", back_populates="review_items")


class Approval(Base):
    __tablename__ = "approvals"

    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("legal_cases.id"), index=True)
    entity_type = Column(String(80), nullable=False)
    entity_id = Column(Integer)
    action = Column(String(120), nullable=False)
    risk_level = Column(String(40), default="high")
    status = Column(String(80), default="pending")
    requested_by = Column(String(120), default="system")
    resolved_by = Column(String(120), default="")
    reason = Column(Text, default="")
    context_json = Column(Text, default="{}")
    created_at = Column(DateTime, default=utcnow, nullable=False)
    resolved_at = Column(DateTime)


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("ledger_users.id"), index=True)
    case_id = Column(Integer, ForeignKey("legal_cases.id"), index=True)
    entity_type = Column(String(80), nullable=False)
    entity_id = Column(Integer)
    action = Column(String(120), nullable=False)
    actor = Column(String(120), default="system")
    source = Column(String(120), default="api")
    before_state = Column(Text, default="{}")
    after_state = Column(Text, default="{}")
    risk_level = Column(String(40), default="low")
    approval_id = Column(Integer, ForeignKey("approvals.id"))
    created_at = Column(DateTime, default=utcnow, nullable=False)


class EvidenceImportJob(Base):
    __tablename__ = "evidence_import_jobs"

    id = Column(Integer, primary_key=True)
    case_id = Column(Integer, ForeignKey("legal_cases.id"), nullable=False, index=True)
    provider = Column(String(80), default="google", nullable=False)
    source = Column(String(80), default="gmail", nullable=False)
    query = Column(Text, default="")
    status = Column(String(40), default="queued", nullable=False, index=True)
    stage = Column(String(255), default="Queued")
    current_item = Column(String(255), default="")
    total_items = Column(Integer, default=0)
    completed_items = Column(Integer, default=0)
    total_words = Column(Integer, default=0)
    processed_words = Column(Integer, default=0)
    imported_count = Column(Integer, default=0)
    skipped_count = Column(Integer, default=0)
    estimated_total_seconds = Column(Integer, default=0)
    error = Column(Text, default="")
    result_json = Column(Text, default="{}")
    started_at = Column(DateTime)
    completed_at = Column(DateTime)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class LegalLedger:
    """Service facade around the persistent legal case ledger."""

    def __init__(self, database_url: str):
        self.database_url = database_url
        self._ensure_sqlite_parent(database_url)
        connect_args = {"check_same_thread": False} if database_url.startswith("sqlite") else {}
        self.engine = create_engine(database_url, future=True, connect_args=connect_args)
        self.Session = scoped_session(sessionmaker(bind=self.engine, autoflush=False, expire_on_commit=False, future=True))

    @staticmethod
    def _ensure_sqlite_parent(database_url: str) -> None:
        if not database_url.startswith("sqlite"):
            return
        parsed = urlparse(database_url)
        path = parsed.path
        if database_url.startswith("sqlite:///") and not database_url.startswith("sqlite:////"):
            path = database_url.replace("sqlite:///", "", 1)
        if path and path not in {":memory:", "/:memory:"}:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)

    def create_all(self) -> None:
        Base.metadata.create_all(self.engine)
        self._ensure_additive_schema()

    def _ensure_additive_schema(self) -> None:
        """Add safe nullable/defaulted columns to databases created by older LARO versions."""
        inspector = inspect(self.engine)
        table_additions = {
            "case_events": {
                "event_kind": "VARCHAR(80) NOT NULL DEFAULT 'event'",
                "actor": "VARCHAR(255) NOT NULL DEFAULT ''",
                "action": "VARCHAR(120) NOT NULL DEFAULT ''",
                "affected_party": "VARCHAR(255) NOT NULL DEFAULT ''",
            },
            "legal_claims": {
                "position_role": "VARCHAR(80) NOT NULL DEFAULT 'unknown'",
                "subject_party": "VARCHAR(255) NOT NULL DEFAULT ''",
                "materiality": "VARCHAR(40) NOT NULL DEFAULT 'medium'",
            },
            "approvals": {
                "context_json": "TEXT NOT NULL DEFAULT '{}'",
            },
            "audit_events": {
                "user_id": "INTEGER",
            },
        }
        known_tables = set(inspector.get_table_names())
        with self.engine.begin() as connection:
            for raw_table_name, additions in table_additions.items():
                if raw_table_name not in known_tables:
                    continue
                existing = {column["name"] for column in inspector.get_columns(raw_table_name)}
                table_name = self.engine.dialect.identifier_preparer.quote(raw_table_name)
                for name, definition in additions.items():
                    if name in existing:
                        continue
                    column_name = self.engine.dialect.identifier_preparer.quote(name)
                    connection.execute(sql_text(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}"))
            if "audit_events" in known_tables and "legal_cases" in known_tables:
                connection.execute(sql_text(
                    "UPDATE audit_events SET user_id = ("
                    "SELECT legal_cases.user_id FROM legal_cases WHERE legal_cases.id = audit_events.case_id"
                    ") WHERE user_id IS NULL AND case_id IS NOT NULL"
                ))

    def close(self) -> None:
        self.Session.remove()
        self.engine.dispose()

    @contextmanager
    def session_scope(self):
        session = self.Session()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()
            self.Session.remove()

    def ensure_user(self, external_user_id: Any, email: Optional[str] = None) -> Dict[str, Any]:
        with self.session_scope() as session:
            user = self._ensure_user(session, external_user_id, email)
            return self._serialize_user(user)

    def save_external_connection(
        self,
        external_user_id: Any,
        provider: str,
        *,
        email: Optional[str] = None,
        status: str = "connected",
        scopes: Optional[List[str]] = None,
        token_response: Optional[Dict[str, Any]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        actor: str = "system",
    ) -> Dict[str, Any]:
        """Persist connector status without storing raw OAuth tokens."""
        normalized_provider = (provider or "").strip().lower()
        if not normalized_provider:
            raise ValueError("provider is required")
        with self.session_scope() as session:
            user = self._ensure_user(session, external_user_id, email)
            connection = session.query(ExternalConnection).filter_by(user_id=user.id, provider=normalized_provider).one_or_none()
            before = self._serialize_external_connection(connection) if connection else {}
            if not connection:
                connection = ExternalConnection(user_id=user.id, provider=normalized_provider)
                session.add(connection)

            connection.status = status or "connected"
            connection.scopes_json = _json_dump(scopes or [])
            connection.token_fingerprint = self._token_fingerprint(token_response or {})
            connection.metadata_json = _json_dump(self._safe_connection_metadata(token_response or {}, metadata or {}))
            if connection.status == "connected":
                connection.connected_at = utcnow()
                connection.disconnected_at = None
            else:
                connection.disconnected_at = utcnow()
            connection.updated_at = utcnow()
            session.flush()
            after = self._serialize_external_connection(connection)
            self._audit(
                session,
                None,
                "ExternalConnection",
                connection.id,
                "connected" if connection.status == "connected" else connection.status,
                actor,
                before,
                after,
                "medium",
            )
            return after

    def get_external_connection(self, external_user_id: Any, provider: str) -> Optional[Dict[str, Any]]:
        normalized_provider = (provider or "").strip().lower()
        if not normalized_provider:
            return None
        with self.session_scope() as session:
            user = session.query(LedgerUser).filter_by(external_user_id=str(external_user_id)).one_or_none()
            if not user:
                return None
            connection = session.query(ExternalConnection).filter_by(user_id=user.id, provider=normalized_provider).one_or_none()
            return self._serialize_external_connection(connection) if connection else None

    def create_case(self, data: Dict[str, Any], actor: str = "system") -> Dict[str, Any]:
        with self.session_scope() as session:
            user = self._ensure_user(session, data.get("user_id") or actor, data.get("user_email"))
            case = LegalCase(
                user_id=user.id,
                title=data.get("title") or data.get("case_title") or self._title_from_description(data),
                description=data.get("description") or data.get("case_description") or "",
                legal_domain=data.get("legal_domain") or data.get("legal_field") or "unknown",
                status=data.get("status") or "pending",
                priority=data.get("priority") or "normal",
                desired_outcome=data.get("desired_outcome") or "",
                current_summary=data.get("current_summary") or data.get("summary") or "",
                opposing_parties=_json_dump(data.get("opposing_parties") or []),
                court_or_institution=data.get("court_or_institution") or "",
                risk_level=data.get("risk_level") or "medium",
            )
            session.add(case)
            session.flush()
            self._sync_parties(session, case.id, data.get("parties") or [])
            self._sync_case_identifiers(session, case.id, data)
            session.flush()
            created = self._case_detail(session, case)
            self._audit(session, case.id, "LegalCase", case.id, "created", actor, {}, created, "medium")
            return created

    def list_cases(self, external_user_id: Optional[Any] = None) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            query = session.query(LegalCase).order_by(LegalCase.updated_at.desc(), LegalCase.id.desc())
            if external_user_id is not None:
                user = session.query(LedgerUser).filter_by(external_user_id=str(external_user_id)).one_or_none()
                if not user:
                    return []
                query = query.filter_by(user_id=user.id)
            return [self._case_detail(session, case) for case in query.all()]

    def search_ledger(
        self,
        query: str,
        external_user_id: Optional[Any] = None,
        *,
        case_id: Optional[int] = None,
        limit: int = 50,
    ) -> Dict[str, Any]:
        needle = (query or "").strip()
        if not needle:
            return {"query": needle, "count": 0, "results": [], "facets": {}}
        needle_lower = needle.lower()
        max_results = max(1, min(int(limit or 50), 100))

        def clean(value: Any) -> str:
            return " ".join(str(value or "").split())

        def snippet(*values: Any) -> str:
            haystack = clean(" ".join(clean(value) for value in values if value is not None))
            if not haystack:
                return ""
            index = haystack.lower().find(needle_lower)
            if index < 0:
                return haystack[:180]
            start = max(0, index - 70)
            end = min(len(haystack), index + len(needle) + 110)
            prefix = "..." if start else ""
            suffix = "..." if end < len(haystack) else ""
            return f"{prefix}{haystack[start:end].strip()}{suffix}"

        def score(title: Any, *body: Any) -> int:
            title_text = clean(title).lower()
            body_text = clean(" ".join(clean(value) for value in body)).lower()
            points = 0
            if title_text == needle_lower:
                points += 80
            elif needle_lower in title_text:
                points += 55
            if needle_lower in body_text:
                points += 25
            return points

        def matches(*values: Any) -> bool:
            return needle_lower in clean(" ".join(clean(value) for value in values)).lower()

        def add_result(
            results: List[Dict[str, Any]],
            result_type: str,
            case: LegalCase,
            entity_id: Any,
            title: str,
            body: str,
            *,
            target: str = "overview",
            queue_type: Optional[str] = None,
            item_id: Optional[Any] = None,
            metadata: Optional[Dict[str, Any]] = None,
        ) -> None:
            results.append({
                "result_type": result_type,
                "case_id": case.id,
                "case_title": case.title,
                "entity_id": entity_id,
                "title": clean(title) or f"{result_type} match",
                "snippet": body,
                "target": target,
                "queue_type": queue_type or "",
                "item_id": str(item_id or entity_id or ""),
                "score": score(title, body),
                "metadata": metadata or {},
            })

        with self.session_scope() as session:
            case_query = session.query(LegalCase).order_by(LegalCase.updated_at.desc(), LegalCase.id.desc())
            user = None
            if external_user_id is not None:
                user = session.query(LedgerUser).filter_by(external_user_id=str(external_user_id)).one_or_none()
                if not user:
                    return {"query": needle, "count": 0, "results": [], "facets": {}}
                case_query = case_query.filter_by(user_id=user.id)
            if case_id:
                case_query = case_query.filter(LegalCase.id == case_id)
            cases_for_search = case_query.all()
            case_ids = [case.id for case in cases_for_search]
            case_by_id = {case.id: case for case in cases_for_search}
            results: List[Dict[str, Any]] = []

            inbox_query = session.query(DocumentInboxItem).filter_by(status="needs_review")
            if user:
                inbox_query = inbox_query.filter_by(user_id=user.id)
            if case_id:
                inbox_query = inbox_query.filter(DocumentInboxItem.suggested_case_id == case_id)
            for item in inbox_query.all():
                if not matches(
                    item.title,
                    item.original_filename,
                    item.summary,
                    item.extracted_text,
                    item.ocr_text,
                    item.sender,
                    item.recipient,
                    item.document_type,
                ):
                    continue
                suggested_matches = _json_load(item.suggested_matches_json, []) or []
                suggested = suggested_matches[0] if suggested_matches else {}
                result_title = item.title or item.original_filename or "Unassigned source"
                result_body = snippet(
                    item.summary,
                    item.extracted_text,
                    item.ocr_text,
                    item.sender,
                    item.recipient,
                    item.document_type,
                )
                results.append({
                    "result_type": "document_inbox",
                    "case_id": item.suggested_case_id,
                    "case_title": suggested.get("case_title") or "Unassigned",
                    "entity_id": item.id,
                    "title": clean(result_title),
                    "snippet": result_body,
                    "target": "document-inbox",
                    "queue_type": "document_inbox",
                    "item_id": str(item.id),
                    "score": score(result_title, result_body),
                    "metadata": {
                        "status": item.status,
                        "source_type": item.source_type,
                        "suggested_confidence": suggested.get("confidence"),
                        "suggested_match_score": suggested.get("score"),
                    },
                })

            for case in cases_for_search:
                if matches(
                    case.title,
                    case.description,
                    case.current_summary,
                    case.legal_domain,
                    case.desired_outcome,
                    case.court_or_institution,
                    " ".join(_json_load(case.opposing_parties, []) or []),
                ):
                    add_result(
                        results,
                        "case",
                        case,
                        case.id,
                        case.title,
                        snippet(case.description, case.current_summary, case.desired_outcome, case.legal_domain, case.court_or_institution),
                    )

            for document in session.query(CaseDocument).filter(CaseDocument.case_id.in_(case_ids)).all():
                if matches(document.title, document.original_filename, document.summary, document.extracted_text, document.ocr_text, document.sender, document.recipient):
                    add_result(
                        results,
                        "document",
                        case_by_id[document.case_id],
                        document.id,
                        document.title or document.original_filename or "Source document",
                        snippet(document.summary, document.extracted_text, document.ocr_text, document.sender, document.recipient),
                        target="documents",
                        item_id=document.id,
                        metadata={"source_type": document.source_type, "document_type": document.document_type, "date_on_document": document.date_on_document},
                    )

            for event in session.query(CaseEvent).filter(CaseEvent.case_id.in_(case_ids)).all():
                if matches(event.title, event.description, event.event_date, event.event_type, event.event_kind, event.actor, event.action, event.affected_party):
                    add_result(
                        results,
                        "timeline",
                        case_by_id[event.case_id],
                        event.id,
                        event.title,
                        snippet(event.event_date, event.actor, event.action, event.affected_party, event.description, event.event_kind),
                        target="timeline",
                        queue_type="timeline" if not event.user_confirmed else None,
                        item_id=event.id,
                        metadata={
                            "event_date": event.event_date,
                            "event_kind": event.event_kind,
                            "actor": event.actor,
                            "action": event.action,
                            "affected_party": event.affected_party,
                            "confirmed": event.user_confirmed,
                        },
                    )

            for claim in session.query(LegalClaim).filter(LegalClaim.case_id.in_(case_ids)).all():
                if matches(claim.statement, claim.asserted_by, claim.position_role, claim.subject_party, claim.claim_type, claim.materiality, claim.status):
                    add_result(
                        results,
                        "claim",
                        case_by_id[claim.case_id],
                        claim.id,
                        claim.statement[:96],
                        snippet(claim.statement, claim.asserted_by, claim.position_role, claim.subject_party, claim.claim_type, claim.materiality, claim.status),
                        target="claims",
                        queue_type="claim" if claim.status in {"needs_review", "unreviewed"} else None,
                        item_id=claim.id,
                        metadata={"status": claim.status, "asserted_by": claim.asserted_by, "position_role": claim.position_role, "materiality": claim.materiality},
                    )

            for item in session.query(Contradiction).filter(Contradiction.case_id.in_(case_ids)).all():
                if matches(item.title, item.description, item.contradiction_type, item.severity, item.status):
                    add_result(results, "contradiction", case_by_id[item.case_id], item.id, item.title, snippet(item.description, item.severity, item.status), target="review", queue_type="contradiction", item_id=item.id)

            for item in session.query(MissingEvidenceWarning).filter(MissingEvidenceWarning.case_id.in_(case_ids)).all():
                if matches(item.title, item.description, item.suggested_action, item.severity, item.status):
                    add_result(results, "missing_evidence", case_by_id[item.case_id], item.id, item.title, snippet(item.description, item.suggested_action, item.status), target="review", queue_type="gap", item_id=item.id)

            for item in session.query(Deadline).filter(Deadline.case_id.in_(case_ids)).all():
                if matches(item.title, item.description, item.due_date, item.status):
                    add_result(results, "deadline", case_by_id[item.case_id], item.id, item.title, snippet(item.due_date, item.description, item.status), target="review", queue_type="deadline", item_id=item.id)

            for item in session.query(Obligation).filter(Obligation.case_id.in_(case_ids)).all():
                if matches(item.title, item.description, item.responsible_party, item.beneficiary_party, item.due_date, item.source_quote, item.status):
                    add_result(
                        results,
                        "obligation",
                        case_by_id[item.case_id],
                        item.id,
                        item.title,
                        snippet(item.description, item.responsible_party, item.beneficiary_party, item.due_date, item.source_quote, item.status),
                        target="review",
                        queue_type="obligation" if item.status not in {"resolved", "dismissed"} else None,
                        item_id=item.id,
                        metadata={"status": item.status, "responsible_party": item.responsible_party, "due_date": item.due_date},
                    )

            for item in session.query(OpenLoop).filter(OpenLoop.case_id.in_(case_ids)).all():
                if matches(item.title, item.description, item.next_action, item.status):
                    add_result(results, "open_loop", case_by_id[item.case_id], item.id, item.title, snippet(item.description, item.next_action, item.status), target="review", queue_type="loop", item_id=item.id)

            for item in session.query(Draft).filter(Draft.case_id.in_(case_ids)).all():
                if matches(item.title, item.body, item.draft_type, item.status, item.risk_level):
                    add_result(results, "draft", case_by_id[item.case_id], item.id, item.title, snippet(item.body, item.draft_type, item.status), target="drafts", item_id=item.id, metadata={"status": item.status, "risk_level": item.risk_level})

            for item in session.query(LawyerOutreach).filter(LawyerOutreach.case_id.in_(case_ids)).all():
                if matches(item.lawyer_name, item.lawyer_email, item.legal_field, item.subject, item.draft_body, item.status):
                    add_result(results, "outreach", case_by_id[item.case_id], item.id, item.lawyer_name or item.subject or "Outreach", snippet(item.lawyer_email, item.legal_field, item.subject, item.draft_body, item.status), target="overview", item_id=item.id, metadata={"status": item.status, "legal_field": item.legal_field})

            results.sort(key=lambda item: (-int(item.get("score") or 0), item.get("result_type") or "", item.get("title") or ""))
            trimmed = results[:max_results]
            facets: Dict[str, int] = {}
            for item in trimmed:
                facets[item["result_type"]] = facets.get(item["result_type"], 0) + 1
            return {"query": needle, "count": len(trimmed), "total_matches": len(results), "results": trimmed, "facets": facets}

    def command_center(self, external_user_id: Optional[Any] = None) -> Dict[str, Any]:
        with self.session_scope() as session:
            case_query = session.query(LegalCase).order_by(LegalCase.updated_at.desc(), LegalCase.id.desc())
            user = None
            if external_user_id is not None:
                user = session.query(LedgerUser).filter_by(external_user_id=str(external_user_id)).one_or_none()
                if not user:
                    return self._empty_command_center()
                case_query = case_query.filter_by(user_id=user.id)

            case_ids = [case.id for case in case_query.all()]
            inbox_query = session.query(DocumentInboxItem).filter_by(status="needs_review")
            if user:
                inbox_query = inbox_query.filter_by(user_id=user.id)
            document_inbox = [
                self._serialize_document_inbox_item(item)
                for item in inbox_query.order_by(DocumentInboxItem.updated_at.desc(), DocumentInboxItem.id.desc()).limit(25).all()
            ]

            for case_id in case_ids:
                self._ensure_missing_evidence_reviews(session, case_id)

            cases = [self._case_detail(session, session.get(LegalCase, case_id)) for case_id in case_ids]
            pending_approvals = [
                self._serialize_approval(item)
                for item in session.query(Approval)
                .filter(Approval.case_id.in_(case_ids), Approval.status == "pending")
                .order_by(Approval.created_at.desc())
                .all()
            ]
            open_loops = [
                self._serialize_open_loop(item)
                for item in session.query(OpenLoop)
                .filter(OpenLoop.case_id.in_(case_ids), OpenLoop.status == "open")
                .order_by(OpenLoop.updated_at.desc())
                .all()
            ]
            contradictions = [
                self._serialize_contradiction(item)
                for item in session.query(Contradiction)
                .filter(Contradiction.case_id.in_(case_ids), Contradiction.status != "resolved")
                .order_by(Contradiction.updated_at.desc())
                .all()
            ]
            missing_evidence = [
                self._serialize_missing_evidence(item)
                for item in session.query(MissingEvidenceWarning)
                .filter(MissingEvidenceWarning.case_id.in_(case_ids), MissingEvidenceWarning.status != "resolved")
                .order_by(MissingEvidenceWarning.updated_at.desc())
                .all()
            ]
            deadlines = [
                self._serialize_deadline(item)
                for item in session.query(Deadline)
                .filter(Deadline.case_id.in_(case_ids), Deadline.status == "open")
                .order_by(Deadline.due_date.asc())
                .all()
            ]
            obligations = [
                self._serialize_obligation(item)
                for item in session.query(Obligation)
                .filter(Obligation.case_id.in_(case_ids), Obligation.status.notin_(["resolved", "dismissed"]))
                .order_by(Obligation.updated_at.desc(), Obligation.id.desc())
                .all()
            ]
            outreach = [
                self._serialize_outreach(item)
                for item in session.query(LawyerOutreach)
                .filter(LawyerOutreach.case_id.in_(case_ids))
                .order_by(LawyerOutreach.updated_at.desc(), LawyerOutreach.id.desc())
                .all()
            ]
            urgent_deadlines = [
                item for item in deadlines
                if self._is_urgent_due_date(item.get("due_date"))
            ]
            pending_outreach_approval = [
                item for item in pending_approvals
                if item.get("entity_type") == "LawyerOutreach" or item.get("action") == "send_external_legal_email"
            ]
            awaiting_lawyer_response = [
                item for item in outreach
                if item.get("status") in {"sent", "follow_up_sent", "waiting_response"}
            ]
            high_risk_items = self._high_risk_command_items(
                pending_approvals,
                contradictions,
                missing_evidence,
                obligations,
                open_loops,
                urgent_deadlines,
            )
            case_queue_ids = {
                item.get("case_id")
                for item in [
                    *pending_approvals,
                    *open_loops,
                    *contradictions,
                    *missing_evidence,
                    *obligations,
                    *urgent_deadlines,
                ]
                if item.get("case_id")
            }
            case_queue_ids.update(
                case.get("case_id")
                for case in cases
                if case.get("documents_count", 0) == 0
            )
            cases_needing_robert = [
                case for case in cases
                if case.get("case_id") in case_queue_ids and case.get("status") not in {"closed", "archived"}
            ]
            cases_awaiting_lawyer_response = [
                case for case in cases
                if case.get("case_id") in {item.get("case_id") for item in awaiting_lawyer_response}
            ]
            cases_needing_evidence = [
                case for case in cases
                if case.get("documents_count", 0) == 0 and case.get("status") not in {"closed", "archived"}
            ]
            activity_query = session.query(AuditEvent)
            if user:
                activity_query = activity_query.filter(AuditEvent.user_id == user.id)
            else:
                activity_query = activity_query.filter(AuditEvent.case_id.in_(case_ids))
            recent_activity = [
                self._serialize_audit(item)
                for item in activity_query.order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc()).limit(12).all()
            ]
            active_cases = [item for item in cases if item.get("status") not in {"closed", "archived"}]

            return {
                "generated_at": _iso(utcnow()),
                "counts": {
                    "active_cases": len(active_cases),
                    "urgent_deadlines": len(urgent_deadlines),
                    "cases_needing_robert": len(cases_needing_robert),
                    "cases_needing_evidence": len(cases_needing_evidence),
                    "cases_awaiting_lawyer_response": len(cases_awaiting_lawyer_response),
                    "pending_outreach_approval": len(pending_outreach_approval),
                    "pending_approvals": len(pending_approvals),
                    "open_loops": len(open_loops),
                    "contradictions": len(contradictions),
                    "missing_evidence": len(missing_evidence),
                    "deadlines": len(deadlines),
                    "obligations": len(obligations),
                    "document_inbox": len(document_inbox),
                    "high_risk_items": len(high_risk_items),
                },
                "cases": cases[:25],
                "pending_approvals": pending_approvals[:10],
                "pending_outreach_approval": pending_outreach_approval[:10],
                "open_loops": open_loops[:10],
                "contradictions": contradictions[:10],
                "missing_evidence": missing_evidence[:10],
                "deadlines": deadlines[:10],
                "obligations": obligations[:10],
                "document_inbox": document_inbox,
                "urgent_deadlines": urgent_deadlines[:10],
                "awaiting_lawyer_response": awaiting_lawyer_response[:10],
                "high_risk_items": high_risk_items[:12],
                "review_queues": {
                    "cases_needing_robert": cases_needing_robert[:10],
                    "cases_needing_evidence": cases_needing_evidence[:10],
                    "cases_awaiting_lawyer_response": cases_awaiting_lawyer_response[:10],
                    "pending_outreach_approval": pending_outreach_approval[:10],
                    "urgent_deadlines": urgent_deadlines[:10],
                    "high_risk_items": high_risk_items[:12],
                    "document_inbox": document_inbox[:10],
                },
                "recent_activity": recent_activity,
                "next_actions": self._next_actions(
                    cases, pending_approvals, obligations, open_loops, contradictions,
                    missing_evidence, urgent_deadlines or deadlines, document_inbox,
                ),
            }

    def case_operating_state(self, case_id: int) -> Optional[Dict[str, Any]]:
        """Return the server-derived operating state for one legal case.

        This is the backend contract for the command center's progressive UI:
        one primary action first, then the review/readiness/traceability detail
        that explains why that action matters.
        """
        with self.session_scope() as session:
            case = session.get(LegalCase, case_id)
            if not case:
                return None
            self._ensure_missing_evidence_reviews(session, case_id)
            self._ensure_case_analysis_review_items(session, case_id)

            documents = session.query(CaseDocument).filter_by(case_id=case_id).all()
            timeline = [
                item for item in session.query(CaseEvent).filter_by(case_id=case_id).all()
                if item.event_type != "rejected_suggestion"
            ]
            claims = session.query(LegalClaim).filter_by(case_id=case_id).all()
            evidence_links = session.query(EvidenceLink).filter_by(case_id=case_id).all()
            contradictions = [
                item for item in session.query(Contradiction).filter_by(case_id=case_id).all()
                if item.status not in {"resolved", "dismissed"}
            ]
            missing_evidence = [
                item for item in session.query(MissingEvidenceWarning).filter_by(case_id=case_id).all()
                if item.status not in {"resolved", "dismissed"}
            ]
            deadlines = [
                item for item in session.query(Deadline).filter_by(case_id=case_id).all()
                if item.status not in {"resolved", "dismissed"}
            ]
            obligations = [
                item for item in session.query(Obligation).filter_by(case_id=case_id).all()
                if item.status not in {"resolved", "dismissed"}
            ]
            obligations_needing_review = [
                item for item in obligations
                if not item.user_confirmed or item.status == "needs_review"
            ]
            open_loops = [
                item for item in session.query(OpenLoop).filter_by(case_id=case_id).all()
                if item.status != "resolved"
            ]
            approvals = [
                item for item in session.query(Approval).filter_by(case_id=case_id, status="pending").all()
            ]
            outreach = session.query(LawyerOutreach).filter_by(case_id=case_id).all()
            parties = session.query(Party).filter_by(case_id=case_id).all()
            identifiers = session.query(CaseIdentifier).filter_by(case_id=case_id).all()
            audit_count = session.query(AuditEvent).filter_by(case_id=case_id).count()
            analysis_review_items = [
                item for item in session.query(CaseAnalysisReviewItem).filter_by(case_id=case_id).all()
                if item.status == "needs_review"
            ]

            supported_claim_ids = {
                link.target_id
                for link in evidence_links
                if link.target_type == "claim" and link.relationship == "supports" and link.user_confirmed
            }
            timeline_needs_review = [item for item in timeline if not item.user_confirmed]
            evidence_needs_review = [
                item for item in evidence_links
                if not item.user_confirmed and item.relationship != "rejected_suggestion"
            ]
            reviewed_claims = [item for item in claims if item.status in {"confirmed", "dismissed"}]
            unsupported_claims = [item for item in claims if item.id not in supported_claim_ids and item.status != "dismissed"]
            review_counts = {
                "approvals": len(approvals),
                "deadlines": len(deadlines),
                "timeline": len(timeline_needs_review),
                "claims": len([item for item in claims if item.status in {"unreviewed", "needs_review"}]),
                "evidence_links": len(evidence_needs_review),
                "contradictions": len(contradictions),
                "missing_evidence": len(missing_evidence),
                "obligations": len(obligations_needing_review),
                "open_loops": len(open_loops),
                "case_analysis": len(analysis_review_items),
            }
            review_total = sum(review_counts.values())

            def ratio_score(done: int, total: int) -> int:
                if total <= 0:
                    return 0
                return int(round(max(0, min(1, done / total)) * 100))

            context_score = 0
            context_score += 20 if case.title else 0
            context_score += 18 if (case.description or case.current_summary) else 0
            context_score += 16 if case.desired_outcome else 0
            context_score += 16 if (case.court_or_institution or parties) else 0
            context_score += 14 if case.legal_domain and case.legal_domain != "unknown" else 0
            context_score += 16 if identifiers else 0
            confirmed_events = len([item for item in timeline if item.user_confirmed])
            source_backed_events = len([item for item in timeline if item.created_from_document_id])
            confirmed_links = len([item for item in evidence_links if item.user_confirmed])
            evidence_score = min(100, (45 if documents else 0) + (35 if confirmed_links else 0) + (20 if len(documents) > 1 or evidence_links else 0))
            chronology_score = 0 if not timeline else min(100, round(ratio_score(confirmed_events, len(timeline)) * 0.7 + ratio_score(source_backed_events, len(timeline)) * 0.3))
            claims_score = 0 if not claims else min(100, round(ratio_score(len(reviewed_claims), len(claims)) * 0.4 + ratio_score(len(supported_claim_ids), len(claims)) * 0.45 + (15 if not unsupported_claims else 0)))
            review_score = max(0, 100 - review_counts["approvals"] * 24 - review_counts["deadlines"] * 18 - (review_total - review_counts["approvals"] - review_counts["deadlines"]) * 10)
            graph_nodes = 1 + len(parties) + len(documents) + len(identifiers) + len(timeline) + len(claims) + len(contradictions) + len(missing_evidence) + len(deadlines) + len(obligations) + len(open_loops)
            graph_edges = len(parties) + len(documents) + len(identifiers) + len(timeline) + len(evidence_links) + len(claims) + len(contradictions) + len(missing_evidence) + len(deadlines) + len(obligations) + len(open_loops)
            trace_score = min(100, (35 if graph_nodes > 1 else 0) + (25 if evidence_links else 0) + (20 if identifiers else 0) + (20 if audit_count else 0))
            lanes = [
                {"key": "context", "label": "Case context", "score": context_score, "target": "overview", "detail": "Parties, institution, desired outcome, legal domain, and source references."},
                {"key": "evidence", "label": "Evidence", "score": evidence_score, "target": "documents", "detail": "Documents and confirmed source links."},
                {"key": "chronology", "label": "Chronology", "score": chronology_score, "target": "timeline", "detail": "Timeline events confirmed and backed by sources."},
                {"key": "claims", "label": "Claims", "score": claims_score, "target": "claims", "detail": "Factual positions reviewed and supported."},
                {"key": "review", "label": "Review load", "score": review_score, "target": "review", "detail": "Open approvals, deadlines, obligations, gaps, conflicts, and loops."},
                {"key": "traceability", "label": "Traceability", "score": trace_score, "target": "papertrail", "detail": "Papertrail nodes, source references, and audit history."},
            ]
            for lane in lanes:
                lane["status"] = "ready" if lane["score"] >= 75 else "building" if lane["score"] >= 35 else "needs_work"
            readiness_score = round(sum(lane["score"] for lane in lanes) / len(lanes))

            def primary_action() -> Dict[str, Any]:
                if approvals:
                    item = approvals[0]
                    return {"priority": "high", "label": "Review approval gate", "detail": item.reason or "A high-risk external action is waiting for explicit approval.", "target": "review", "depth": "guided", "queue_type": "approval", "item_id": item.id}
                if deadlines:
                    item = sorted(deadlines, key=lambda value: value.due_date or "9999-99-99")[0]
                    return {"priority": "urgent", "label": f"Decide deadline: {item.title}", "detail": item.description or f"Due {item.due_date or 'unknown date'}; confirm, resolve, or reopen from the review queue.", "target": "review", "depth": "guided", "queue_type": "deadline", "item_id": item.id}
                if obligations_needing_review:
                    item = sorted(obligations_needing_review, key=lambda value: (value.due_date or "9999-99-99", value.id))[0]
                    owner = item.responsible_party or "unassigned"
                    due = f" Due {item.due_date}." if item.due_date else ""
                    return {"priority": item.risk_level or "medium", "label": f"Confirm obligation: {item.title}", "detail": item.description or f"Responsible party: {owner}.{due} Confirm, edit, or dismiss before relying on it.", "target": "review", "depth": "guided", "queue_type": "obligation", "item_id": item.id}
                if contradictions:
                    item = contradictions[0]
                    return {"priority": item.severity or "medium", "label": f"Resolve contradiction: {item.title}", "detail": item.description or "Conflicting case information needs review before it is relied on.", "target": "review", "depth": "guided", "queue_type": "contradiction", "item_id": item.id}
                if missing_evidence:
                    item = missing_evidence[0]
                    return {"priority": item.severity or "medium", "label": f"Find evidence: {item.title}", "detail": item.suggested_action or item.description or "A claim or event needs source support.", "target": "review", "depth": "guided", "queue_type": "gap", "item_id": item.id}
                if analysis_review_items:
                    item = analysis_review_items[0]
                    return {"priority": "medium", "label": item.title or "Review case-wide observation", "detail": item.description or "A cited case-wide observation needs an explicit ledger decision.", "target": "overview", "depth": "guided", "queue_type": "case_analysis", "item_id": item.id}
                if open_loops:
                    item = open_loops[0]
                    return {"priority": item.risk_level or "medium", "label": item.title, "detail": item.next_action or item.description or "An unresolved case loop needs attention.", "target": "review", "depth": "guided", "queue_type": "loop", "item_id": item.id}
                if timeline_needs_review:
                    item = timeline_needs_review[0]
                    return {"priority": "medium", "label": "Confirm suggested timeline event", "detail": f"{item.event_date}: {item.title}", "target": "timeline", "depth": "guided", "queue_type": "timeline", "item_id": item.id}
                if evidence_needs_review:
                    item = evidence_needs_review[0]
                    return {"priority": "medium", "label": "Confirm source link", "detail": item.snippet or "Review whether this document supports the linked item.", "target": "evidence", "depth": "guided", "queue_type": "evidence", "item_id": item.id}
                if not documents:
                    return {"priority": "normal", "label": "Add first source document", "detail": "Upload, paste, or import evidence so LARO can build the timeline and review queue.", "target": "documents", "depth": "guided"}
                if not claims:
                    return {"priority": "normal", "label": "Capture the first factual claim", "detail": "Record the position that needs proof, without treating it as legal advice.", "target": "claims", "depth": "guided"}
                if not identifiers:
                    return {"priority": "normal", "label": "Attach source reference", "detail": "Add dossier, court, Gmail, or Drive IDs so outside material resolves to this case.", "target": "overview", "depth": "expert"}
                return {"priority": "normal", "label": "Inspect papertrail", "detail": "The case is organized enough to inspect graph, bundle, approvals, and audit depth.", "target": "papertrail", "depth": "expert"}

            action = primary_action()
            recommended_depth = action.get("depth") or ("expert" if readiness_score >= 75 and graph_nodes > 8 else "guided" if review_total or documents else "simple")
            return {
                "case_id": case_id,
                "primary_action": action,
                "recommended_depth": recommended_depth,
                "readiness": {
                    "score": readiness_score,
                    "status": "ready_for_deep_review" if readiness_score >= 75 else "building_record" if readiness_score >= 35 else "needs_intake",
                    "lanes": lanes,
                },
                "review_queue": {"total": review_total, "counts": review_counts},
                "traceability": {
                    "documents": len(documents),
                    "source_links": len(evidence_links),
                    "confirmed_source_links": confirmed_links,
                    "papertrail_nodes": graph_nodes,
                    "papertrail_edges": graph_edges,
                    "audit_events": audit_count,
                    "source_link_coverage": ratio_score(confirmed_links, max(len(claims) + len(timeline), 1)),
                },
                "depth_lanes": [
                    {"depth": "simple", "label": "Focus", "available": True, "detail": "One safe next action and active case context."},
                    {"depth": "guided", "label": "Guided", "available": bool(documents or review_total or timeline or claims), "detail": "Documents, timeline, claims, evidence, and review queue."},
                    {"depth": "expert", "label": "Expert", "available": bool(graph_nodes > 1 or audit_count or approvals or identifiers), "detail": "Papertrail graph, bundle, approvals, audit, and source references."},
                ],
                "safety": {
                    "external_actions_blocked_without_approval": True,
                    "pending_approvals": len(approvals),
                    "legal_advice_disclaimer_required": True,
                    "can_auto_analyze_internal_sources": True,
                },
                "generated_at": _iso(utcnow()),
            }

    def case_review_queue(self, case_id: int) -> Optional[Dict[str, Any]]:
        """Return one persisted worklist for everything that needs review.

        The command center can render this as a single queue while still routing
        each item back to the precise persisted source record.
        """
        with self.session_scope() as session:
            case = session.get(LegalCase, case_id)
            if not case:
                return None
            self._ensure_missing_evidence_reviews(session, case_id)
            self._ensure_case_analysis_review_items(session, case_id)

            def queue_item(
                queue_type: str,
                item_id: Any,
                label: str,
                detail: str,
                source: Dict[str, Any],
                *,
                status: str = "needs_review",
                priority: str = "medium",
                target: str = "review",
                depth: str = "guided",
                action_label: str = "Review",
            ) -> Dict[str, Any]:
                return {
                    "queue_type": queue_type,
                    "item_id": item_id,
                    "case_id": case_id,
                    "label": label,
                    "detail": detail,
                    "status": status,
                    "priority": priority,
                    "target": target,
                    "depth": depth,
                    "action_label": action_label,
                    "source": source,
                }

            items: List[Dict[str, Any]] = []

            for item in session.query(Approval).filter_by(case_id=case_id, status="pending").order_by(Approval.created_at.asc()).all():
                source = self._serialize_approval(item)
                items.append(queue_item(
                    "approval",
                    item.id,
                    f"Review approval: {item.action or 'pending action'}",
                    item.reason or "A high-risk external/legal action is waiting for explicit approval.",
                    source,
                    status=item.status,
                    priority=item.risk_level or "high",
                    action_label="Approve or reject",
                ))

            for item in session.query(Deadline).filter_by(case_id=case_id).order_by(Deadline.due_date.asc(), Deadline.id.asc()).all():
                if item.status in {"resolved", "dismissed"}:
                    continue
                source = self._serialize_deadline(item)
                items.append(queue_item(
                    "deadline",
                    item.id,
                    item.title or "Deadline needs review",
                    item.description or f"Due {item.due_date or 'unknown date'}; confirm, resolve, or reopen from the review queue.",
                    source,
                    status=item.status,
                    priority="urgent" if self._is_urgent_due_date(item.due_date) else "high" if item.requires_approval else "medium",
                    action_label="Confirm or resolve",
                ))

            for item in session.query(Obligation).filter_by(case_id=case_id).order_by(Obligation.due_date.asc(), Obligation.id.asc()).all():
                if item.status in {"resolved", "dismissed"} or (item.user_confirmed and item.status == "confirmed"):
                    continue
                source = self._serialize_obligation(item)
                owner = item.responsible_party or "unassigned"
                due = f" Due {item.due_date}." if item.due_date else ""
                items.append(queue_item(
                    "obligation",
                    item.id,
                    item.title or "Obligation needs review",
                    item.description or f"Responsible party: {owner}.{due} Confirm the source-linked duty before relying on it.",
                    source,
                    status=item.status,
                    priority="urgent" if self._is_urgent_due_date(item.due_date) else item.risk_level or "medium",
                    action_label="Confirm, resolve, or dismiss",
                ))

            for item in session.query(CaseEvent).filter_by(case_id=case_id).order_by(CaseEvent.event_date.asc(), CaseEvent.id.asc()).all():
                if item.user_confirmed or item.event_type == "rejected_suggestion":
                    continue
                source = self._serialize_event(item)
                items.append(queue_item(
                    "timeline",
                    item.id,
                    item.title or "Timeline suggestion ready",
                    f"{item.event_date or 'Unknown date'} - {item.description or 'Confirm the extracted event and source.'}",
                    source,
                    status="needs_review",
                    priority="medium",
                    target="timeline",
                    action_label="Confirm or reject",
                ))

            for item in session.query(LegalClaim).filter_by(case_id=case_id).order_by(LegalClaim.created_at.asc(), LegalClaim.id.asc()).all():
                if item.status not in {"unreviewed", "needs_review"}:
                    continue
                source = self._serialize_claim(item)
                items.append(queue_item(
                    "claim",
                    item.id,
                    "Claim needs review",
                    item.statement or "Extracted claim needs confirmation.",
                    source,
                    status=item.status,
                    priority="medium",
                    target="claims",
                    action_label="Confirm or dismiss",
                ))

            for item in session.query(EvidenceLink).filter_by(case_id=case_id).order_by(EvidenceLink.created_at.asc(), EvidenceLink.id.asc()).all():
                if item.user_confirmed or item.relationship == "rejected_suggestion":
                    continue
                source = self._serialize_evidence_link(item)
                items.append(queue_item(
                    "evidence",
                    item.id,
                    "Evidence link needs review",
                    item.snippet or f"{item.relationship or 'supports'} {item.target_type or 'item'} {item.target_id or ''}".strip(),
                    source,
                    status="needs_review",
                    priority="medium",
                    target="evidence",
                    action_label="Confirm or reject",
                ))

            for item in session.query(Contradiction).filter_by(case_id=case_id).order_by(Contradiction.updated_at.desc(), Contradiction.id.desc()).all():
                if item.status in {"resolved", "dismissed"}:
                    continue
                source = self._serialize_contradiction(item)
                items.append(queue_item(
                    "contradiction",
                    item.id,
                    item.title or "Contradiction needs review",
                    item.description or "Conflicting case information needs review before it is relied on.",
                    source,
                    status=item.status,
                    priority=item.severity or "medium",
                    action_label="Resolve or dismiss",
                ))

            self._ensure_case_analysis_review_items(session, case_id)
            for item in session.query(CaseAnalysisReviewItem).filter_by(case_id=case_id, status="needs_review").order_by(CaseAnalysisReviewItem.created_at.asc(), CaseAnalysisReviewItem.id.asc()).all():
                source = self._serialize_case_analysis_review_item(item)
                items.append(queue_item(
                    "case_analysis",
                    item.id,
                    item.title or "Case-wide observation needs review",
                    item.description or "A cited local analysis observation needs an explicit ledger decision.",
                    source,
                    status=item.status,
                    priority="medium",
                    target="overview",
                    action_label="Prepare or dismiss",
                ))

            for item in session.query(MissingEvidenceWarning).filter_by(case_id=case_id).order_by(MissingEvidenceWarning.updated_at.desc(), MissingEvidenceWarning.id.desc()).all():
                if item.status in {"resolved", "dismissed"}:
                    continue
                source = self._serialize_missing_evidence(item)
                items.append(queue_item(
                    "gap",
                    item.id,
                    item.title or "Evidence gap",
                    item.suggested_action or item.description or "A claim or event needs source support.",
                    source,
                    status=item.status,
                    priority=item.severity or "medium",
                    action_label="Find evidence",
                ))

            for item in session.query(OpenLoop).filter_by(case_id=case_id).order_by(OpenLoop.updated_at.desc(), OpenLoop.id.desc()).all():
                if item.status == "resolved":
                    continue
                source = self._serialize_open_loop(item)
                items.append(queue_item(
                    "loop",
                    item.id,
                    item.title or "Open loop",
                    item.next_action or item.description or "An unresolved case loop needs attention.",
                    source,
                    status=item.status,
                    priority=item.risk_level or "medium",
                    action_label="Resolve loop",
                ))

            priority_rank = {"urgent": 0, "critical": 1, "high": 2, "medium": 3, "normal": 4, "low": 5}
            target_rank = {"approval": 0, "deadline": 1, "obligation": 2, "contradiction": 3, "case_analysis": 4, "gap": 5, "loop": 6, "timeline": 7, "claim": 8, "evidence": 9}
            items.sort(key=lambda item: (
                priority_rank.get(str(item.get("priority") or "medium"), 3),
                target_rank.get(str(item.get("queue_type") or ""), 9),
                str(item.get("label") or ""),
            ))
            counts: Dict[str, int] = {}
            for item in items:
                counts[item["queue_type"]] = counts.get(item["queue_type"], 0) + 1

            return {
                "case_id": case_id,
                "count": len(items),
                "counts": counts,
                "items": items,
                "generated_at": _iso(utcnow()),
            }

    def get_case(self, case_id: int) -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            case = session.get(LegalCase, case_id)
            return self._case_detail(session, case) if case else None

    def user_owns_case(self, case_id: int, external_user_id: Any) -> bool:
        """Return ownership without serializing a case or exposing its existence."""
        if case_id is None or external_user_id in (None, ""):
            return False
        with self.session_scope() as session:
            user = session.query(LedgerUser).filter_by(external_user_id=str(external_user_id)).one_or_none()
            if not user:
                return False
            return session.query(LegalCase.id).filter_by(id=int(case_id), user_id=user.id).first() is not None

    def update_case(self, case_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        mutable = {
            "title",
            "description",
            "legal_domain",
            "status",
            "priority",
            "desired_outcome",
            "current_summary",
            "court_or_institution",
            "risk_level",
        }
        with self.session_scope() as session:
            case = session.get(LegalCase, case_id)
            if not case:
                return None
            before = self._case_detail(session, case)
            for key in mutable:
                if key in data:
                    setattr(case, key, data[key])
            if "opposing_parties" in data:
                case.opposing_parties = _json_dump(data.get("opposing_parties") or [])
            if "parties" in data:
                session.query(Party).filter_by(case_id=case.id).delete()
                self._sync_parties(session, case.id, data.get("parties") or [])
            if self._has_identifier_payload(data):
                self._sync_case_identifiers(session, case.id, data, replace=bool(data.get("replace_identifiers", False)))
            case.updated_at = utcnow()
            session.flush()
            after = self._case_detail(session, case)
            self._audit(session, case.id, "LegalCase", case.id, "updated", actor, before, after, "medium")
            return self._case_detail(session, case)

    def add_case_identifier(self, case_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return None
            identifier = self._create_or_update_identifier(session, case_id, data)
            session.flush()
            serialized = self._serialize_identifier(identifier)
            self._audit(session, case_id, "CaseIdentifier", identifier.id, "created_or_updated", actor, {}, serialized, "low")
            return serialized

    def list_case_identifiers(self, case_id: int) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            return [
                self._serialize_identifier(item)
                for item in session.query(CaseIdentifier)
                .filter_by(case_id=case_id)
                .order_by(CaseIdentifier.identifier_type.asc(), CaseIdentifier.identifier_value.asc(), CaseIdentifier.id.asc())
                .all()
            ]

    def lookup_case_identifier(
        self,
        identifier_value: str,
        *,
        external_user_id: Any,
        identifier_type: Optional[str] = None,
        source_party: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        value = str(identifier_value or "").strip()
        owner = str(external_user_id or "").strip()
        if not value or not owner:
            return None
        with self.session_scope() as session:
            query = (
                session.query(CaseIdentifier, LegalCase)
                .join(LegalCase, CaseIdentifier.case_id == LegalCase.id)
                .join(LedgerUser, LegalCase.user_id == LedgerUser.id)
                .filter(
                    CaseIdentifier.identifier_value == value,
                    LedgerUser.external_user_id == owner,
                )
            )
            if identifier_type:
                query = query.filter(CaseIdentifier.identifier_type == str(identifier_type).strip())
            if source_party:
                query = query.filter(CaseIdentifier.source_party == str(source_party).strip())
            match = query.order_by(CaseIdentifier.updated_at.desc(), CaseIdentifier.id.desc()).first()
            if not match:
                return None
            identifier, case = match
            return {
                "identifier": self._serialize_identifier(identifier),
                "case": self._case_detail(session, case),
            }

    def _create_document_record(self, session, case_id: int, data: Dict[str, Any]) -> CaseDocument:
        text = data.get("extracted_text") or data.get("ocr_text") or data.get("content") or ""
        content_hash = data.get("content_hash") or self._hash("|".join([
            str(data.get("source_uri") or ""),
            str(data.get("local_path") or ""),
            str(data.get("original_filename") or data.get("document_name") or data.get("title") or ""),
            text,
        ]))
        document = CaseDocument(
            case_id=case_id,
            source_type=data.get("source_type") or data.get("source") or "manual",
            source_uri=data.get("source_uri") or data.get("source_url") or "",
            original_filename=data.get("original_filename") or data.get("document_name") or data.get("name") or "",
            local_path=data.get("local_path") or data.get("file_path") or "",
            content_hash=content_hash,
            document_type=data.get("document_type") or data.get("type") or "unknown",
            date_on_document=data.get("date_on_document") or data.get("document_date") or "",
            sender=data.get("sender") or data.get("from") or "",
            recipient=data.get("recipient") or data.get("to") or "",
            title=data.get("title") or data.get("document_name") or data.get("name") or "Untitled document",
            ocr_text=data.get("ocr_text") or "",
            extracted_text=text,
            summary=data.get("summary") or data.get("content_summary") or "",
            relevance_score=float(data.get("relevance_score") or 0.0),
            confidentiality_level=data.get("confidentiality_level") or "normal",
            metadata_json=_json_dump(data.get("metadata") or data.get("legal_analysis") or {}),
        )
        session.add(document)
        session.flush()
        self._add_document_version(session, document, text, data.get("extraction_method") or "initial_import")
        return document

    def add_document(self, case_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            case = session.get(LegalCase, case_id)
            if not case:
                return None
            document = self._create_document_record(session, case_id, data)
            self._audit(
                session, case_id, "CaseDocument", document.id, "created", actor,
                {}, self._document_creation_audit_state(document), "medium",
            )
            return self._serialize_document(document)

    def stage_document_inbox_item(
        self,
        external_user_id: Any,
        data: Dict[str, Any],
        *,
        suggested_matches: Optional[List[Dict[str, Any]]] = None,
        email: Optional[str] = None,
        actor: str = "system",
    ) -> Dict[str, Any]:
        """Persist an unassigned source and its review-only case suggestions."""
        with self.session_scope() as session:
            user = self._ensure_user(session, external_user_id, email)
            text = str(data.get("extracted_text") or data.get("ocr_text") or data.get("content") or "")
            source_uri = str(data.get("source_uri") or data.get("source_url") or "")
            content_hash = str(data.get("content_hash") or self._hash("|".join([
                source_uri,
                str(data.get("local_path") or ""),
                str(data.get("original_filename") or data.get("title") or ""),
                text,
            ])))
            existing = session.query(DocumentInboxItem).filter_by(
                user_id=user.id,
                content_hash=content_hash,
            ).order_by(DocumentInboxItem.id.desc()).first()
            if existing:
                payload = self._serialize_document_inbox_item(existing)
                payload["duplicate"] = True
                return payload

            owned_case_ids = {
                case_id for (case_id,) in session.query(LegalCase.id).filter_by(user_id=user.id).all()
            }
            matches = [
                dict(item) for item in (suggested_matches or [])
                if item.get("case_id") in owned_case_ids
            ][:5]
            top_match = matches[0] if matches else {}
            item = DocumentInboxItem(
                user_id=user.id,
                source_type=data.get("source_type") or data.get("source") or "manual",
                source_uri=source_uri or f"inbox://document/{content_hash[:20]}",
                original_filename=data.get("original_filename") or data.get("document_name") or data.get("name") or "",
                local_path=data.get("local_path") or data.get("file_path") or "",
                content_hash=content_hash,
                document_type=data.get("document_type") or data.get("type") or "unknown",
                date_on_document=data.get("date_on_document") or data.get("document_date") or "",
                sender=data.get("sender") or data.get("from") or "",
                recipient=data.get("recipient") or data.get("to") or "",
                title=data.get("title") or data.get("document_name") or data.get("name") or "Untitled inbox document",
                ocr_text=data.get("ocr_text") or "",
                extracted_text=text,
                summary=data.get("summary") or data.get("content_summary") or "",
                confidentiality_level=data.get("confidentiality_level") or "normal",
                analysis_json=_json_dump(data.get("analysis") or data.get("legal_analysis") or {}),
                metadata_json=_json_dump(data.get("metadata") or {}),
                suggested_matches_json=_json_dump(matches),
                suggested_case_id=top_match.get("case_id"),
                match_score=float(top_match.get("score") or 0.0),
                status="needs_review",
            )
            session.add(item)
            session.flush()
            self._audit(
                session, None, "DocumentInboxItem", item.id, "staged_for_case_review", actor,
                {}, self._document_inbox_audit_state(item), "medium",
                source="document_inbox", user_id=user.id,
            )
            payload = self._serialize_document_inbox_item(item)
            payload["duplicate"] = False
            return payload

    def list_document_inbox_items(
        self,
        external_user_id: Any,
        *,
        status: Optional[str] = None,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            user = session.query(LedgerUser).filter_by(external_user_id=str(external_user_id)).one_or_none()
            if not user:
                return []
            query = session.query(DocumentInboxItem).filter_by(user_id=user.id)
            if status:
                query = query.filter_by(status=str(status))
            return [
                self._serialize_document_inbox_item(item)
                for item in query.order_by(DocumentInboxItem.updated_at.desc(), DocumentInboxItem.id.desc())
                .limit(max(1, min(int(limit or 50), 100))).all()
            ]

    def get_document_inbox_item(self, item_id: int, external_user_id: Any) -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            user = session.query(LedgerUser).filter_by(external_user_id=str(external_user_id)).one_or_none()
            item = session.get(DocumentInboxItem, item_id)
            if not user or not item or item.user_id != user.id:
                return None
            return self._serialize_document_inbox_item(item)

    def review_document_inbox_item(
        self,
        item_id: int,
        external_user_id: Any,
        action: str,
        *,
        actor: str = "system",
    ) -> Optional[Dict[str, Any]]:
        normalized_action = str(action or "").strip().lower()
        if normalized_action not in {"dismiss", "reopen"}:
            raise ValueError("action must be dismiss or reopen")
        with self.session_scope() as session:
            user = session.query(LedgerUser).filter_by(external_user_id=str(external_user_id)).one_or_none()
            item = session.get(DocumentInboxItem, item_id)
            if not user or not item or item.user_id != user.id:
                return None
            if item.status == "linked":
                raise ValueError("A linked inbox source cannot be dismissed or reopened")
            before = self._document_inbox_audit_state(item)
            item.status = "dismissed" if normalized_action == "dismiss" else "needs_review"
            item.updated_at = utcnow()
            self._audit(
                session, None, "DocumentInboxItem", item.id, f"review_{normalized_action}", actor,
                before, self._document_inbox_audit_state(item), "medium",
                source="document_inbox", user_id=user.id,
            )
            return self._serialize_document_inbox_item(item)

    def link_document_inbox_item(
        self,
        item_id: int,
        case_id: int,
        external_user_id: Any,
        *,
        actor: str = "system",
    ) -> Optional[Dict[str, Any]]:
        """Link a staged source once; never move or delete source evidence implicitly."""
        with self.session_scope() as session:
            user = session.query(LedgerUser).filter_by(external_user_id=str(external_user_id)).one_or_none()
            item = session.get(DocumentInboxItem, item_id)
            case = session.get(LegalCase, case_id)
            if not user or not item or item.user_id != user.id or not case or case.user_id != user.id:
                return None
            if item.status == "linked":
                if item.linked_case_id != case_id:
                    raise ValueError("This inbox source is already linked to another case")
                document = session.get(CaseDocument, item.linked_document_id) if item.linked_document_id else None
                return {
                    "inbox_item": self._serialize_document_inbox_item(item),
                    "document": self._serialize_document(document) if document else None,
                    "created": False,
                    "analysis": _json_load(item.analysis_json, {}),
                }

            existing_query = session.query(CaseDocument).filter_by(case_id=case_id)
            existing = None
            if item.source_uri:
                existing = existing_query.filter_by(source_uri=item.source_uri).first()
            if not existing and item.content_hash:
                existing = existing_query.filter_by(content_hash=item.content_hash).first()

            created = existing is None
            if created:
                metadata = _json_load(item.metadata_json, {}) or {}
                analysis = _json_load(item.analysis_json, {}) or {}
                metadata.update({
                    "legal_analysis": analysis,
                    "document_inbox_item_id": item.id,
                    "linked_from_document_inbox": True,
                })
                document = self._create_document_record(session, case_id, {
                    "source_type": item.source_type,
                    "source_uri": item.source_uri,
                    "original_filename": item.original_filename,
                    "local_path": item.local_path,
                    "content_hash": item.content_hash,
                    "document_type": item.document_type,
                    "date_on_document": item.date_on_document,
                    "sender": item.sender,
                    "recipient": item.recipient,
                    "title": item.title,
                    "ocr_text": item.ocr_text,
                    "extracted_text": item.extracted_text,
                    "summary": item.summary,
                    "confidentiality_level": item.confidentiality_level,
                    "metadata": metadata,
                    "extraction_method": "document_inbox_link",
                })
                self._audit(
                    session, case_id, "CaseDocument", document.id, "created_from_document_inbox", actor,
                    {}, self._document_creation_audit_state(document), "medium",
                    source="document_inbox", user_id=user.id,
                )
            else:
                document = existing

            before = self._document_inbox_audit_state(item)
            item.status = "linked"
            item.linked_case_id = case_id
            item.linked_document_id = document.id
            item.linked_at = utcnow()
            item.updated_at = utcnow()
            self._audit(
                session, case_id, "DocumentInboxItem", item.id,
                "linked_to_case" if created else "linked_to_existing_document", actor,
                before, self._document_inbox_audit_state(item), "medium",
                source="document_inbox", user_id=user.id,
            )
            return {
                "inbox_item": self._serialize_document_inbox_item(item),
                "document": self._serialize_document(document),
                "created": created,
                "analysis": _json_load(item.analysis_json, {}),
            }

    def list_documents(self, case_id: int) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            return [
                self._serialize_document(document)
                for document in session.query(CaseDocument).filter_by(case_id=case_id).order_by(CaseDocument.created_at.desc()).all()
            ]

    def get_document(self, case_id: int, document_id: int) -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            document = session.query(CaseDocument).filter_by(case_id=case_id, id=document_id).one_or_none()
            if not document:
                return None
            return self._serialize_document(document)

    def list_document_versions(self, case_id: int, document_id: int) -> Optional[List[Dict[str, Any]]]:
        with self.session_scope() as session:
            document = session.query(CaseDocument).filter_by(case_id=case_id, id=document_id).one_or_none()
            if not document:
                return None
            return [
                self._serialize_document_version(item)
                for item in session.query(DocumentVersion)
                .filter_by(document_id=document.id)
                .order_by(DocumentVersion.id.desc())
                .all()
            ]

    def update_document_extraction(
        self,
        case_id: int,
        document_id: int,
        data: Dict[str, Any],
        actor: str = "system",
    ) -> Optional[Dict[str, Any]]:
        """Append a derived extraction without changing the original source record."""
        text = str(data.get("extracted_text") or data.get("ocr_text") or data.get("content") or "").strip()
        if not text:
            raise ValueError("Recovered document text is required before LARO can analyze this source")
        extraction_method = str(data.get("extraction_method") or "manual_text_recovery").strip()[:120] or "manual_text_recovery"
        with self.session_scope() as session:
            document = session.query(CaseDocument).filter_by(case_id=case_id, id=document_id).one_or_none()
            if not document:
                return None
            before = self._document_extraction_audit_state(document)
            metadata = _json_load(document.metadata_json, {})
            metadata.update(data.get("metadata") or {})
            metadata["extraction_recovery"] = {
                "method": extraction_method,
                "actor": actor,
                "source_preserved": True,
                "recovered_at": _iso(utcnow()),
            }
            document.extracted_text = text
            if data.get("ocr_text"):
                document.ocr_text = str(data["ocr_text"])
            document.summary = data.get("summary") or document.summary
            if data.get("relevance_score") is not None:
                document.relevance_score = float(data.get("relevance_score") or 0.0)
            document.metadata_json = _json_dump(metadata)
            document.updated_at = utcnow()
            version_number = session.query(DocumentVersion).filter_by(document_id=document.id).count() + 1
            self._add_document_version(
                session,
                document,
                text,
                extraction_method,
                version_label=f"extraction_{version_number}",
            )
            after = self._document_extraction_audit_state(document, version_number=version_number, extraction_method=extraction_method)
            self._audit(session, case_id, "CaseDocument", document.id, "extraction_recovered", actor, before, after, "medium")
            return self._serialize_document(document)

    def update_document_analysis(
        self,
        case_id: int,
        document_id: int,
        data: Dict[str, Any],
        actor: str = "system",
    ) -> Optional[Dict[str, Any]]:
        """Refresh derived analysis only; the source file and extraction history stay unchanged."""
        analysis = data.get("legal_analysis") or data.get("analysis") or {}
        if not isinstance(analysis, dict) or not analysis:
            raise ValueError("A structured document analysis is required")
        with self.session_scope() as session:
            document = session.query(CaseDocument).filter_by(case_id=case_id, id=document_id).one_or_none()
            if not document:
                return None
            before = self._document_analysis_audit_state(document)
            metadata = _json_load(document.metadata_json, {})
            metadata["legal_analysis"] = analysis
            metadata["analysis_refresh"] = {
                "actor": actor,
                "source_preserved": True,
                "refreshed_at": _iso(utcnow()),
                "method": ((analysis.get("processing") or {}).get("analysis_method") or "document_analysis"),
            }
            document.metadata_json = _json_dump(metadata)
            document.summary = data.get("summary") or analysis.get("summary") or document.summary
            if data.get("relevance_score") is not None:
                document.relevance_score = float(data.get("relevance_score") or 0.0)
            document.updated_at = utcnow()
            after = self._document_analysis_audit_state(document)
            self._audit(session, case_id, "CaseDocument", document.id, "analysis_refreshed", actor, before, after, "low")
            return self._serialize_document(document)

    def create_case_analysis_run(
        self,
        case_id: int,
        data: Dict[str, Any],
        actor: str = "system",
    ) -> Optional[Dict[str, Any]]:
        """Persist a review-only case synthesis with a hash-only audit record."""
        content = data.get("content") or data.get("analysis") or {}
        if not isinstance(content, dict):
            raise ValueError("Case analysis content must be structured data")
        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return None
            item = CaseAnalysisRun(
                case_id=case_id,
                analysis_type=str(data.get("analysis_type") or "cross_document")[:80],
                status=str(data.get("status") or content.get("status") or "needs_review")[:80],
                provider=str(data.get("provider") or content.get("provider") or "rule_based")[:80],
                model=str(data.get("model") or content.get("model") or "")[:255],
                content_json=_json_dump(content),
                source_snapshot_json=_json_dump(data.get("source_documents") or content.get("source_documents") or []),
            )
            session.add(item)
            session.flush()
            self._ensure_case_analysis_review_items(session, case_id, item)
            self._sync_case_analysis_coverage_warning(session, case_id, item)
            self._audit(
                session,
                case_id,
                "CaseAnalysisRun",
                item.id,
                "created",
                actor,
                {},
                self._case_analysis_audit_state(item),
                "low",
            )
            return self._serialize_case_analysis_run(item, self._case_analysis_review_items_for_run(session, item.id))

    def list_case_analysis_runs(self, case_id: int, limit: int = 12) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return []
            self._ensure_case_analysis_review_items(session, case_id)
            return [
                self._serialize_case_analysis_run(item, self._case_analysis_review_items_for_run(session, item.id))
                for item in session.query(CaseAnalysisRun)
                .filter_by(case_id=case_id)
                .order_by(CaseAnalysisRun.created_at.desc(), CaseAnalysisRun.id.desc())
                .limit(max(1, min(int(limit or 12), 50)))
                .all()
            ]

    def create_case_analysis_job(
        self,
        case_id: int,
        data: Dict[str, Any],
        actor: str = "system",
    ) -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return None
            active = session.query(CaseAnalysisJob).filter(
                CaseAnalysisJob.case_id == case_id,
                CaseAnalysisJob.status.in_(("queued", "running")),
            ).order_by(CaseAnalysisJob.id.desc()).first()
            if active:
                return self._serialize_case_analysis_job(active)
            job = CaseAnalysisJob(
                case_id=case_id,
                provider=str(data.get("provider") or "rule_based")[:80],
                model=str(data.get("model") or "")[:255],
                status="queued",
                stage="Queued for full-source local analysis",
                total_documents=max(0, int(data.get("total_documents") or 0)),
                total_words=max(0, int(data.get("total_words") or 0)),
                total_characters=max(0, int(data.get("total_characters") or 0)),
                estimated_total_seconds=max(0, int(data.get("estimated_total_seconds") or 0)),
            )
            session.add(job)
            session.flush()
            serialized = self._serialize_case_analysis_job(job)
            self._audit(
                session,
                case_id,
                "CaseAnalysisJob",
                job.id,
                "created",
                actor,
                {},
                self._case_analysis_job_audit_state(job),
                "low",
                source="local_case_analysis_job",
            )
            return serialized

    def get_case_analysis_job(self, case_id: int, job_id: int) -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            job = session.get(CaseAnalysisJob, job_id)
            if not job or job.case_id != case_id:
                return None
            return self._serialize_case_analysis_job(job)

    def list_case_analysis_jobs(
        self,
        case_id: int,
        status: Optional[str] = None,
        limit: int = 20,
    ) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return []
            query = session.query(CaseAnalysisJob).filter_by(case_id=case_id)
            if status:
                query = query.filter_by(status=str(status).strip().lower())
            return [
                self._serialize_case_analysis_job(item)
                for item in query.order_by(CaseAnalysisJob.updated_at.desc(), CaseAnalysisJob.id.desc())
                .limit(max(1, min(int(limit or 20), 50)))
                .all()
            ]

    def update_case_analysis_job(
        self,
        case_id: int,
        job_id: int,
        data: Dict[str, Any],
        actor: str = "system",
    ) -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            job = session.get(CaseAnalysisJob, job_id)
            if not job or job.case_id != case_id:
                return None
            previous_status = job.status
            for field_name in (
                "stage", "current_item", "total_documents", "completed_documents",
                "total_chunks", "completed_chunks", "total_words", "processed_words",
                "total_characters", "processed_characters", "estimated_total_seconds", "error",
            ):
                if field_name in data:
                    setattr(job, field_name, data[field_name])
            if "result" in data:
                job.result_json = _json_dump(data["result"] if isinstance(data["result"], dict) else {})
            if data.get("run_id") is not None:
                job.run_id = int(data["run_id"])
            if data.get("status"):
                job.status = str(data["status"]).strip().lower()
            if job.status == "running" and not job.started_at:
                job.started_at = utcnow()
            if job.status in {"completed", "failed"} and not job.completed_at:
                job.completed_at = utcnow()
            job.updated_at = utcnow()
            session.flush()
            serialized = self._serialize_case_analysis_job(job)
            if job.status in {"completed", "failed"} and previous_status != job.status:
                self._audit(
                    session,
                    case_id,
                    "CaseAnalysisJob",
                    job.id,
                    job.status,
                    actor,
                    {},
                    self._case_analysis_job_audit_state(job),
                    "low",
                    source="local_case_analysis_job",
                )
            return serialized

    def fail_interrupted_case_analysis_jobs(self, actor: str = "system") -> int:
        """Close jobs left active by a previous local process before accepting retries."""
        with self.session_scope() as session:
            jobs = session.query(CaseAnalysisJob).filter(
                CaseAnalysisJob.status.in_(("queued", "running"))
            ).all()
            for job in jobs:
                job.status = "failed"
                job.stage = "Analysis interrupted by local restart"
                job.error = (
                    "LARO restarted before this full-source reading completed. "
                    "Start the reading again; source documents and prior completed runs were not changed."
                )
                job.completed_at = utcnow()
                job.updated_at = utcnow()
                session.flush()
                self._audit(
                    session,
                    job.case_id,
                    "CaseAnalysisJob",
                    job.id,
                    "failed",
                    actor,
                    {},
                    self._case_analysis_job_audit_state(job),
                    "low",
                    source="local_process_recovery",
                )
            return len(jobs)

    def list_case_analysis_review_items(self, case_id: int) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return []
            self._ensure_case_analysis_review_items(session, case_id)
            return [
                self._serialize_case_analysis_review_item(item)
                for item in session.query(CaseAnalysisReviewItem)
                .filter_by(case_id=case_id)
                .order_by(CaseAnalysisReviewItem.created_at.desc(), CaseAnalysisReviewItem.id.desc())
                .all()
            ]

    def update_case_analysis_review_item(
        self,
        case_id: int,
        item_id: int,
        data: Dict[str, Any],
        actor: str = "system",
    ) -> Optional[Dict[str, Any]]:
        """Convert a cited observation only after an explicit user decision."""
        action = str(data.get("action") or "").strip().lower()
        if action not in {"timeline", "confirm_timeline", "contradiction", "claim", "follow_up", "dismiss", "reopen"}:
            raise ValueError("Case analysis action must be timeline, confirm_timeline, contradiction, claim, follow_up, dismiss, or reopen")

        with self.session_scope() as session:
            item = session.get(CaseAnalysisReviewItem, item_id)
            if not item or item.case_id != case_id:
                return None
            before = self._case_analysis_review_item_audit_state(item)
            sources = _json_load(item.source_refs, [])

            if action == "dismiss":
                item.status = "dismissed"
                item.updated_at = utcnow()
                self._audit(
                    session, case_id, "CaseAnalysisReviewItem", item.id, "dismissed", actor,
                    before, self._case_analysis_review_item_audit_state(item), "low",
                )
                return self._serialize_case_analysis_review_item(item)

            if action == "reopen":
                item.status = "needs_review"
                item.target_type = ""
                item.target_id = None
                item.updated_at = utcnow()
                self._audit(
                    session, case_id, "CaseAnalysisReviewItem", item.id, "reopened", actor,
                    before, self._case_analysis_review_item_audit_state(item), "low",
                )
                return self._serialize_case_analysis_review_item(item)

            if item.status == "converted":
                raise ValueError("This case-wide observation was already converted. Reopen it before creating another ledger item.")
            if not sources:
                raise ValueError("This case-wide observation has no validated source citations.")
            if action == "confirm_timeline" and item.item_type != "timeline_suggestion":
                raise ValueError("Only a cited timeline proposal can be confirmed directly into the chronology.")
            if action == "contradiction" and len(sources) < 2:
                raise ValueError("A contradiction needs at least two validated source citations.")

            if action in {"timeline", "confirm_timeline"}:
                event_date = next((str(source.get("event_date") or "").strip() for source in sources if source.get("event_date")), "")
                try:
                    event_date = _dt.date.fromisoformat(event_date).isoformat()
                except ValueError:
                    raise ValueError("A timeline proposal needs an unambiguous cited ISO date.")
                target = None
                source_document_ids = {int(source["document_id"]) for source in sources}
                candidates = session.query(CaseEvent).filter(
                    CaseEvent.case_id == case_id,
                    CaseEvent.event_date == event_date,
                    CaseEvent.created_from_document_id.in_(source_document_ids),
                    CaseEvent.event_type != "rejected_suggestion",
                ).all()
                for candidate in candidates:
                    for source in sources:
                        existing_link = session.query(EvidenceLink).filter_by(
                            case_id=case_id,
                            document_id=int(source["document_id"]),
                            target_type="event",
                            target_id=candidate.id,
                            snippet=source["source_quote"],
                        ).first()
                        if existing_link:
                            target = candidate
                            break
                    if target:
                        break
                if not target:
                    event_actor = next((str(source.get("actor") or "").strip() for source in sources if source.get("actor")), "")
                    event_action = next((str(source.get("action") or "").strip() for source in sources if source.get("action")), "")
                    event_affected_party = next((str(source.get("affected_party") or "").strip() for source in sources if source.get("affected_party")), "")
                    event_kind = next((str(source.get("event_kind") or "").strip() for source in sources if source.get("event_kind")), "event")
                    target = CaseEvent(
                        case_id=case_id,
                        event_date=event_date,
                        event_type="confirmed_from_case_analysis" if action == "confirm_timeline" else "case_analysis_suggestion",
                        event_kind=str(data.get("event_kind") or event_kind)[:80],
                        title=item.title or "Case-wide timeline proposal",
                        description=item.description,
                        actor=str(data.get("actor") or event_actor)[:255],
                        action=str(data.get("event_action") or data.get("action_label") or event_action)[:120],
                        affected_party=str(data.get("affected_party") or event_affected_party)[:255],
                        source_confidence=0.0,
                        user_confirmed=action == "confirm_timeline",
                        created_from_document_id=sources[0]["document_id"],
                    )
                    session.add(target)
                    session.flush()
                    self._audit(session, case_id, "CaseEvent", target.id, "created", actor, {}, self._serialize_event(target), "medium")
                elif action == "confirm_timeline" and not target.user_confirmed:
                    target_before = self._serialize_event(target)
                    target.user_confirmed = True
                    if target.event_type in {"case_analysis_suggestion", "suggested_from_document", "rejected_suggestion"}:
                        target.event_type = "confirmed_from_case_analysis"
                    target.updated_at = utcnow()
                    self._audit(session, case_id, "CaseEvent", target.id, "confirmed", actor, target_before, self._serialize_event(target), "medium")
                target_type = "event"
            elif action == "contradiction":
                target = Contradiction(
                    case_id=case_id,
                    contradiction_type="cross_document_analysis",
                    title=item.title or "Case-wide source conflict",
                    description=item.description,
                    status="needs_review",
                    severity="medium",
                    source_refs=_json_dump(sources),
                )
                session.add(target)
                session.flush()
                target_type = "contradiction"
                self._audit(session, case_id, "Contradiction", target.id, "created", actor, {}, self._serialize_contradiction(target), "medium")
            elif action == "claim":
                target = LegalClaim(
                    case_id=case_id,
                    asserted_by="case_analysis",
                    position_role="source",
                    claim_type="cross_document_observation",
                    materiality="medium",
                    statement=item.description,
                    status="needs_review",
                    confidence=0.0,
                )
                session.add(target)
                session.flush()
                target_type = "claim"
                self._audit(session, case_id, "LegalClaim", target.id, "created", actor, {}, self._serialize_claim(target), "medium")
            else:
                target = OpenLoop(
                    case_id=case_id,
                    title=item.title or "Verify case-wide observation",
                    description=item.description,
                    owner="robert",
                    status="open",
                    next_action="Open each cited source and decide how this observation should affect the case record.",
                    risk_level="medium",
                )
                session.add(target)
                session.flush()
                target_type = "open_loop"
                self._audit(session, case_id, "OpenLoop", target.id, "created", actor, {}, self._serialize_open_loop(target), "medium")

            for source in sources:
                existing_link = session.query(EvidenceLink).filter_by(
                    case_id=case_id,
                    document_id=int(source["document_id"]),
                    target_type=target_type,
                    target_id=target.id,
                    snippet=source["source_quote"],
                ).first()
                if existing_link:
                    if action == "confirm_timeline" and (not existing_link.user_confirmed or existing_link.relationship != "supports"):
                        link_before = self._serialize_evidence_link(existing_link)
                        existing_link.user_confirmed = True
                        existing_link.relationship = "supports"
                        self._audit(
                            session, case_id, "EvidenceLink", existing_link.id, "confirmed", actor,
                            link_before, self._serialize_evidence_link(existing_link), "medium",
                        )
                    continue
                link = self._create_evidence_link(
                    session,
                    case_id=case_id,
                    document_id=source["document_id"],
                    target_type=target_type,
                    target_id=target.id,
                    snippet=source["source_quote"],
                    relationship="supports" if action == "confirm_timeline" else "needs_review",
                    strength="medium",
                    source_confidence=0.0,
                    user_confirmed=action == "confirm_timeline",
                )
                self._audit(session, case_id, "EvidenceLink", link.id, "created", actor, {}, self._serialize_evidence_link(link), "medium")

            item.status = "converted"
            item.target_type = target_type
            item.target_id = target.id
            item.updated_at = utcnow()
            self._audit(
                session, case_id, "CaseAnalysisReviewItem", item.id,
                "confirmed_as_event" if action == "confirm_timeline" else f"converted_to_{target_type}", actor,
                before, self._case_analysis_review_item_audit_state(item), "medium",
            )
            return self._serialize_case_analysis_review_item(item)

    def add_event(self, case_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return None
            event = CaseEvent(
                case_id=case_id,
                event_date=data.get("event_date") or data.get("date") or utcnow().date().isoformat(),
                event_type=data.get("event_type") or data.get("type") or "event",
                event_kind=data.get("event_kind") or data.get("category") or "event",
                title=data.get("title") or data.get("event_label") or "Timeline event",
                description=data.get("description") or data.get("summary") or "",
                actor=data.get("actor") or "",
                action=data.get("event_action") or data.get("action_label") or data.get("timeline_action") or data.get("action") or "",
                affected_party=data.get("affected_party") or data.get("recipient") or "",
                source_confidence=float(data.get("source_confidence") or data.get("confidence") or 0.0),
                user_confirmed=bool(data.get("user_confirmed", False)),
                created_from_document_id=data.get("created_from_document_id") or data.get("source_document_id"),
            )
            session.add(event)
            session.flush()
            if event.created_from_document_id:
                self._create_evidence_link(
                    session,
                    case_id=case_id,
                    document_id=event.created_from_document_id,
                    target_type="event",
                    target_id=event.id,
                    snippet=data.get("evidence_quote") or event.description,
                    relationship="supports",
                    strength=data.get("strength") or "medium",
                    source_confidence=event.source_confidence,
                    user_confirmed=event.user_confirmed,
                )
            self._audit(session, case_id, "CaseEvent", event.id, "created", actor, {}, self._serialize_event(event), "medium")
            return self._serialize_event(event)

    def update_event(self, case_id: int, event_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        action = (data.get("action") or data.get("review_action") or "update").strip().lower()
        if action not in {"update", "edit", "approve", "reject"}:
            raise ValueError("Timeline action must be update, edit, approve, or reject")

        with self.session_scope() as session:
            event = session.get(CaseEvent, event_id)
            if not event or event.case_id != case_id:
                return None
            before = self._serialize_event(event)

            for key, attr in {
                "event_date": "event_date",
                "date": "event_date",
                "event_type": "event_type",
                "event_kind": "event_kind",
                "category": "event_kind",
                "title": "title",
                "description": "description",
                "summary": "description",
                "actor": "actor",
                "event_action": "action",
                "action_label": "action",
                "timeline_action": "action",
                "affected_party": "affected_party",
                "recipient": "affected_party",
            }.items():
                if key in data and data[key] not in {None, ""}:
                    setattr(event, attr, data[key])

            if "source_confidence" in data or "confidence" in data:
                event.source_confidence = float(data.get("source_confidence") or data.get("confidence") or 0.0)

            if action == "approve":
                event.user_confirmed = True
                if event.event_type in {"suggested_from_document", "rejected_suggestion"}:
                    event.event_type = "confirmed_from_document"
            elif action == "reject":
                event.user_confirmed = False
                event.event_type = "rejected_suggestion"
            elif "user_confirmed" in data:
                event.user_confirmed = bool(data.get("user_confirmed"))
                if event.user_confirmed and event.event_type == "suggested_from_document":
                    event.event_type = "confirmed_from_document"

            event.updated_at = utcnow()
            for link in session.query(EvidenceLink).filter_by(case_id=case_id, target_type="event", target_id=event.id).all():
                link.user_confirmed = event.user_confirmed
                if action == "reject":
                    link.relationship = "rejected_suggestion"

            self._audit(session, case_id, "CaseEvent", event.id, action, actor, before, self._serialize_event(event), "medium")
            return self._serialize_event(event)

    def list_timeline(self, case_id: int) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            documents = {
                item.id: item
                for item in session.query(CaseDocument).filter_by(case_id=case_id).all()
            }
            timeline = []
            for event in session.query(CaseEvent).filter_by(case_id=case_id).order_by(CaseEvent.event_date.asc(), CaseEvent.id.asc()).all():
                payload = self._serialize_event(event)
                source_document = documents.get(event.created_from_document_id)
                if source_document:
                    payload["source"] = {
                        "document_id": source_document.id,
                        "title": source_document.title or source_document.original_filename or "Source document",
                        "source_type": source_document.source_type,
                        "source_uri": source_document.source_uri,
                    }
                    payload["source_uri"] = source_document.source_uri
                timeline.append(payload)
            return timeline

    def add_claim(self, case_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        statement = str(data.get("statement") or data.get("description") or "").strip()
        if not statement:
            raise ValueError("Claim statement is required")
        position_role = str(data.get("position_role") or "unknown").strip().lower()
        if position_role not in CLAIM_POSITION_ROLES:
            raise ValueError("Claim position_role must be client, counterparty, institution, court, third_party, source, or unknown")
        materiality = str(data.get("materiality") or "medium").strip().lower()
        if materiality not in CLAIM_MATERIALITY_LEVELS:
            raise ValueError("Claim materiality must be low, medium, high, or critical")
        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return None
            claim = LegalClaim(
                case_id=case_id,
                asserted_by=data.get("asserted_by") or "user",
                position_role=position_role,
                subject_party=data.get("subject_party") or "",
                claim_type=data.get("claim_type") or "factual",
                materiality=materiality,
                statement=statement,
                status=data.get("status") or "unreviewed",
                confidence=float(data.get("confidence") or 0.0),
            )
            session.add(claim)
            session.flush()
            self._audit(session, case_id, "LegalClaim", claim.id, "created", actor, {}, self._serialize_claim(claim), "medium")
            return self._serialize_claim(claim)

    def list_claims(self, case_id: int) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            return [self._serialize_claim(claim) for claim in session.query(LegalClaim).filter_by(case_id=case_id).order_by(LegalClaim.id.desc()).all()]

    def update_claim(self, case_id: int, claim_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        action = (data.get("action") or "update").strip().lower()
        if action not in {"update", "confirm", "dismiss", "reopen"}:
            raise ValueError("Claim action must be update, confirm, dismiss, or reopen")

        with self.session_scope() as session:
            claim = session.get(LegalClaim, claim_id)
            if not claim or claim.case_id != case_id:
                return None
            before = self._serialize_claim(claim)

            position_role = str(data.get("position_role") or claim.position_role or "unknown").strip().lower()
            materiality = str(data.get("materiality") or claim.materiality or "medium").strip().lower()
            if position_role not in CLAIM_POSITION_ROLES:
                raise ValueError("Claim position_role must be client, counterparty, institution, court, third_party, source, or unknown")
            if materiality not in CLAIM_MATERIALITY_LEVELS:
                raise ValueError("Claim materiality must be low, medium, high, or critical")

            for key in ("asserted_by", "position_role", "subject_party", "claim_type", "materiality", "statement"):
                if key in data and data[key] is not None and (key == "subject_party" or data[key] != ""):
                    value = position_role if key == "position_role" else materiality if key == "materiality" else data[key]
                    setattr(claim, key, value)
            if "confidence" in data and data["confidence"] not in {None, ""}:
                claim.confidence = float(data["confidence"])

            if action == "confirm":
                claim.status = "confirmed"
            elif action == "dismiss":
                claim.status = "dismissed"
            elif action == "reopen":
                claim.status = data.get("status") or "needs_review"
            elif "status" in data and data["status"]:
                claim.status = data["status"]

            claim.updated_at = utcnow()
            audit_action = {"confirm": "confirmed", "dismiss": "dismissed", "reopen": "reopened"}.get(action, "updated")
            self._audit(session, case_id, "LegalClaim", claim.id, audit_action, actor, before, self._serialize_claim(claim), "medium")
            return self._serialize_claim(claim)

    def add_evidence_link(self, case_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        target_type = str(data.get("target_type") or "claim").strip().lower()
        relationship = str(data.get("relationship") or "supports").strip().lower()
        snippet = str(data.get("snippet") or "").strip()
        user_confirmed = bool(data.get("user_confirmed", False))
        if target_type == "claim":
            if not snippet:
                raise ValueError("Claim evidence requires an exact source snippet")
            if user_confirmed and relationship not in CLAIM_EVIDENCE_RELATIONSHIPS:
                raise ValueError("Confirmed claim evidence must be classified as supports, disputes, or context")
        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return None
            link = self._create_evidence_link(
                session,
                case_id=case_id,
                document_id=data.get("document_id"),
                target_type=target_type,
                target_id=data.get("target_id"),
                snippet=snippet,
                relationship=relationship,
                strength=data.get("strength") or "medium",
                source_confidence=float(data.get("source_confidence") or 0.0),
                user_confirmed=user_confirmed,
            )
            self._audit(session, case_id, "EvidenceLink", link.id, "created", actor, {}, self._serialize_evidence_link(link), "medium")
            return self._serialize_evidence_link(link)

    def list_evidence_links(self, case_id: int) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            return [
                self._serialize_evidence_link(link)
                for link in session.query(EvidenceLink).filter_by(case_id=case_id).order_by(EvidenceLink.id.desc()).all()
            ]

    def update_evidence_link(self, case_id: int, link_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        action = (data.get("action") or "update").strip().lower()
        if action not in {"update", "confirm", "reject", "reopen"}:
            raise ValueError("Evidence action must be update, confirm, reject, or reopen")

        with self.session_scope() as session:
            link = session.get(EvidenceLink, link_id)
            if not link or link.case_id != case_id:
                return None
            before = self._serialize_evidence_link(link)

            target_type = str(data.get("target_type") or link.target_type or "").strip().lower()
            relationship = str(data.get("relationship") or link.relationship or "").strip().lower()
            snippet = str(data.get("snippet") if "snippet" in data else link.snippet or "").strip()
            confirming = action == "confirm" or (action == "update" and bool(data.get("user_confirmed", link.user_confirmed)))
            if target_type == "claim":
                if not snippet:
                    raise ValueError("Claim evidence requires an exact source snippet")
                if confirming and relationship not in CLAIM_EVIDENCE_RELATIONSHIPS:
                    raise ValueError("Choose whether this source supports, disputes, or contextualizes the claim before confirming it")

            for key in ("target_type", "snippet", "relationship", "strength"):
                if key in data and data[key] not in {None, ""}:
                    value = target_type if key == "target_type" else relationship if key == "relationship" else snippet if key == "snippet" else data[key]
                    setattr(link, key, value)
            if "target_id" in data and data["target_id"] not in {None, ""}:
                link.target_id = int(data["target_id"])
            if "document_id" in data and data["document_id"] not in {None, ""}:
                link.document_id = int(data["document_id"])
            if "source_confidence" in data and data["source_confidence"] not in {None, ""}:
                link.source_confidence = float(data["source_confidence"])

            if action == "confirm":
                link.user_confirmed = True
                link.relationship = relationship
            elif action == "reject":
                link.user_confirmed = False
                link.relationship = "rejected_suggestion"
            elif action == "reopen":
                link.user_confirmed = False
                if link.relationship == "rejected_suggestion":
                    link.relationship = data.get("relationship") or "needs_review"
            elif "user_confirmed" in data:
                link.user_confirmed = bool(data["user_confirmed"])

            audit_action = {"confirm": "confirmed", "reject": "rejected", "reopen": "reopened"}.get(action, "updated")
            self._audit(session, case_id, "EvidenceLink", link.id, audit_action, actor, before, self._serialize_evidence_link(link), "medium")
            return self._serialize_evidence_link(link)

    def add_contradiction(self, case_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return None
            contradiction = Contradiction(
                case_id=case_id,
                contradiction_type=data.get("contradiction_type") or data.get("type") or "conflict",
                title=data.get("title") or "Potential contradiction",
                description=data.get("description") or "",
                status=data.get("status") or "needs_review",
                severity=data.get("severity") or "medium",
                source_refs=_json_dump(data.get("source_refs") or data.get("sources") or []),
            )
            session.add(contradiction)
            session.flush()
            self._audit(session, case_id, "Contradiction", contradiction.id, "created", actor, {}, self._serialize_contradiction(contradiction), "medium")
            return self._serialize_contradiction(contradiction)

    def list_contradictions(self, case_id: int) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            return [self._serialize_contradiction(item) for item in session.query(Contradiction).filter_by(case_id=case_id).order_by(Contradiction.id.desc()).all()]

    def update_contradiction(self, case_id: int, contradiction_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        action = (data.get("action") or "update").strip().lower()
        if action not in {"update", "resolve", "dismiss", "reopen"}:
            raise ValueError("Contradiction action must be update, resolve, dismiss, or reopen")

        with self.session_scope() as session:
            item = session.get(Contradiction, contradiction_id)
            if not item or item.case_id != case_id:
                return None
            before = self._serialize_contradiction(item)

            for key in ("contradiction_type", "title", "description", "severity"):
                if key in data:
                    setattr(item, key, data[key] or "")
            if "source_refs" in data or "sources" in data:
                item.source_refs = _json_dump(data.get("source_refs") or data.get("sources") or [])

            if action == "resolve":
                item.status = "resolved"
            elif action == "dismiss":
                item.status = "dismissed"
            elif action == "reopen":
                item.status = data.get("status") or "needs_review"
            elif "status" in data:
                item.status = data.get("status") or item.status

            item.updated_at = utcnow()
            after = self._serialize_contradiction(item)
            audit_action = {"resolve": "resolved", "dismiss": "dismissed", "reopen": "reopened"}.get(action, "updated")
            self._audit(session, case_id, "Contradiction", item.id, audit_action, actor, before, after, item.severity or "medium")
            return after

    def add_missing_evidence_warning(self, case_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return None
            warning = MissingEvidenceWarning(
                case_id=case_id,
                claim_id=data.get("claim_id"),
                document_id=data.get("document_id"),
                warning_type=data.get("warning_type") or data.get("type") or "missing_evidence",
                title=data.get("title") or "Missing evidence",
                description=data.get("description") or "",
                suggested_action=data.get("suggested_action") or data.get("next_action") or "",
                status=data.get("status") or "needs_review",
                severity=data.get("severity") or "medium",
            )
            session.add(warning)
            session.flush()
            self._audit(session, case_id, "MissingEvidenceWarning", warning.id, "created", actor, {}, self._serialize_missing_evidence(warning), "medium")
            return self._serialize_missing_evidence(warning)

    def list_missing_evidence(self, case_id: int, refresh: bool = True) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return []
            if refresh:
                self._ensure_missing_evidence_reviews(session, case_id)
            return [
                self._serialize_missing_evidence(item)
                for item in session.query(MissingEvidenceWarning)
                .filter_by(case_id=case_id)
                .order_by(MissingEvidenceWarning.status.asc(), MissingEvidenceWarning.updated_at.desc(), MissingEvidenceWarning.id.desc())
                .all()
            ]

    def update_missing_evidence_warning(self, case_id: int, warning_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        action = (data.get("action") or "update").strip().lower()
        if action not in {"update", "resolve", "dismiss", "reopen"}:
            raise ValueError("Missing-evidence action must be update, resolve, dismiss, or reopen")

        with self.session_scope() as session:
            item = session.get(MissingEvidenceWarning, warning_id)
            if not item or item.case_id != case_id:
                return None
            before = self._serialize_missing_evidence(item)

            for key in ("claim_id", "document_id", "warning_type", "title", "description", "suggested_action", "severity"):
                if key in data:
                    setattr(item, key, data[key] if data[key] is not None else None)

            if action == "resolve":
                item.status = "resolved"
            elif action == "dismiss":
                item.status = "dismissed"
            elif action == "reopen":
                item.status = data.get("status") or "needs_review"
            elif "status" in data:
                item.status = data.get("status") or item.status

            item.updated_at = utcnow()
            after = self._serialize_missing_evidence(item)
            audit_action = {"resolve": "resolved", "dismiss": "dismissed", "reopen": "reopened"}.get(action, "updated")
            self._audit(session, case_id, "MissingEvidenceWarning", item.id, audit_action, actor, before, after, item.severity or "medium")
            return after

    def add_deadline(self, case_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return None
            deadline = Deadline(
                case_id=case_id,
                due_date=data.get("due_date") or data.get("date") or "",
                title=data.get("title") or "Deadline",
                description=data.get("description") or "",
                deadline_type=data.get("deadline_type") or data.get("type") or "action",
                status=data.get("status") or "open",
                source_document_id=data.get("source_document_id"),
                requires_approval=bool(data.get("requires_approval", True)),
            )
            session.add(deadline)
            session.flush()
            self._audit(session, case_id, "Deadline", deadline.id, "created", actor, {}, self._serialize_deadline(deadline), "medium")
            return self._serialize_deadline(deadline)

    def list_deadlines(self, case_id: int) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            return [self._serialize_deadline(item) for item in session.query(Deadline).filter_by(case_id=case_id).order_by(Deadline.due_date.asc()).all()]

    def update_deadline(self, case_id: int, deadline_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        action = (data.get("action") or "update").strip().lower()
        if action not in {"update", "confirm", "resolve", "reopen"}:
            raise ValueError("Deadline action must be update, confirm, resolve, or reopen")

        with self.session_scope() as session:
            deadline = session.get(Deadline, deadline_id)
            if not deadline or deadline.case_id != case_id:
                return None
            before = self._serialize_deadline(deadline)

            for key in ("due_date", "title", "description", "deadline_type"):
                if key in data:
                    setattr(deadline, key, data[key] or "")
            if "requires_approval" in data:
                deadline.requires_approval = bool(data.get("requires_approval"))

            if action == "confirm":
                deadline.status = "confirmed"
                deadline.requires_approval = False
            elif action == "resolve":
                deadline.status = "resolved"
                deadline.requires_approval = False
            elif action == "reopen":
                deadline.status = data.get("status") or "open"
                deadline.requires_approval = bool(data.get("requires_approval", True))
            elif "status" in data:
                deadline.status = data.get("status") or deadline.status

            deadline.updated_at = utcnow()
            after = self._serialize_deadline(deadline)
            audit_action = {"confirm": "confirmed", "resolve": "resolved", "reopen": "reopened"}.get(action, "updated")
            self._audit(session, case_id, "Deadline", deadline.id, audit_action, actor, before, after, "medium")
            return after

    def add_obligation(self, case_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return None
            source_document_id = data.get("source_document_id")
            if source_document_id:
                source_document = session.get(CaseDocument, int(source_document_id))
                if not source_document or source_document.case_id != case_id:
                    raise ValueError("Obligation source document must belong to the same case")
                if not str(data.get("source_quote") or data.get("quote") or "").strip():
                    raise ValueError("An exact source_quote is required when linking an obligation to a document")
            item = Obligation(
                case_id=case_id,
                title=data.get("title") or "Obligation",
                description=data.get("description") or "",
                responsible_party=data.get("responsible_party") or data.get("owner") or "unassigned",
                beneficiary_party=data.get("beneficiary_party") or "",
                obligation_type=data.get("obligation_type") or data.get("type") or "action",
                due_date=data.get("due_date") or "",
                status=data.get("status") or "needs_review",
                risk_level=data.get("risk_level") or "medium",
                source_document_id=source_document_id,
                source_quote=data.get("source_quote") or data.get("quote") or "",
                source_confidence=float(data.get("source_confidence") or 0.0),
                user_confirmed=bool(data.get("user_confirmed", False)),
            )
            session.add(item)
            session.flush()
            self._audit(session, case_id, "Obligation", item.id, "created", actor, {}, self._serialize_obligation(item), item.risk_level)
            return self._serialize_obligation(item)

    def list_obligations(self, case_id: int) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            return [
                self._serialize_obligation(item)
                for item in session.query(Obligation)
                .filter_by(case_id=case_id)
                .order_by(Obligation.due_date.asc(), Obligation.id.desc())
                .all()
            ]

    def update_obligation(self, case_id: int, obligation_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        action = (data.get("action") or "update").strip().lower()
        if action not in {"update", "confirm", "resolve", "dismiss", "reopen"}:
            raise ValueError("Obligation action must be update, confirm, resolve, dismiss, or reopen")

        with self.session_scope() as session:
            item = session.get(Obligation, obligation_id)
            if not item or item.case_id != case_id:
                return None
            before = self._serialize_obligation(item)

            for key in (
                "title",
                "description",
                "responsible_party",
                "beneficiary_party",
                "obligation_type",
                "due_date",
                "risk_level",
                "source_quote",
            ):
                if key in data:
                    setattr(item, key, data[key] or "")
            if "source_document_id" in data:
                source_document_id = data.get("source_document_id")
                if source_document_id:
                    source_document = session.get(CaseDocument, int(source_document_id))
                    if not source_document or source_document.case_id != case_id:
                        raise ValueError("Obligation source document must belong to the same case")
                item.source_document_id = source_document_id
            if item.source_document_id and not str(item.source_quote or "").strip():
                raise ValueError("An exact source_quote is required when linking an obligation to a document")
            if "source_confidence" in data:
                item.source_confidence = float(data.get("source_confidence") or 0.0)

            if action == "confirm":
                item.status = "confirmed"
                item.user_confirmed = True
            elif action == "resolve":
                item.status = "resolved"
                item.user_confirmed = True
            elif action == "dismiss":
                item.status = "dismissed"
                item.user_confirmed = False
            elif action == "reopen":
                item.status = data.get("status") or "needs_review"
                item.user_confirmed = False
            else:
                if "status" in data:
                    item.status = data.get("status") or item.status
                if "user_confirmed" in data:
                    item.user_confirmed = bool(data.get("user_confirmed"))

            for link in session.query(EvidenceLink).filter_by(case_id=case_id, target_type="obligation", target_id=item.id).all():
                if action in {"confirm", "resolve"}:
                    link.user_confirmed = True
                    if link.relationship == "rejected_suggestion":
                        link.relationship = "states_obligation"
                elif action == "dismiss":
                    link.user_confirmed = False
                    link.relationship = "rejected_suggestion"
                elif action == "reopen":
                    link.user_confirmed = False
                    if link.relationship == "rejected_suggestion":
                        link.relationship = "states_obligation"

            item.updated_at = utcnow()
            after = self._serialize_obligation(item)
            audit_action = {
                "confirm": "confirmed",
                "resolve": "resolved",
                "dismiss": "dismissed",
                "reopen": "reopened",
            }.get(action, "updated")
            self._audit(session, case_id, "Obligation", item.id, audit_action, actor, before, after, item.risk_level or "medium")
            return after

    def add_open_loop(self, case_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return None
            item = OpenLoop(
                case_id=case_id,
                title=data.get("title") or "Open loop",
                description=data.get("description") or "",
                owner=data.get("owner") or "robert",
                status=data.get("status") or "open",
                next_action=data.get("next_action") or "",
                risk_level=data.get("risk_level") or "medium",
            )
            session.add(item)
            session.flush()
            self._audit(session, case_id, "OpenLoop", item.id, "created", actor, {}, self._serialize_open_loop(item), item.risk_level)
            return self._serialize_open_loop(item)

    def list_open_loops(self, case_id: int) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            return [self._serialize_open_loop(item) for item in session.query(OpenLoop).filter_by(case_id=case_id).order_by(OpenLoop.id.desc()).all()]

    def update_open_loop(self, case_id: int, loop_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        action = (data.get("action") or "update").strip().lower()
        if action not in {"update", "resolve", "reopen"}:
            raise ValueError("Open-loop action must be update, resolve, or reopen")

        with self.session_scope() as session:
            item = session.get(OpenLoop, loop_id)
            if not item or item.case_id != case_id:
                return None
            before = self._serialize_open_loop(item)

            for key in ("title", "description", "owner", "next_action", "risk_level"):
                if key in data:
                    setattr(item, key, data[key] or "")
            if action == "resolve":
                item.status = "resolved"
            elif action == "reopen":
                item.status = data.get("status") or "open"
            elif "status" in data:
                item.status = data.get("status") or item.status

            item.updated_at = utcnow()
            after = self._serialize_open_loop(item)
            audit_action = {"resolve": "resolved", "reopen": "reopened"}.get(action, "updated")
            self._audit(session, case_id, "OpenLoop", item.id, audit_action, actor, before, after, item.risk_level or "medium")
            return after

    def create_outreach_draft(self, case_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return None
            approval = Approval(
                case_id=case_id,
                entity_type="LawyerOutreach",
                action="send_external_legal_email",
                risk_level="high",
                status="pending",
                requested_by=actor,
                reason="External legal communication requires explicit approval before sending.",
            )
            session.add(approval)
            session.flush()
            outreach = LawyerOutreach(
                case_id=case_id,
                lawyer_name=data.get("lawyer_name") or "",
                lawyer_email=data.get("lawyer_email") or "",
                legal_field=data.get("legal_field") or "",
                subject=data.get("subject") or "Case inquiry",
                draft_body=data.get("draft_body") or data.get("body") or "",
                status="waiting_approval",
                approval_id=approval.id,
            )
            session.add(outreach)
            session.flush()
            approval.entity_id = outreach.id
            self._audit(session, case_id, "LawyerOutreach", outreach.id, "drafted", actor, {}, self._serialize_outreach(outreach), "high", approval.id)
            return self._serialize_outreach(outreach)

    def list_outreach(self, case_id: int) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            return [self._serialize_outreach(item) for item in session.query(LawyerOutreach).filter_by(case_id=case_id).order_by(LawyerOutreach.id.desc()).all()]

    def add_lawyer_response(self, case_id: int, outreach_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            outreach = session.get(LawyerOutreach, outreach_id)
            if not outreach or outreach.case_id != case_id:
                return None
            response_type = self._normalize_lawyer_response_type(data.get("response_type") or data.get("status"))
            received_at = self._parse_datetime(data.get("received_at") or data.get("timestamp")) or utcnow()
            response = LawyerResponse(
                outreach_id=outreach.id,
                response_type=response_type,
                content=data.get("content") or data.get("body") or data.get("message") or "",
                received_at=received_at,
            )
            outreach_before = self._serialize_outreach(outreach)
            outreach.status = self._outreach_status_for_response(response_type)
            outreach.updated_at = utcnow()
            session.add(response)
            session.flush()
            serialized = self._serialize_lawyer_response(response, outreach)
            self._audit(session, case_id, "LawyerResponse", response.id, "recorded", actor, {}, serialized, "medium")
            self._audit(session, case_id, "LawyerOutreach", outreach.id, "response_recorded", actor, outreach_before, self._serialize_outreach(outreach), "medium")
            return serialized

    def list_lawyer_responses(self, case_id: int, outreach_id: Optional[int] = None) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            query = (
                session.query(LawyerResponse, LawyerOutreach)
                .join(LawyerOutreach, LawyerResponse.outreach_id == LawyerOutreach.id)
                .filter(LawyerOutreach.case_id == case_id)
                .order_by(LawyerResponse.received_at.desc(), LawyerResponse.id.desc())
            )
            if outreach_id is not None:
                query = query.filter(LawyerOutreach.id == outreach_id)
            return [self._serialize_lawyer_response(response, outreach) for response, outreach in query.all()]

    def create_draft(self, case_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return None

            draft_type = (data.get("draft_type") or data.get("type") or "summary").strip().lower()
            risk_level = (data.get("risk_level") or self._risk_level_for_draft(draft_type)).strip().lower()
            requires_approval = self._draft_requires_approval(draft_type, risk_level, data)
            draft = Draft(
                case_id=case_id,
                draft_type=draft_type,
                title=data.get("title") or self._default_draft_title(draft_type),
                body=data.get("body") or data.get("draft_body") or "",
                status="waiting_approval" if requires_approval else data.get("status") or "draft",
                risk_level=risk_level,
            )
            session.add(draft)
            session.flush()

            approval = None
            if requires_approval:
                approval = Approval(
                    case_id=case_id,
                    entity_type="Draft",
                    entity_id=draft.id,
                    action=data.get("approval_action") or self._approval_action_for_draft(draft_type),
                    risk_level=risk_level if risk_level in {"high", "critical"} else "high",
                    status="pending",
                    requested_by=actor,
                    reason=data.get("approval_reason") or "Generated legal correspondence or external sharing requires explicit approval before use outside LARO.",
                )
                session.add(approval)
                session.flush()
                draft.approval_id = approval.id
                self._audit(session, case_id, "Approval", approval.id, "requested", actor, {}, self._serialize_approval(approval), approval.risk_level, approval.id)

            serialized = self._serialize_draft(draft)
            self._audit(session, case_id, "Draft", draft.id, "created", actor, {}, serialized, risk_level, draft.approval_id)
            return serialized

    def generate_case_brief(self, case_id: int, draft_type: str, actor: str = "system") -> Optional[Dict[str, Any]]:
        """Persist a source-linked internal brief without presenting it as legal advice.

        The source-linked red-line remains the factual substrate. This helper only
        packages it into a durable draft and maps each included document into the
        papertrail; it does not assert facts, resolve reviews, or send anything.
        """
        normalized_type = str(draft_type or "lawyer_summary").strip().lower()
        allowed_types = {"case_summary", "lawyer_summary", "red_line", "case_bundle_export"}
        if normalized_type not in allowed_types:
            raise ValueError("Generated draft type must be case_summary, lawyer_summary, red_line, or case_bundle_export")

        dossier = self.case_comprehension_dossier(case_id)
        red_line = self.red_line_thread(case_id)
        if not dossier or not red_line:
            return None
        case = dossier["case"]
        red_line_body = red_line.get("body") or ""
        safety = "Internal factual preparation only. Verify every source and do not treat this as legal advice or an external communication."
        titles = {
            "case_summary": f"Case summary: {case.get('title') or 'legal case'}",
            "lawyer_summary": f"Lawyer-ready briefing: {case.get('title') or 'legal case'}",
            "red_line": f"Red-line analysis: {case.get('title') or 'legal case'}",
            "case_bundle_export": f"Case bundle export draft: {case.get('title') or 'legal case'}",
        }
        if normalized_type == "case_summary":
            body = "\n\n".join([
                titles[normalized_type],
                safety,
                f"Desired outcome: {case.get('desired_outcome') or 'Not recorded'}",
                f"Readable source documents: {dossier.get('reading_status', {}).get('documents_readable', 0)}",
                red_line_body,
            ])
        elif normalized_type == "lawyer_summary":
            body = "\n\n".join([
                titles[normalized_type],
                safety,
                "Purpose: provide a concise, source-linked factual briefing for a legal professional. Review unresolved items before relying on this draft.",
                f"Requested outcome: {case.get('desired_outcome') or 'Not recorded'}",
                red_line_body,
            ])
        elif normalized_type == "red_line":
            body = "\n\n".join([titles[normalized_type], safety, red_line_body])
        else:
            body = "\n\n".join([
                titles[normalized_type],
                "This external-use export draft is approval-gated. It has not been shared or sent.",
                safety,
                red_line_body,
            ])

        draft = self.create_draft(case_id, {
            "draft_type": normalized_type,
            "title": titles[normalized_type],
            "body": body,
        }, actor=actor)
        if not draft:
            return None

        source_links = []
        source_document_ids = []
        seen_documents = set()
        for source in dossier.get("source_documents") or []:
            document_id = source.get("document_id")
            if not document_id or document_id in seen_documents:
                continue
            seen_documents.add(document_id)
            source_document_ids.append(document_id)
            source_links.append(self.add_evidence_link(case_id, {
                "document_id": document_id,
                "target_type": "draft",
                "target_id": draft["id"],
                "snippet": source.get("summary") or source.get("title") or "Source document included in generated brief.",
                "relationship": "cited_in_generated_draft",
                "strength": "informational",
                "user_confirmed": True,
            }, actor=actor))

        return {
            **draft,
            "generation_method": "source_linked_case_dossier_v1",
            "source_document_ids": source_document_ids,
            "source_links": [item for item in source_links if item],
            "source_preserved": True,
            "requires_human_review": True,
            "external_action_taken": False,
        }

    def list_drafts(self, case_id: int) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            return [
                self._serialize_draft(item)
                for item in session.query(Draft).filter_by(case_id=case_id).order_by(Draft.updated_at.desc(), Draft.id.desc()).all()
            ]

    def get_draft(self, case_id: int, draft_id: int) -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            draft = session.get(Draft, draft_id)
            if not draft or draft.case_id != case_id:
                return None
            return self._serialize_draft(draft)

    def update_draft(self, case_id: int, draft_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        action = (data.get("action") or "update").strip().lower()
        if action not in {"update", "submit_for_approval", "archive", "reopen"}:
            raise ValueError("Draft action must be update, submit_for_approval, archive, or reopen")

        with self.session_scope() as session:
            draft = session.get(Draft, draft_id)
            if not draft or draft.case_id != case_id:
                return None
            before = self._serialize_draft(draft)

            for key in ("title", "body", "draft_type", "risk_level"):
                if key in data and data[key] not in {None, ""}:
                    setattr(draft, key, str(data[key]).strip() if key in {"draft_type", "risk_level"} else data[key])

            if action == "archive":
                draft.status = "archived"
            elif action == "reopen":
                draft.status = "draft"
            elif action == "submit_for_approval":
                approval = Approval(
                    case_id=case_id,
                    entity_type="Draft",
                    entity_id=draft.id,
                    action=data.get("approval_action") or self._approval_action_for_draft(draft.draft_type),
                    risk_level=draft.risk_level if draft.risk_level in {"high", "critical"} else "high",
                    status="pending",
                    requested_by=actor,
                    reason=data.get("approval_reason") or "Draft requires explicit approval before external use.",
                )
                session.add(approval)
                session.flush()
                draft.approval_id = approval.id
                draft.status = "waiting_approval"
                self._audit(session, case_id, "Approval", approval.id, "requested", actor, {}, self._serialize_approval(approval), approval.risk_level, approval.id)
            elif "status" in data and data["status"]:
                draft.status = data["status"]

            draft.updated_at = utcnow()
            after = self._serialize_draft(draft)
            self._audit(session, case_id, "Draft", draft.id, action, actor, before, after, draft.risk_level, draft.approval_id)
            return after

    def save_match_result(
        self,
        case_id: int,
        match_type: str,
        payload: Dict[str, Any],
        criteria: Optional[Dict[str, Any]] = None,
        actor: str = "system",
        source: str = "serverless_matching",
    ) -> Optional[Dict[str, Any]]:
        normalized_type = (match_type or "").strip().lower()
        if not normalized_type:
            raise ValueError("match_type is required")

        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return None

            item = session.query(MatchResult).filter_by(case_id=case_id, match_type=normalized_type).first()
            before = self._serialize_match_result(item) if item else {}
            if not item:
                item = MatchResult(case_id=case_id, match_type=normalized_type)
                session.add(item)

            item.source = source or "serverless_matching"
            item.criteria_json = _json_dump(criteria or {})
            item.payload_json = _json_dump(payload or {})
            item.updated_at = utcnow()
            session.flush()
            after = self._serialize_match_result(item)
            self._audit(
                session,
                case_id,
                "MatchResult",
                item.id,
                "created" if not before else "updated",
                actor,
                before,
                after,
                "low",
            )
            return after

    def get_match_result(self, case_id: int, match_type: str) -> Optional[Dict[str, Any]]:
        normalized_type = (match_type or "").strip().lower()
        if not normalized_type:
            return None
        with self.session_scope() as session:
            item = session.query(MatchResult).filter_by(case_id=case_id, match_type=normalized_type).first()
            return self._serialize_match_result(item) if item else None

    def list_match_results(self, case_id: int) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            return [
                self._serialize_match_result(item)
                for item in session.query(MatchResult)
                .filter_by(case_id=case_id)
                .order_by(MatchResult.updated_at.desc(), MatchResult.id.desc())
                .all()
            ]

    def import_outreach_directory_targets(
        self,
        records: Iterable[Dict[str, Any]],
        actor: str = "system",
        audit_source: str = "api",
        audit_action: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Store sourced outreach records for review before case matching can use them."""
        imported: List[Dict[str, Any]] = []
        with self.session_scope() as session:
            for raw_record in records or []:
                data = self._normalize_outreach_directory_record(raw_record)
                if not data["name"] or not data["source_url"]:
                    raise ValueError("Outreach directory records require name and source_url")

                item = (
                    session.query(OutreachDirectoryTarget)
                    .filter_by(target_type=data["target_type"], source_url=data["source_url"])
                    .one_or_none()
                )
                before = self._serialize_outreach_directory_target(item) if item else {}
                if not item:
                    item = OutreachDirectoryTarget(
                        target_type=data["target_type"],
                        source_url=data["source_url"],
                    )
                    session.add(item)

                item.name = data["name"]
                item.subtype = data["subtype"]
                item.parent_org = data["parent_org"]
                item.description = data["description"]
                item.topics_json = _json_dump(data["topics"])
                item.legal_fields_json = _json_dump(data["legal_fields"])
                item.audience_json = _json_dump(data["audience"])
                item.channels_json = _json_dump(data["channels"])
                item.region = data["region"]
                item.url = data["url"]
                item.contact_url = data["contact_url"]
                item.source_label = data["source_label"]
                item.source_retrieved_at = data["source_retrieved_at"]
                item.confidence = data["confidence"]
                item.metadata_json = _json_dump(data["metadata"])
                # Re-importing a record must never silently renew a prior approval.
                item.status = "needs_review"
                item.updated_at = utcnow()
                session.flush()
                after = self._serialize_outreach_directory_target(item)
                self._audit(
                    session,
                    None,
                    "OutreachDirectoryTarget",
                    item.id,
                    audit_action or ("imported" if not before else "reimported_for_review"),
                    actor,
                    before,
                    after,
                    "medium",
                    source=audit_source,
                )
                imported.append(after)
        return imported

    def list_outreach_directory_targets(
        self,
        target_type: Optional[str] = None,
        status: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            query = session.query(OutreachDirectoryTarget).order_by(
                OutreachDirectoryTarget.updated_at.desc(),
                OutreachDirectoryTarget.id.desc(),
            )
            if target_type and target_type != "all":
                query = query.filter_by(target_type=self._normalize_outreach_target_type(target_type))
            if status:
                query = query.filter_by(status=status)
            return [self._serialize_outreach_directory_target(item) for item in query.all()]

    def update_outreach_directory_target(
        self,
        target_id: int,
        data: Dict[str, Any],
        actor: str = "system",
    ) -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            item = session.get(OutreachDirectoryTarget, target_id)
            if not item:
                return None
            before = self._serialize_outreach_directory_target(item)
            action = str(data.get("action") or data.get("status") or "").strip().lower()
            statuses = {
                "approve": "approved",
                "approved": "approved",
                "archive": "archived",
                "archived": "archived",
                "review": "needs_review",
                "needs_review": "needs_review",
            }
            if action not in statuses:
                raise ValueError("action must be approve, archive, or review")
            item.status = statuses[action]
            item.updated_at = utcnow()
            session.flush()
            after = self._serialize_outreach_directory_target(item)
            self._audit(session, None, "OutreachDirectoryTarget", item.id, item.status, actor, before, after, "medium")
            return after

    def list_approvals(
        self,
        case_id: Optional[int] = None,
        status: Optional[str] = None,
        external_user_id: Optional[Any] = None,
    ) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            query = session.query(Approval).order_by(Approval.created_at.desc())
            if external_user_id is not None:
                user = session.query(LedgerUser).filter_by(external_user_id=str(external_user_id)).one_or_none()
                if not user:
                    return []
                query = query.join(LegalCase, Approval.case_id == LegalCase.id).filter(LegalCase.user_id == user.id)
            if case_id is not None:
                query = query.filter(Approval.case_id == case_id)
            if status:
                query = query.filter(Approval.status == status)
            return [self._serialize_approval(item) for item in query.all()]

    def user_owns_approval(self, approval_id: int, external_user_id: Any) -> bool:
        """Check a case-linked approval without serializing its sensitive content."""
        if approval_id is None or external_user_id in (None, ""):
            return False
        with self.session_scope() as session:
            user = session.query(LedgerUser).filter_by(external_user_id=str(external_user_id)).one_or_none()
            if not user:
                return False
            return session.query(Approval.id).join(
                LegalCase, Approval.case_id == LegalCase.id
            ).filter(
                Approval.id == int(approval_id), LegalCase.user_id == user.id
            ).first() is not None

    def _case_bundle_snapshot_context(self, session, case_id: int) -> Dict[str, Any]:
        """Fingerprint every persisted record that can materially change a bundle."""
        case = session.get(LegalCase, case_id)
        if not case:
            return {}
        self._ensure_missing_evidence_reviews(session, case_id)
        self._ensure_case_analysis_review_items(session, case_id)

        def group_hash(items: Iterable[Any], serializer) -> Dict[str, Any]:
            rows = list(items)
            fingerprints = [self._hash(_json_dump(serializer(item))) for item in rows]
            return {
                "count": len(rows),
                "hash": self._hash(_json_dump(fingerprints)),
            }

        groups = {
            "identifiers": group_hash(
                session.query(CaseIdentifier).filter_by(case_id=case_id).order_by(CaseIdentifier.id.asc()).all(),
                self._serialize_identifier,
            ),
            "parties": group_hash(
                session.query(Party).filter_by(case_id=case_id).order_by(Party.id.asc()).all(),
                self._serialize_party,
            ),
            "documents": group_hash(
                session.query(CaseDocument).filter_by(case_id=case_id).order_by(CaseDocument.id.asc()).all(),
                self._serialize_document,
            ),
            "document_versions": group_hash(
                session.query(DocumentVersion)
                .join(CaseDocument, DocumentVersion.document_id == CaseDocument.id)
                .filter(CaseDocument.case_id == case_id)
                .order_by(DocumentVersion.id.asc()).all(),
                self._serialize_document_version,
            ),
            "timeline": group_hash(
                session.query(CaseEvent).filter_by(case_id=case_id).order_by(CaseEvent.id.asc()).all(),
                self._serialize_event,
            ),
            "evidence_links": group_hash(
                session.query(EvidenceLink).filter_by(case_id=case_id).order_by(EvidenceLink.id.asc()).all(),
                self._serialize_evidence_link,
            ),
            "claims": group_hash(
                session.query(LegalClaim).filter_by(case_id=case_id).order_by(LegalClaim.id.asc()).all(),
                self._serialize_claim,
            ),
            "contradictions": group_hash(
                session.query(Contradiction).filter_by(case_id=case_id).order_by(Contradiction.id.asc()).all(),
                self._serialize_contradiction,
            ),
            "missing_evidence": group_hash(
                session.query(MissingEvidenceWarning).filter_by(case_id=case_id).order_by(MissingEvidenceWarning.id.asc()).all(),
                self._serialize_missing_evidence,
            ),
            "deadlines": group_hash(
                session.query(Deadline).filter_by(case_id=case_id).order_by(Deadline.id.asc()).all(),
                self._serialize_deadline,
            ),
            "obligations": group_hash(
                session.query(Obligation).filter_by(case_id=case_id).order_by(Obligation.id.asc()).all(),
                self._serialize_obligation,
            ),
            "open_loops": group_hash(
                session.query(OpenLoop).filter_by(case_id=case_id).order_by(OpenLoop.id.asc()).all(),
                self._serialize_open_loop,
            ),
            "outreach": group_hash(
                session.query(LawyerOutreach).filter_by(case_id=case_id).order_by(LawyerOutreach.id.asc()).all(),
                self._serialize_outreach,
            ),
            "lawyer_responses": group_hash(
                session.query(LawyerResponse, LawyerOutreach)
                .join(LawyerOutreach, LawyerResponse.outreach_id == LawyerOutreach.id)
                .filter(LawyerOutreach.case_id == case_id)
                .order_by(LawyerResponse.id.asc()).all(),
                lambda row: self._serialize_lawyer_response(row[0], row[1]),
            ),
            "drafts": group_hash(
                session.query(Draft).filter_by(case_id=case_id).order_by(Draft.id.asc()).all(),
                self._serialize_draft,
            ),
            "analysis_runs": group_hash(
                session.query(CaseAnalysisRun).filter_by(case_id=case_id).order_by(CaseAnalysisRun.id.asc()).all(),
                self._serialize_case_analysis_run,
            ),
            "analysis_review": group_hash(
                session.query(CaseAnalysisReviewItem).filter_by(case_id=case_id).order_by(CaseAnalysisReviewItem.id.asc()).all(),
                self._serialize_case_analysis_review_item,
            ),
        }
        material = {
            "case_hash": self._hash(_json_dump(self._serialize_case(case))),
            "groups": groups,
        }
        return {
            "bundle_snapshot_hash": self._hash(_json_dump(material)),
            "snapshot_counts": {name: value["count"] for name, value in groups.items()},
            "case_updated_at": _iso(case.updated_at),
        }

    def case_bundle_snapshot(self, case_id: int) -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            context = self._case_bundle_snapshot_context(session, case_id)
            return context or None

    def request_case_bundle_share_approval(self, case_id: int, actor: str = "system", reason: str = "") -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return None
            context = self._case_bundle_snapshot_context(session, case_id)
            existing = session.query(Approval).filter_by(
                case_id=case_id,
                entity_type="CaseBundle",
                entity_id=case_id,
                action="share_case_bundle_externally",
                status="pending",
            ).order_by(Approval.created_at.desc(), Approval.id.desc()).first()
            if existing and (_json_load(existing.context_json, {}) or {}).get("bundle_snapshot_hash") == context.get("bundle_snapshot_hash"):
                return self._serialize_approval(existing)
            if existing:
                before = self._serialize_approval(existing)
                existing.status = "superseded"
                existing.resolved_by = "system"
                existing.resolved_at = utcnow()
                self._audit(
                    session, case_id, "Approval", existing.id, "superseded_snapshot_changed", actor,
                    before, self._serialize_approval(existing), "high", existing.id,
                )

            approval = Approval(
                case_id=case_id,
                entity_type="CaseBundle",
                entity_id=case_id,
                action="share_case_bundle_externally",
                risk_level="high",
                status="pending",
                requested_by=actor,
                reason=reason or "External sharing of a legal case bundle requires explicit approval before any documents leave LARO.",
                context_json=_json_dump(context),
            )
            session.add(approval)
            session.flush()
            self._audit(session, case_id, "Approval", approval.id, "requested", actor, {}, self._serialize_approval(approval), "high", approval.id)
            return self._serialize_approval(approval)

    def resolve_approval(self, approval_id: int, status: str, actor: str = "system", reason: str = "") -> Optional[Dict[str, Any]]:
        if status not in {"approved", "rejected"}:
            raise ValueError("Approval status must be approved or rejected")
        with self.session_scope() as session:
            approval = session.get(Approval, approval_id)
            if not approval:
                return None
            if (
                status == "approved"
                and approval.entity_type == "CaseBundle"
                and approval.case_id
            ):
                requested_snapshot = (_json_load(approval.context_json, {}) or {}).get("bundle_snapshot_hash")
                current_snapshot = self._case_bundle_snapshot_context(session, approval.case_id).get("bundle_snapshot_hash")
                if not requested_snapshot or requested_snapshot != current_snapshot:
                    raise ValueError("The case changed after this bundle approval was requested; request a new approval")
            before = self._serialize_approval(approval)
            approval.status = status
            approval.resolved_by = actor
            approval.reason = reason or approval.reason
            approval.resolved_at = utcnow()
            self._audit(session, approval.case_id, "Approval", approval.id, status, actor, before, self._serialize_approval(approval), approval.risk_level, approval.id)
            if approval.entity_type == "LawyerOutreach" and approval.entity_id:
                outreach = session.get(LawyerOutreach, approval.entity_id)
                if outreach:
                    outreach_before = self._serialize_outreach(outreach)
                    outreach.status = "approved_to_send" if status == "approved" else "approval_rejected"
                    self._audit(session, approval.case_id, "LawyerOutreach", outreach.id, f"approval_{status}", actor, outreach_before, self._serialize_outreach(outreach), approval.risk_level, approval.id)
            if approval.entity_type == "Draft" and approval.entity_id:
                draft = session.get(Draft, approval.entity_id)
                if draft:
                    draft_before = self._serialize_draft(draft)
                    draft.status = "approved_for_external_use" if status == "approved" else "approval_rejected"
                    draft.updated_at = utcnow()
                    self._audit(session, approval.case_id, "Draft", draft.id, f"approval_{status}", actor, draft_before, self._serialize_draft(draft), approval.risk_level, approval.id)
            return self._serialize_approval(approval)

    def list_audit_events(
        self,
        case_id: Optional[int] = None,
        external_user_id: Optional[Any] = None,
    ) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            query = session.query(AuditEvent).order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())
            if external_user_id is not None:
                user = session.query(LedgerUser).filter_by(external_user_id=str(external_user_id)).one_or_none()
                if not user:
                    return []
                query = query.filter(AuditEvent.user_id == user.id)
            if case_id is not None:
                query = query.filter(AuditEvent.case_id == case_id)
            return [self._serialize_audit(item) for item in query.limit(250).all()]

    def record_case_activity(
        self,
        case_id: int,
        action: str,
        *,
        actor: str = "system",
        source: str = "api",
        details: Optional[Dict[str, Any]] = None,
        risk_level: str = "low",
        approval_id: Optional[int] = None,
    ) -> bool:
        """Audit a security-relevant case operation that does not mutate evidence."""
        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return False
            self._audit(
                session,
                case_id,
                "LegalCase",
                case_id,
                action,
                actor,
                {},
                details or {},
                risk_level,
                approval_id,
                source=source,
            )
            return True

    def create_evidence_import_job(self, case_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            if not session.get(LegalCase, case_id):
                return None
            job = EvidenceImportJob(
                case_id=case_id,
                provider=str(data.get("provider") or "google").strip().lower() or "google",
                source=str(data.get("source") or "gmail").strip().lower() or "gmail",
                query=str(data.get("query") or "").strip(),
                status="queued",
                stage="Queued for local evidence import",
            )
            session.add(job)
            session.flush()
            serialized = self._serialize_evidence_import_job(job)
            self._audit(session, case_id, "EvidenceImportJob", job.id, "created", actor, {}, serialized, "medium", source="local_import_job")
            return serialized

    def get_evidence_import_job(self, case_id: int, job_id: int) -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            job = session.get(EvidenceImportJob, job_id)
            if not job or job.case_id != case_id:
                return None
            return self._serialize_evidence_import_job(job)

    def list_evidence_import_jobs(self, case_id: int, status: Optional[str] = None) -> List[Dict[str, Any]]:
        with self.session_scope() as session:
            query = session.query(EvidenceImportJob).filter_by(case_id=case_id)
            if status:
                query = query.filter_by(status=status)
            return [
                self._serialize_evidence_import_job(item)
                for item in query.order_by(EvidenceImportJob.updated_at.desc(), EvidenceImportJob.id.desc()).limit(20).all()
            ]

    def update_evidence_import_job(self, case_id: int, job_id: int, data: Dict[str, Any], actor: str = "system") -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            job = session.get(EvidenceImportJob, job_id)
            if not job or job.case_id != case_id:
                return None
            previous_status = job.status
            for field_name in (
                "stage", "current_item", "total_items", "completed_items", "total_words",
                "processed_words", "imported_count", "skipped_count", "estimated_total_seconds", "error",
            ):
                if field_name in data:
                    setattr(job, field_name, data[field_name])
            if "result" in data:
                job.result_json = _json_dump(data["result"] if isinstance(data["result"], dict) else {})
            if data.get("status"):
                job.status = str(data["status"]).strip().lower()
            if job.status == "running" and not job.started_at:
                job.started_at = utcnow()
            if job.status in {"completed", "failed"} and not job.completed_at:
                job.completed_at = utcnow()
            job.updated_at = utcnow()
            session.flush()
            serialized = self._serialize_evidence_import_job(job)
            if job.status in {"completed", "failed"} and previous_status != job.status:
                self._audit(session, case_id, "EvidenceImportJob", job.id, job.status, actor, {}, serialized, "medium", source="local_import_job")
            return serialized

    def papertrail_graph(self, case_id: int) -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            case = session.get(LegalCase, case_id)
            if not case:
                return None
            self._ensure_missing_evidence_reviews(session, case_id)
            self._ensure_case_analysis_review_items(session, case_id)

            nodes: List[Dict[str, Any]] = [{"id": f"case:{case.id}", "type": "case", "label": case.title, "status": case.status}]
            edges: List[Dict[str, Any]] = []
            facet_parties = set()
            facet_document_types = set()
            facet_claim_support_states = set()
            facet_dates = set()

            party_nodes_by_name: Dict[str, str] = {}
            for party in session.query(Party).filter_by(case_id=case_id).all():
                nodes.append({"id": f"party:{party.id}", "type": "party", "label": party.name, "role": party.role})
                edges.append({"from": f"case:{case.id}", "to": f"party:{party.id}", "type": "involves"})
                party_nodes_by_name[party.name.strip().lower()] = f"party:{party.id}"
                if party.name:
                    facet_parties.add(party.name.strip())

            for document in session.query(CaseDocument).filter_by(case_id=case_id).all():
                extraction_status = "extracted" if (document.extracted_text or document.ocr_text) else "pending"
                nodes.append({
                    "id": f"document:{document.id}",
                    "type": "document",
                    "label": document.title or document.original_filename,
                    "source": document.source_type,
                    "source_uri": document.source_uri,
                    "document_type": document.document_type or "unknown",
                    "date": document.date_on_document,
                    "sender": document.sender,
                    "recipient": document.recipient,
                    "summary": document.summary,
                    "relevance_score": document.relevance_score,
                    "confidentiality_level": document.confidentiality_level,
                    "extraction_status": extraction_status,
                    "content_hash": document.content_hash,
                })
                edges.append({"from": f"case:{case.id}", "to": f"document:{document.id}", "type": "contains"})
                facet_document_types.add(document.document_type or "unknown")
                if document.date_on_document:
                    facet_dates.add(document.date_on_document)
                for party_name in (document.sender, document.recipient):
                    if party_name:
                        facet_parties.add(party_name.strip())

            for identifier in session.query(CaseIdentifier).filter_by(case_id=case_id).all():
                nodes.append({
                    "id": f"identifier:{identifier.id}",
                    "type": "identifier",
                    "label": identifier.identifier_value,
                    "identifier_type": identifier.identifier_type,
                    "source_party": identifier.source_party,
                })
                edges.append({"from": f"case:{case.id}", "to": f"identifier:{identifier.id}", "type": "identified_by"})

            for event in session.query(CaseEvent).filter_by(case_id=case_id).all():
                review_status = "rejected" if event.event_type == "rejected_suggestion" else "confirmed" if event.user_confirmed else "needs_review"
                nodes.append({
                    "id": f"event:{event.id}",
                    "type": "event",
                    "label": event.title,
                    "date": event.event_date,
                    "event_kind": event.event_kind,
                    "actor": event.actor,
                    "action": event.action,
                    "affected_party": event.affected_party,
                    "review_status": review_status,
                    "user_confirmed": event.user_confirmed,
                })
                edges.append({"from": f"case:{case.id}", "to": f"event:{event.id}", "type": "chronology", "review_status": review_status, "user_confirmed": event.user_confirmed})
                if event.created_from_document_id:
                    edges.append({"from": f"document:{event.created_from_document_id}", "to": f"event:{event.id}", "type": "supports", "review_status": review_status, "user_confirmed": event.user_confirmed})
                if event.event_date:
                    facet_dates.add(event.event_date)
                for party_name in (event.actor, event.affected_party):
                    if party_name:
                        facet_parties.add(party_name.strip())

            evidence_links = session.query(EvidenceLink).filter_by(case_id=case_id).all()
            claim_links: Dict[int, List[EvidenceLink]] = {}
            for link in evidence_links:
                if link.target_type == "claim":
                    claim_links.setdefault(link.target_id, []).append(link)

            for claim in session.query(LegalClaim).filter_by(case_id=case_id).all():
                links = [link for link in claim_links.get(claim.id, []) if link.relationship != "rejected_suggestion"]
                confirmed_relationships = {link.relationship for link in links if link.user_confirmed}
                has_pending = any(not link.user_confirmed for link in links)
                if "supports" in confirmed_relationships and "disputes" in confirmed_relationships:
                    support_state = "mixed"
                elif "supports" in confirmed_relationships:
                    support_state = "supported"
                elif "disputes" in confirmed_relationships:
                    support_state = "disputed"
                elif has_pending:
                    support_state = "pending_review"
                elif "context" in confirmed_relationships:
                    support_state = "context_only"
                else:
                    support_state = "unsupported"
                nodes.append({
                    "id": f"claim:{claim.id}",
                    "type": "claim",
                    "label": claim.statement[:120],
                    "status": claim.status,
                    "asserted_by": claim.asserted_by,
                    "position_role": claim.position_role,
                    "subject_party": claim.subject_party,
                    "materiality": claim.materiality,
                    "support_state": support_state,
                })
                edges.append({"from": f"case:{case.id}", "to": f"claim:{claim.id}", "type": "asserts"})
                facet_claim_support_states.add(support_state)
                for party_name in (claim.asserted_by, claim.subject_party):
                    if party_name:
                        facet_parties.add(party_name.strip())

            linked_obligation_sources = set()
            for link in evidence_links:
                target = f"{link.target_type}:{link.target_id}"
                edges.append({"from": f"document:{link.document_id}", "to": target, "type": link.relationship, "strength": link.strength, "user_confirmed": link.user_confirmed})
                if link.target_type == "obligation":
                    linked_obligation_sources.add((link.document_id, link.target_id))

            for item in session.query(CaseAnalysisReviewItem).filter_by(case_id=case_id).all():
                node_id = f"case_analysis_review:{item.id}"
                nodes.append({
                    "id": node_id,
                    "type": "case_analysis_review",
                    "label": item.title,
                    "status": item.status,
                    "item_type": item.item_type,
                    "target_type": item.target_type,
                    "target_id": item.target_id,
                })
                edges.append({"from": f"case:{case.id}", "to": node_id, "type": "analysis_review", "status": item.status})
                for source in _json_load(item.source_refs, []):
                    document_id = source.get("document_id") if isinstance(source, dict) else None
                    if document_id:
                        edges.append({"from": f"document:{document_id}", "to": node_id, "type": "cites", "status": item.status})
                if item.target_type and item.target_id:
                    edges.append({"from": node_id, "to": f"{item.target_type}:{item.target_id}", "type": "prepared_as", "status": item.status})

            for contradiction in session.query(Contradiction).filter_by(case_id=case_id).all():
                nodes.append({"id": f"contradiction:{contradiction.id}", "type": "contradiction", "label": contradiction.title, "severity": contradiction.severity})
                edges.append({"from": f"case:{case.id}", "to": f"contradiction:{contradiction.id}", "type": "flags"})
                for source_ref in _json_load(contradiction.source_refs, []):
                    document_id = source_ref.get("document_id") if isinstance(source_ref, dict) else None
                    if document_id:
                        edges.append({"from": f"document:{document_id}", "to": f"contradiction:{contradiction.id}", "type": "conflicts_with"})

            for warning in session.query(MissingEvidenceWarning).filter_by(case_id=case_id).all():
                nodes.append({"id": f"missing_evidence:{warning.id}", "type": "missing_evidence", "label": warning.title, "status": warning.status, "severity": warning.severity})
                edges.append({"from": f"case:{case.id}", "to": f"missing_evidence:{warning.id}", "type": "needs_evidence"})
                if warning.claim_id:
                    edges.append({"from": f"claim:{warning.claim_id}", "to": f"missing_evidence:{warning.id}", "type": "unsupported_by"})

            for deadline in session.query(Deadline).filter_by(case_id=case_id).all():
                nodes.append({"id": f"deadline:{deadline.id}", "type": "deadline", "label": deadline.title, "due_date": deadline.due_date, "status": deadline.status})
                edges.append({"from": f"case:{case.id}", "to": f"deadline:{deadline.id}", "type": "requires_action"})
                if deadline.source_document_id:
                    edges.append({"from": f"document:{deadline.source_document_id}", "to": f"deadline:{deadline.id}", "type": "suggests_deadline"})
                if deadline.due_date:
                    facet_dates.add(deadline.due_date)

            for obligation in session.query(Obligation).filter_by(case_id=case_id).all():
                node_id = f"obligation:{obligation.id}"
                nodes.append({
                    "id": node_id,
                    "type": "obligation",
                    "label": obligation.title,
                    "status": obligation.status,
                    "responsible_party": obligation.responsible_party,
                    "beneficiary_party": obligation.beneficiary_party,
                    "due_date": obligation.due_date,
                    "risk_level": obligation.risk_level,
                    "source_document_id": obligation.source_document_id,
                    "user_confirmed": obligation.user_confirmed,
                })
                edges.append({"from": f"case:{case.id}", "to": node_id, "type": "requires_action", "status": obligation.status})
                if obligation.source_document_id and (obligation.source_document_id, obligation.id) not in linked_obligation_sources:
                    edges.append({"from": f"document:{obligation.source_document_id}", "to": node_id, "type": "states_obligation", "user_confirmed": obligation.user_confirmed})
                party_node = party_nodes_by_name.get((obligation.responsible_party or "").strip().lower())
                if party_node:
                    edges.append({"from": party_node, "to": node_id, "type": "responsible_for", "status": obligation.status})
                if obligation.due_date:
                    facet_dates.add(obligation.due_date)
                for party_name in (obligation.responsible_party, obligation.beneficiary_party):
                    if party_name and party_name != "unassigned":
                        facet_parties.add(party_name.strip())

            for item in session.query(OpenLoop).filter_by(case_id=case_id).all():
                nodes.append({"id": f"open_loop:{item.id}", "type": "open_loop", "label": item.title, "status": item.status})
                edges.append({"from": f"case:{case.id}", "to": f"open_loop:{item.id}", "type": "open_loop"})

            for draft in session.query(Draft).filter_by(case_id=case_id).all():
                nodes.append({
                    "id": f"draft:{draft.id}",
                    "type": "draft",
                    "label": draft.title,
                    "draft_type": draft.draft_type,
                    "status": draft.status,
                    "risk_level": draft.risk_level,
                    "approval_id": draft.approval_id,
                })
                edges.append({"from": f"case:{case.id}", "to": f"draft:{draft.id}", "type": "generated_draft"})
                if draft.approval_id:
                    edges.append({"from": f"draft:{draft.id}", "to": f"approval:{draft.approval_id}", "type": "requires_approval"})

            for approval in session.query(Approval).filter_by(case_id=case_id).all():
                nodes.append({
                    "id": f"approval:{approval.id}",
                    "type": "approval",
                    "label": approval.action,
                    "status": approval.status,
                    "risk_level": approval.risk_level,
                    "entity_type": approval.entity_type,
                    "entity_id": approval.entity_id,
                })
                if approval.entity_type != "Draft" or not approval.entity_id:
                    edges.append({"from": f"case:{case.id}", "to": f"approval:{approval.id}", "type": "requires_approval"})

            ordered_dates = sorted(facet_dates)
            return {
                "case_id": case_id,
                "nodes": nodes,
                "edges": edges,
                "facets": {
                    "parties": sorted(facet_parties, key=str.casefold),
                    "document_types": sorted(facet_document_types, key=str.casefold),
                    "claim_support_states": sorted(facet_claim_support_states, key=str.casefold),
                    "date_from": ordered_dates[0] if ordered_dates else None,
                    "date_to": ordered_dates[-1] if ordered_dates else None,
                },
            }

    def case_summary(self, case_id: int) -> Optional[Dict[str, Any]]:
        with self.session_scope() as session:
            case = session.get(LegalCase, case_id)
            if not case:
                return None
            self._ensure_missing_evidence_reviews(session, case_id)
            self._ensure_case_analysis_review_items(session, case_id)
            documents = [self._serialize_document(item) for item in session.query(CaseDocument).filter_by(case_id=case_id).order_by(CaseDocument.date_on_document.asc(), CaseDocument.id.asc()).all()]
            timeline = [
                self._serialize_event(item)
                for item in session.query(CaseEvent)
                .filter(CaseEvent.case_id == case_id, CaseEvent.event_type != "rejected_suggestion")
                .order_by(CaseEvent.event_date.asc(), CaseEvent.id.asc())
                .all()
            ]
            claims = [self._serialize_claim(item) for item in session.query(LegalClaim).filter_by(case_id=case_id).order_by(LegalClaim.id.asc()).all()]
            evidence_links = [self._serialize_evidence_link(item) for item in session.query(EvidenceLink).filter_by(case_id=case_id).all()]
            active_claim_links = [
                link for link in evidence_links
                if link["target_type"] == "claim" and link.get("relationship") != "rejected_suggestion"
            ]
            confirmed_support_ids = {
                link["target_id"] for link in active_claim_links
                if link.get("user_confirmed") and link.get("relationship") == "supports"
            }
            confirmed_dispute_ids = {
                link["target_id"] for link in active_claim_links
                if link.get("user_confirmed") and link.get("relationship") == "disputes"
            }
            confirmed_context_ids = {
                link["target_id"] for link in active_claim_links
                if link.get("user_confirmed") and link.get("relationship") == "context"
            }
            proposed_claim_ids = {
                link["target_id"] for link in active_claim_links
                if not link.get("user_confirmed") or link.get("relationship") not in CLAIM_EVIDENCE_RELATIONSHIPS
            }
            mixed_claim_ids = confirmed_support_ids & confirmed_dispute_ids
            supported_claim_ids = confirmed_support_ids - mixed_claim_ids
            disputed_claim_ids = confirmed_dispute_ids - mixed_claim_ids
            contextual_claim_ids = confirmed_context_ids - confirmed_support_ids - confirmed_dispute_ids
            needs_review_claim_ids = proposed_claim_ids - confirmed_support_ids - confirmed_dispute_ids - confirmed_context_ids
            classified_claim_ids = confirmed_support_ids | confirmed_dispute_ids | confirmed_context_ids | proposed_claim_ids
            analysis_review_items = [
                self._serialize_case_analysis_review_item(item)
                for item in session.query(CaseAnalysisReviewItem)
                .filter_by(case_id=case_id)
                .order_by(CaseAnalysisReviewItem.created_at.desc(), CaseAnalysisReviewItem.id.desc())
                .all()
            ]
            return {
                "case": self._case_detail(session, case),
                "factual_reconstruction": {
                    "summary": case.current_summary or case.description or "",
                    "known_events": timeline,
                    "source_documents": documents,
                },
                "claims": {
                    "supported": [claim for claim in claims if claim["id"] in supported_claim_ids],
                    "mixed": [claim for claim in claims if claim["id"] in mixed_claim_ids],
                    "disputed": [claim for claim in claims if claim["id"] in disputed_claim_ids],
                    "contextualized": [claim for claim in claims if claim["id"] in contextual_claim_ids],
                    "needs_evidence_review": [claim for claim in claims if claim["id"] in needs_review_claim_ids],
                    "proposed_support": [claim for claim in claims if claim["id"] in needs_review_claim_ids],
                    "unsupported": [claim for claim in claims if claim["id"] not in classified_claim_ids],
                    "all": claims,
                },
                "risk_review": {
                    "contradictions": [self._serialize_contradiction(item) for item in session.query(Contradiction).filter_by(case_id=case_id).all()],
                    "missing_evidence": [self._serialize_missing_evidence(item) for item in session.query(MissingEvidenceWarning).filter_by(case_id=case_id).all()],
                    "deadlines": [self._serialize_deadline(item) for item in session.query(Deadline).filter_by(case_id=case_id).all()],
                    "obligations": [self._serialize_obligation(item) for item in session.query(Obligation).filter_by(case_id=case_id).all()],
                    "open_loops": [self._serialize_open_loop(item) for item in session.query(OpenLoop).filter_by(case_id=case_id).all()],
                    "case_analysis": analysis_review_items,
                },
                "legal_safety": {
                    "not_legal_advice": True,
                    "requires_human_review": True,
                    "external_sharing_requires_approval": True,
                    "claim_support_requires_confirmed_evidence_link": True,
                },
                "generated_at": _iso(utcnow()),
            }

    def case_comprehension_dossier(self, case_id: int) -> Optional[Dict[str, Any]]:
        """Build a source-linked, case-level reading dossier from persisted records."""
        summary = self.case_summary(case_id)
        if not summary:
            return None

        documents = summary["factual_reconstruction"]["source_documents"]
        timeline = summary["factual_reconstruction"]["known_events"]
        claims = summary["claims"]["all"]
        evidence_links = self.list_evidence_links(case_id)
        links_by_target: Dict[str, List[Dict[str, Any]]] = {}
        links_by_document: Dict[int, List[Dict[str, Any]]] = {}
        for link in evidence_links:
            links_by_target.setdefault(f"{link.get('target_type')}:{link.get('target_id')}", []).append(link)
            if link.get("document_id") is not None:
                links_by_document.setdefault(int(link["document_id"]), []).append(link)

        document_lookup = {document["document_id"]: document for document in documents}
        source_documents = [self._comprehension_document(document, links_by_document.get(document["document_id"], [])) for document in documents]
        source_linked_events = [
            self._comprehension_event(event, document_lookup, links_by_target.get(f"event:{event.get('id')}", []))
            for event in timeline
        ]
        source_linked_claims = [
            self._comprehension_claim(claim, document_lookup, links_by_target.get(f"claim:{claim.get('id')}", []))
            for claim in claims
        ]
        review = summary["risk_review"]
        readable_documents = [item for item in source_documents if item["readable"]]
        word_count = sum(item["word_count"] for item in source_documents)
        open_review_items = [
            *[self._review_summary_item("contradiction", item) for item in review["contradictions"] if item.get("status") not in {"resolved", "dismissed"}],
            *[self._review_summary_item("missing_evidence", item) for item in review["missing_evidence"] if item.get("status") not in {"resolved", "dismissed"}],
            *[self._review_summary_item("deadline", item) for item in review["deadlines"] if item.get("status") not in {"resolved", "dismissed"}],
            *[self._review_summary_item("obligation", item) for item in review["obligations"] if item.get("status") not in {"resolved", "dismissed"} and not item.get("user_confirmed")],
            *[self._review_summary_item("open_loop", item) for item in review["open_loops"] if item.get("status") not in {"resolved", "dismissed"}],
            *[self._review_summary_item("case_analysis", item) for item in review.get("case_analysis", []) if item.get("status") == "needs_review"],
        ]

        return {
            "case_id": case_id,
            "case": summary["case"],
            "reading_status": {
                "documents_total": len(source_documents),
                "documents_readable": len(readable_documents),
                "word_count": word_count,
                "source_links": len(evidence_links),
                "timeline_events": len(source_linked_events),
                "claims": len(source_linked_claims),
                "open_review_items": len(open_review_items),
                "confidence": self._dossier_confidence(readable_documents, evidence_links, open_review_items),
            },
            "source_documents": source_documents,
            "chronology": source_linked_events,
            "positions": {
                "supported": [item for item in source_linked_claims if item["evidence_state"] == "supported"],
                "mixed": [item for item in source_linked_claims if item["evidence_state"] == "mixed"],
                "disputed": [item for item in source_linked_claims if item["evidence_state"] == "disputed"],
                "contextualized": [item for item in source_linked_claims if item["evidence_state"] == "context"],
                "needs_evidence_review": [item for item in source_linked_claims if item["evidence_state"] == "needs_review"],
                "evidence_review_pending": [item for item in source_linked_claims if item["proposed_sources"]],
                "proposed_support": [item for item in source_linked_claims if item["evidence_state"] == "needs_review"],
                "unsupported": [item for item in source_linked_claims if item["evidence_state"] == "unsupported"],
                "all": source_linked_claims,
            },
            "review": {
                "open_items": open_review_items,
                "contradictions": review["contradictions"],
                "missing_evidence": review["missing_evidence"],
                "deadlines": review["deadlines"],
                "obligations": review["obligations"],
                "open_loops": review["open_loops"],
                "case_analysis": review.get("case_analysis", []),
            },
            "next_actions": self._comprehension_next_actions(source_documents, source_linked_events, source_linked_claims, open_review_items),
            "legal_safety": {
                **summary["legal_safety"],
                "facts_are_source_summaries": True,
                "unconfirmed_items_require_review": True,
                "proposed_evidence_is_not_confirmed_support": True,
                "no_external_action_taken": True,
            },
            "generated_at": _iso(utcnow()),
        }

    def case_position_matrix(self, case_id: int) -> Optional[Dict[str, Any]]:
        """Group source-assessed claims by the party or institution asserting them."""
        dossier = self.case_comprehension_dossier(case_id)
        if not dossier:
            return None

        claims = dossier["positions"]["all"]
        groups_by_key: Dict[str, Dict[str, Any]] = {}
        for claim in claims:
            asserted_by = str(claim.get("asserted_by") or "Unknown source").strip()
            position_role = str(claim.get("position_role") or "unknown").strip().lower()
            key = f"{position_role}:{asserted_by.lower()}"
            group = groups_by_key.setdefault(key, {
                "key": key,
                "asserted_by": asserted_by,
                "position_role": position_role,
                "claims": [],
                "counts": {"supported": 0, "mixed": 0, "disputed": 0, "context": 0, "needs_review": 0, "unsupported": 0},
            })
            group["claims"].append(claim)
            evidence_state = claim.get("evidence_state") or "unsupported"
            group["counts"][evidence_state] = group["counts"].get(evidence_state, 0) + 1

        materiality_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
        role_order = {"client": 0, "counterparty": 1, "institution": 2, "court": 3, "third_party": 4, "source": 5, "unknown": 6}
        groups = list(groups_by_key.values())
        for group in groups:
            group["claims"].sort(key=lambda item: (
                materiality_order.get(item.get("materiality") or "medium", 2),
                item.get("id") or 0,
            ))
        groups.sort(key=lambda item: (role_order.get(item["position_role"], 7), item["asserted_by"].lower()))

        counts = {"all": len(claims), "supported": 0, "mixed": 0, "disputed": 0, "context": 0, "needs_review": 0, "unsupported": 0}
        for claim in claims:
            evidence_state = claim.get("evidence_state") or "unsupported"
            counts[evidence_state] = counts.get(evidence_state, 0) + 1
        counts["open_review"] = len([claim for claim in claims if claim.get("status") in {"unreviewed", "needs_review"}])
        counts["pending_source_classification"] = sum(len(claim.get("proposed_sources") or []) for claim in claims)

        return {
            "case_id": case_id,
            "counts": counts,
            "groups": groups,
            "claims": claims,
            "legal_safety": {
                **dossier["legal_safety"],
                "claim_review_does_not_establish_truth": True,
                "confirmed_relationship_required_for_evidence_state": True,
                "mixed_evidence_is_not_presented_as_supported": True,
            },
            "generated_at": _iso(utcnow()),
        }

    def red_line_thread(self, case_id: int) -> Optional[Dict[str, Any]]:
        summary = self.case_summary(case_id)
        if not summary:
            return None
        dossier = self.case_comprehension_dossier(case_id) or {}
        case = summary["case"]
        source_documents = dossier.get("source_documents") or summary["factual_reconstruction"]["source_documents"]
        chronology = dossier.get("chronology") or summary["factual_reconstruction"]["known_events"]
        positions = dossier.get("positions") or {
            "supported": summary["claims"]["supported"],
            "mixed": summary["claims"].get("mixed", []),
            "disputed": summary["claims"].get("disputed", []),
            "contextualized": summary["claims"].get("contextualized", []),
            "needs_evidence_review": summary["claims"].get("needs_evidence_review", []),
            "unsupported": summary["claims"]["unsupported"],
            "all": summary["claims"]["all"],
        }
        review = dossier.get("review") or {
            "open_items": [],
            "contradictions": summary["risk_review"]["contradictions"],
            "missing_evidence": summary["risk_review"]["missing_evidence"],
            "deadlines": summary["risk_review"]["deadlines"],
            "obligations": summary["risk_review"]["obligations"],
            "open_loops": summary["risk_review"]["open_loops"],
            "case_analysis": summary["risk_review"].get("case_analysis", []),
        }
        next_actions = dossier.get("next_actions") or []

        def source_ref(source: Dict[str, Any]) -> str:
            if not source:
                return "source: not linked"
            document_id = source.get("document_id")
            title = source.get("title") or "Source document"
            snippet = source.get("snippet") or ""
            ref = f"source: doc {document_id} - {title}" if document_id else f"source: {title}"
            if snippet:
                ref = f"{ref}; quote: {snippet[:160]}"
            return ref

        def event_line(event: Dict[str, Any]) -> str:
            status = "confirmed" if event.get("user_confirmed") else event.get("review_status") or "needs_review"
            actor = event.get("actor") or "unknown actor"
            action = event.get("action") or event.get("title") or "documented event"
            affected = f" -> {event.get('affected_party')}" if event.get("affected_party") else ""
            event_fact = f"{actor}: {action}{affected}"
            if event.get("source"):
                return f"- {event.get('date') or event.get('event_date')}: {event_fact} - {event.get('what') or event.get('description') or 'no detail'} [{source_ref(event.get('source') or {})}; {status}]"
            return f"- {event.get('event_date')}: {event_fact} ({event.get('description') or 'no description'}) [{status}]"

        def claim_line(claim: Dict[str, Any]) -> str:
            sources = claim.get("supporting_sources") or []
            disputing_sources = claim.get("disputing_sources") or []
            context_sources = claim.get("context_sources") or []
            proposed_sources = claim.get("proposed_sources") or []
            source_parts = []
            if sources:
                source_parts.append("supports: " + "; ".join(source_ref(item) for item in sources[:3]))
            if disputing_sources:
                source_parts.append("disputes: " + "; ".join(source_ref(item) for item in disputing_sources[:3]))
            if context_sources:
                source_parts.append("context: " + "; ".join(source_ref(item) for item in context_sources[:3]))
            if proposed_sources:
                source_parts.append("pending classification: " + "; ".join(source_ref(item) for item in proposed_sources[:3]))
            source_bits = " | ".join(source_parts) or "source: not linked"
            role = claim.get("position_role") or "unknown role"
            return f"- {claim.get('asserted_by') or 'unknown'} ({role}): {claim.get('statement') or ''} [{source_bits}]"

        def review_line(item: Dict[str, Any]) -> str:
            return f"- {item.get('type') or item.get('warning_type') or item.get('deadline_type') or 'review'}: {item.get('title') or item.get('description') or item.get('suggested_action') or 'Review item'} ({item.get('status') or 'needs_review'})"

        lines = [
            f"Case: {case.get('title')}",
            f"Domain: {case.get('legal_domain') or 'unknown'}",
            f"Desired outcome: {case.get('desired_outcome') or 'Not recorded'}",
            f"Current status: {case.get('status') or 'unknown'}",
            "",
            "Safety:",
            "- Internal preparation only until explicit approval is recorded.",
            "- Facts below are source summaries and unconfirmed items require review.",
            "",
            "Source documents:",
        ]
        lines.extend(
            f"- doc {document.get('document_id')}: {document.get('title')} ({document.get('document_type') or 'document'}; {document.get('word_count', 0)} words; {document.get('confidence') or 'unknown'} confidence)"
            for document in source_documents
        )
        if not source_documents:
            lines.append("- No source documents linked yet.")

        lines.extend(["", "Chronology:"])
        lines.extend(event_line(event) for event in chronology)
        if not chronology:
            lines.append("- No confirmed timeline events recorded yet.")

        lines.extend(["", "Evidence position:"])
        lines.append(f"- Documents linked: {len(source_documents)}")
        lines.append(f"- Confirmed supported claims: {len(positions.get('supported', []))}")
        lines.extend(claim_line(claim) for claim in positions.get("supported", [])[:8])
        lines.append(f"- Mixed support and dispute: {len(positions.get('mixed', []))}")
        lines.extend(claim_line(claim) for claim in positions.get("mixed", [])[:8])
        lines.append(f"- Confirmed disputed claims: {len(positions.get('disputed', []))}")
        lines.extend(claim_line(claim) for claim in positions.get("disputed", [])[:8])
        lines.append(f"- Context-only claims: {len(positions.get('contextualized', []))}")
        lines.extend(claim_line(claim) for claim in positions.get("contextualized", [])[:8])
        pending_positions = positions.get("evidence_review_pending", positions.get("needs_evidence_review", positions.get("proposed_support", [])))
        lines.append(f"- Claims with evidence awaiting classification: {len(pending_positions)}")
        lines.extend(claim_line(claim) for claim in pending_positions[:8])
        lines.append(f"- Unsupported claims: {len(positions.get('unsupported', []))}")
        lines.extend(claim_line(claim) for claim in positions.get("unsupported", [])[:8])

        lines.extend(["", "Review items:"])
        open_items = review.get("open_items") or []
        if open_items:
            lines.extend(review_line(item) for item in open_items[:12])
        else:
            lines.append("- No open contradiction, evidence-gap, deadline, obligation, or loop item is currently queued.")
        lines.append(f"- Contradictions: {len(review.get('contradictions', []))}")
        lines.append(f"- Case-wide observations: {len(review.get('case_analysis', []))}")
        lines.append(f"- Missing evidence warnings: {len(review.get('missing_evidence', []))}")
        lines.append(f"- Open deadlines: {len(review.get('deadlines', []))}")
        lines.append(f"- Source-linked obligations: {len(review.get('obligations', []))}")

        lines.extend(["", "Next actions:"])
        lines.extend(
            f"- {action.get('label')}: {action.get('detail')}"
            for action in next_actions[:6]
        )
        if not next_actions:
            lines.append("- No next action generated yet.")

        return {
            "case_id": case_id,
            "title": f"Red-line thread for {case.get('title')}",
            "body": "\n".join(lines),
            "sections": {
                "source_documents": source_documents,
                "chronology": summary["factual_reconstruction"]["known_events"],
                "source_linked_chronology": chronology,
                "supported_claims": positions.get("supported", []),
                "proposed_support_claims": positions.get("proposed_support", []),
                "unsupported_claims": positions.get("unsupported", []),
                "positions": positions,
                "review_items": review,
                "next_actions": next_actions,
            },
            "legal_safety": {
                **summary["legal_safety"],
                **(dossier.get("legal_safety") or {}),
            },
            "generated_at": summary["generated_at"],
        }

    def case_bundle(self, case_id: int) -> Optional[Dict[str, Any]]:
        summary = self.case_summary(case_id)
        if not summary:
            return None
        red_line = self.red_line_thread(case_id)
        with self.session_scope() as session:
            snapshot_context = self._case_bundle_snapshot_context(session, case_id)
            audit_events = [self._serialize_audit(item) for item in session.query(AuditEvent).filter_by(case_id=case_id).order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc()).limit(100).all()]
            outreach = [self._serialize_outreach(item) for item in session.query(LawyerOutreach).filter_by(case_id=case_id).order_by(LawyerOutreach.created_at.desc()).all()]
            lawyer_responses = [
                self._serialize_lawyer_response(response, outreach_item)
                for response, outreach_item in session.query(LawyerResponse, LawyerOutreach)
                .join(LawyerOutreach, LawyerResponse.outreach_id == LawyerOutreach.id)
                .filter(LawyerOutreach.case_id == case_id)
                .order_by(LawyerResponse.received_at.desc(), LawyerResponse.id.desc()).all()
            ]
            drafts = [self._serialize_draft(item) for item in session.query(Draft).filter_by(case_id=case_id).order_by(Draft.updated_at.desc(), Draft.id.desc()).all()]
            approvals = [self._serialize_approval(item) for item in session.query(Approval).filter_by(case_id=case_id).order_by(Approval.created_at.desc()).all()]
        bundle_approvals = [item for item in approvals if item.get("entity_type") == "CaseBundle" and item.get("action") == "share_case_bundle_externally"]
        snapshot_hash = snapshot_context.get("bundle_snapshot_hash")
        current_bundle_approvals = [
            item for item in bundle_approvals
            if (item.get("context") or {}).get("bundle_snapshot_hash") == snapshot_hash
        ]
        pending_bundle_approval = next((item for item in current_bundle_approvals if item.get("status") == "pending"), None)
        latest_current_approval = current_bundle_approvals[0] if current_bundle_approvals else None
        latest_bundle_approval = bundle_approvals[0] if bundle_approvals else None
        approval_stale = bool(
            latest_bundle_approval
            and (latest_bundle_approval.get("context") or {}).get("bundle_snapshot_hash") != snapshot_hash
            and latest_bundle_approval.get("status") in {"pending", "approved"}
        )
        share_status = "internal_only_until_approved"
        if pending_bundle_approval:
            share_status = "external_share_approval_pending"
        elif latest_current_approval and latest_current_approval.get("status") == "approved":
            share_status = "external_share_approved"
        elif latest_current_approval and latest_current_approval.get("status") == "rejected":
            share_status = "external_share_rejected"
        elif approval_stale:
            share_status = "external_share_approval_stale"
        sharing_approval = pending_bundle_approval or latest_current_approval or latest_bundle_approval
        return {
            "case_id": case_id,
            "bundle_type": "internal_case_bundle",
            "share_status": share_status,
            "external_sharing_requires_approval": True,
            "external_sharing_approval": sharing_approval,
            "external_sharing_allowed": bool(latest_current_approval and latest_current_approval.get("status") == "approved" and not pending_bundle_approval),
            "approval_stale": approval_stale,
            "bundle_snapshot_hash": snapshot_hash,
            "approval_snapshot_hash": (sharing_approval.get("context") or {}).get("bundle_snapshot_hash") if sharing_approval else None,
            "snapshot_counts": snapshot_context.get("snapshot_counts") or {},
            "summary": summary,
            "red_line": red_line,
            "document_index": summary["factual_reconstruction"]["source_documents"],
            "source_documents": (red_line or {}).get("sections", {}).get("source_documents", []),
            "timeline": summary["factual_reconstruction"]["known_events"],
            "source_linked_timeline": (red_line or {}).get("sections", {}).get("source_linked_chronology", []),
            "claims": summary["claims"],
            "review_items": summary["risk_review"],
            "next_actions": (red_line or {}).get("sections", {}).get("next_actions", []),
            "outreach": outreach,
            "lawyer_responses": lawyer_responses,
            "drafts": drafts,
            "approvals": approvals,
            "audit_events": audit_events,
            "generated_at": _iso(utcnow()),
        }

    def _comprehension_document(self, document: Dict[str, Any], links: List[Dict[str, Any]]) -> Dict[str, Any]:
        analysis = (document.get("metadata") or {}).get("legal_analysis") or {}
        facts = analysis.get("facts") or {}
        processing = analysis.get("processing") or {}
        return {
            "document_id": document.get("document_id"),
            "title": document.get("title") or document.get("original_filename") or "Untitled document",
            "source_type": document.get("source_type"),
            "source_uri": document.get("source_uri"),
            "document_type": analysis.get("document_type") or document.get("document_type"),
            "summary": analysis.get("summary") or document.get("summary") or "",
            "readable": bool(analysis.get("readable") or document.get("extracted_text")),
            "word_count": int(processing.get("word_count") or len((document.get("extracted_text") or "").split())),
            "confidence": processing.get("confidence") or "unknown",
            "topics": analysis.get("topics") or [],
            "dates": facts.get("dates") or [],
            "parties": facts.get("parties") or [],
            "obligations": facts.get("obligations") or [],
            "monetary_amounts": facts.get("monetary_amounts") or [],
            "legal_references": facts.get("legal_references") or [],
            "risks": analysis.get("risks") or [],
            "source_links": len(links),
        }

    def _comprehension_event(
        self,
        event: Dict[str, Any],
        document_lookup: Dict[int, Dict[str, Any]],
        links: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        document = document_lookup.get(event.get("created_from_document_id"))
        return {
            "id": event.get("id"),
            "date": event.get("event_date"),
            "title": event.get("title"),
            "who": self._infer_actor(event.get("title") or event.get("description") or ""),
            "what": event.get("description") or event.get("summary") or "",
            "review_status": event.get("review_status"),
            "user_confirmed": event.get("user_confirmed"),
            "source": self._source_summary(document, links),
        }

    def _comprehension_claim(
        self,
        claim: Dict[str, Any],
        document_lookup: Dict[int, Dict[str, Any]],
        links: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        active_links = [link for link in links if link.get("relationship") != "rejected_suggestion"]
        supporting_links = [link for link in active_links if link.get("user_confirmed") and link.get("relationship") == "supports"]
        disputing_links = [link for link in active_links if link.get("user_confirmed") and link.get("relationship") == "disputes"]
        context_links = [link for link in active_links if link.get("user_confirmed") and link.get("relationship") == "context"]
        confirmed_links = supporting_links + disputing_links + context_links
        proposed_links = [link for link in active_links if link not in confirmed_links]
        if supporting_links and disputing_links:
            evidence_state = "mixed"
        elif supporting_links:
            evidence_state = "supported"
        elif disputing_links:
            evidence_state = "disputed"
        elif context_links:
            evidence_state = "context"
        elif proposed_links:
            evidence_state = "needs_review"
        else:
            evidence_state = "unsupported"
        return {
            "id": claim.get("id"),
            "asserted_by": claim.get("asserted_by"),
            "position_role": claim.get("position_role"),
            "subject_party": claim.get("subject_party"),
            "claim_type": claim.get("claim_type"),
            "materiality": claim.get("materiality"),
            "statement": claim.get("statement"),
            "status": claim.get("status"),
            "confidence": claim.get("confidence"),
            "evidence_state": evidence_state,
            "supporting_sources": [
                self._source_summary(document_lookup.get(link.get("document_id")), [link])
                for link in supporting_links
            ],
            "disputing_sources": [
                self._source_summary(document_lookup.get(link.get("document_id")), [link])
                for link in disputing_links
            ],
            "context_sources": [
                self._source_summary(document_lookup.get(link.get("document_id")), [link])
                for link in context_links
            ],
            "proposed_sources": [
                self._source_summary(document_lookup.get(link.get("document_id")), [link])
                for link in proposed_links
            ],
        }

    def _source_summary(self, document: Optional[Dict[str, Any]], links: List[Dict[str, Any]]) -> Dict[str, Any]:
        link = links[0] if links else {}
        return {
            "evidence_link_id": link.get("id"),
            "document_id": document.get("document_id") if document else link.get("document_id"),
            "title": (document or {}).get("title") or (document or {}).get("original_filename") or "Source document",
            "source_type": (document or {}).get("source_type"),
            "source_uri": (document or {}).get("source_uri"),
            "snippet": link.get("snippet") or "",
            "relationship": link.get("relationship") or "",
            "strength": link.get("strength") or "",
            "source_confidence": link.get("source_confidence") or 0.0,
            "user_confirmed": bool(link.get("user_confirmed", False)),
        }

    def _review_summary_item(self, item_type: str, item: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "type": item_type,
            "id": item.get("id"),
            "title": item.get("title") or item.get("action") or item_type.replace("_", " "),
            "status": item.get("status"),
            "severity": item.get("severity") or item.get("risk_level") or "",
            "description": item.get("description") or item.get("suggested_action") or item.get("next_action") or "",
            "source_document_id": item.get("source_document_id"),
        }

    def _comprehension_next_actions(
        self,
        documents: List[Dict[str, Any]],
        events: List[Dict[str, Any]],
        claims: List[Dict[str, Any]],
        open_review_items: List[Dict[str, Any]],
    ) -> List[Dict[str, str]]:
        actions: List[Dict[str, str]] = []
        unreadable = [item for item in documents if not item["readable"]]
        if not documents:
            actions.append({"target": "documents", "label": "Add source documents", "detail": "The case has no readable evidence yet."})
        elif unreadable:
            actions.append({"target": "documents", "label": "Review unreadable documents", "detail": f"{len(unreadable)} document(s) need text extraction or manual review."})
        if any(event.get("review_status") == "needs_review" for event in events):
            actions.append({"target": "timeline", "label": "Confirm timeline suggestions", "detail": "Review extracted events before relying on the chronology."})
        proposed_support = [claim for claim in claims if claim.get("proposed_sources")]
        disputed_claims = [claim for claim in claims if claim.get("evidence_state") in {"disputed", "mixed"}]
        unsupported_claims = [claim for claim in claims if claim.get("evidence_state") == "unsupported"]
        if proposed_support:
            actions.append({"target": "evidence", "label": "Classify proposed evidence links", "detail": f"{len(proposed_support)} claim(s) have cited evidence that must be classified as support, dispute, or context."})
        if disputed_claims:
            actions.append({"target": "claims", "label": "Review disputed positions", "detail": f"{len(disputed_claims)} claim(s) have confirmed disputing evidence and must not be presented as established facts."})
        if unsupported_claims:
            actions.append({"target": "claims", "label": "Add evidence to unsupported claims", "detail": "Claims without source links should not be treated as proven facts."})
        if open_review_items:
            actions.append({"target": "review", "label": "Resolve review queue", "detail": f"{len(open_review_items)} contradiction, gap, deadline, open-loop, or cited analysis item(s) need attention."})
        if not actions:
            actions.append({"target": "bundle", "label": "Prepare internal case bundle", "detail": "The readable evidence is organized; review export material before external sharing."})
        return actions[:6]

    def _infer_actor(self, text: str) -> str:
        for marker in (" stated ", " decided ", " sent ", " requested ", " objected ", " confirmed ", " rejected "):
            if marker in f" {text} ".lower():
                prefix = text.lower().split(marker.strip(), 1)[0].strip(" .:-")
                if prefix:
                    return prefix.split()[-1].upper() if prefix.split()[-1].isupper() else prefix.split()[-1].title()
        for name in ("Robert", "CAK", "Gemeente", "Rechtbank", "Landlord", "Tenant", "Lawyer"):
            if name.lower() in text.lower():
                return name
        return "Unknown actor"

    def _dossier_confidence(
        self,
        readable_documents: List[Dict[str, Any]],
        evidence_links: List[Dict[str, Any]],
        open_review_items: List[Dict[str, Any]],
    ) -> str:
        if not readable_documents:
            return "low"
        if len(readable_documents) >= 2 and evidence_links and not open_review_items:
            return "high"
        if evidence_links:
            return "medium"
        return "low"

    def _ensure_user(self, session, external_user_id: Any, email: Optional[str] = None) -> LedgerUser:
        external = str(external_user_id or email or "anonymous")
        user = session.query(LedgerUser).filter_by(external_user_id=external).one_or_none()
        if user:
            if email and user.email != email:
                user.email = email
                user.updated_at = utcnow()
            return user
        user = LedgerUser(external_user_id=external, email=email or "")
        session.add(user)
        session.flush()
        return user

    def _empty_command_center(self) -> Dict[str, Any]:
        return {
            "generated_at": _iso(utcnow()),
            "counts": {
                "active_cases": 0,
                "urgent_deadlines": 0,
                "cases_needing_robert": 0,
                "cases_needing_evidence": 0,
                "cases_awaiting_lawyer_response": 0,
                "pending_outreach_approval": 0,
                "pending_approvals": 0,
                "open_loops": 0,
                "contradictions": 0,
                "missing_evidence": 0,
                "deadlines": 0,
                "obligations": 0,
                "document_inbox": 0,
                "high_risk_items": 0,
            },
            "cases": [],
            "pending_approvals": [],
            "pending_outreach_approval": [],
            "open_loops": [],
            "contradictions": [],
            "missing_evidence": [],
            "deadlines": [],
            "obligations": [],
            "document_inbox": [],
            "urgent_deadlines": [],
            "awaiting_lawyer_response": [],
            "high_risk_items": [],
            "review_queues": {
                "cases_needing_robert": [],
                "cases_needing_evidence": [],
                "cases_awaiting_lawyer_response": [],
                "pending_outreach_approval": [],
                "urgent_deadlines": [],
                "high_risk_items": [],
                "document_inbox": [],
            },
            "recent_activity": [],
            "next_actions": [{
                "priority": "normal",
                "label": "Create the first legal case",
                "detail": "Start the ledger by adding the dispute, desired outcome, and parties.",
                "target": "case-intake",
            }],
        }

    def _is_urgent_due_date(self, value: Optional[str]) -> bool:
        if not value:
            return False
        try:
            due = _dt.date.fromisoformat(str(value)[:10])
        except (TypeError, ValueError):
            return False
        today = _dt.date.today()
        return due <= today + _dt.timedelta(days=7)

    def _high_risk_command_items(
        self,
        approvals: List[Dict[str, Any]],
        contradictions: List[Dict[str, Any]],
        missing_evidence: List[Dict[str, Any]],
        obligations: List[Dict[str, Any]],
        open_loops: List[Dict[str, Any]],
        urgent_deadlines: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        items: List[Dict[str, Any]] = []
        for approval in approvals:
            if approval.get("risk_level") == "high":
                items.append({
                    "item_type": "approval",
                    "case_id": approval.get("case_id"),
                    "priority": "high",
                    "label": approval.get("action") or "Pending approval",
                    "detail": approval.get("reason") or "High-risk legal action requires review.",
                    "source": approval,
                })
        for contradiction in contradictions:
            if contradiction.get("severity") in {"high", "critical"}:
                items.append({
                    "item_type": "contradiction",
                    "case_id": contradiction.get("case_id"),
                    "priority": contradiction.get("severity"),
                    "label": contradiction.get("title") or "High-risk contradiction",
                    "detail": contradiction.get("description") or "Conflicting evidence needs review.",
                    "source": contradiction,
                })
        for warning in missing_evidence:
            if warning.get("severity") in {"high", "critical"}:
                items.append({
                    "item_type": "missing_evidence",
                    "case_id": warning.get("case_id"),
                    "priority": warning.get("severity"),
                    "label": warning.get("title") or "Missing evidence",
                    "detail": warning.get("suggested_action") or warning.get("description") or "Evidence gap needs review.",
                    "source": warning,
                })
        for obligation in obligations:
            if obligation.get("risk_level") == "high":
                items.append({
                    "item_type": "obligation",
                    "case_id": obligation.get("case_id"),
                    "priority": "high",
                    "label": obligation.get("title") or "High-risk obligation",
                    "detail": obligation.get("description") or obligation.get("source_quote") or "A source-linked duty needs confirmation.",
                    "source": obligation,
                })
        for loop in open_loops:
            if loop.get("risk_level") == "high":
                items.append({
                    "item_type": "open_loop",
                    "case_id": loop.get("case_id"),
                    "priority": "high",
                    "label": loop.get("title") or "High-risk open loop",
                    "detail": loop.get("next_action") or loop.get("description") or "Open legal action needs Robert.",
                    "source": loop,
                })
        for deadline in urgent_deadlines:
            if deadline.get("requires_approval"):
                items.append({
                    "item_type": "deadline",
                    "case_id": deadline.get("case_id"),
                    "priority": "urgent",
                    "label": deadline.get("title") or "Urgent deadline",
                    "detail": f"Due {deadline.get('due_date', 'unknown date')}",
                    "source": deadline,
                })
        return items

    def _next_actions(
        self,
        cases: List[Dict[str, Any]],
        approvals: List[Dict[str, Any]],
        obligations: List[Dict[str, Any]],
        open_loops: List[Dict[str, Any]],
        contradictions: List[Dict[str, Any]],
        missing_evidence: List[Dict[str, Any]],
        deadlines: List[Dict[str, Any]],
        document_inbox: Optional[List[Dict[str, Any]]] = None,
    ) -> List[Dict[str, Any]]:
        actions = []
        for item in (document_inbox or [])[:2]:
            suggested = (item.get("suggested_matches") or [{}])[0]
            suggested_label = f" Suggested case: {suggested.get('case_title')}." if suggested.get("case_title") else ""
            actions.append({
                "priority": "medium",
                "label": f"Classify inbox source: {item.get('title') or 'Untitled document'}",
                "detail": f"Review the source and confirm which legal case it belongs to.{suggested_label}",
                "case_id": suggested.get("case_id"),
                "target": "document-inbox",
                "queue_type": "document_inbox",
                "item_id": item.get("id"),
            })
        for approval in approvals[:3]:
            actions.append({
                "priority": approval.get("risk_level", "high"),
                "label": f"Review approval: {approval.get('action', 'pending action')}",
                "detail": approval.get("reason") or "A high-risk external/legal action is waiting for explicit approval.",
                "case_id": approval.get("case_id"),
                "target": "approvals",
                "queue_type": "approval",
                "item_id": approval.get("id"),
            })
        for deadline in deadlines[:3]:
            actions.append({
                "priority": "urgent",
                "label": f"Deadline: {deadline.get('title', 'Untitled deadline')}",
                "detail": f"Due {deadline.get('due_date', 'unknown date')}",
                "case_id": deadline.get("case_id"),
                "target": "deadlines",
                "queue_type": "deadline",
                "item_id": deadline.get("id"),
            })
        for item in obligations[:3]:
            due = f" Due {item.get('due_date')}." if item.get("due_date") else ""
            actions.append({
                "priority": item.get("risk_level", "medium"),
                "label": f"Confirm obligation: {item.get('title', 'Source-linked duty')}",
                "detail": (item.get("description") or item.get("source_quote") or "Confirm who must do what before relying on this obligation.") + due,
                "case_id": item.get("case_id"),
                "target": "obligations",
                "queue_type": "obligation",
                "item_id": item.get("id"),
            })
        for contradiction in contradictions[:2]:
            actions.append({
                "priority": contradiction.get("severity", "medium"),
                "label": f"Review contradiction: {contradiction.get('title', 'Potential conflict')}",
                "detail": contradiction.get("description") or "Conflicting case information needs review.",
                "case_id": contradiction.get("case_id"),
                "target": "contradictions",
                "queue_type": "contradiction",
                "item_id": contradiction.get("id"),
            })
        for warning in missing_evidence[:2]:
            actions.append({
                "priority": warning.get("severity", "medium"),
                "label": f"Find evidence: {warning.get('title', 'Missing evidence')}",
                "detail": warning.get("suggested_action") or warning.get("description") or "A claim or case fact needs source support.",
                "case_id": warning.get("case_id"),
                "target": "missing-evidence",
                "queue_type": "gap",
                "item_id": warning.get("id"),
            })
        for item in open_loops[:2]:
            actions.append({
                "priority": item.get("risk_level", "medium"),
                "label": item.get("title", "Open loop"),
                "detail": item.get("next_action") or item.get("description") or "An unresolved case action needs attention.",
                "case_id": item.get("case_id"),
                "target": "open-loops",
                "queue_type": "loop",
                "item_id": item.get("id"),
            })
        for case in cases:
            if case.get("documents_count", 0) == 0:
                actions.append({
                    "priority": "normal",
                    "label": f"Add evidence to {case.get('title')}",
                    "detail": "This case has no linked documents yet.",
                    "case_id": case.get("case_id"),
                    "target": "documents",
                })
                break
        return actions[:8] or [{
            "priority": "normal",
            "label": "Review the active case ledger",
            "detail": "Cases are up to date. Open a case to inspect timeline, evidence, and audit trail.",
            "target": "case-ledger",
        }]

    def _sync_parties(self, session, case_id: int, parties: Iterable[Any]) -> None:
        for item in parties:
            if isinstance(item, str):
                name = item
                payload = {}
            else:
                payload = dict(item or {})
                name = payload.get("name")
            if not name:
                continue
            session.add(Party(
                case_id=case_id,
                name=name,
                party_type=payload.get("party_type") or payload.get("type") or "unknown",
                role=payload.get("role") or "",
                contact=_json_dump(payload.get("contact") or {}),
                notes=payload.get("notes") or "",
            ))

    def _has_identifier_payload(self, data: Dict[str, Any]) -> bool:
        return any(
            key in data
            for key in (
                "identifiers",
                "case_identifiers",
                "external_identifiers",
                "external_references",
                "sub_case_ids",
                "case_reference",
                "case_reference_number",
                "dossier_number",
            )
        )

    def _sync_case_identifiers(self, session, case_id: int, data: Dict[str, Any], replace: bool = False) -> None:
        if replace:
            session.query(CaseIdentifier).filter_by(case_id=case_id).delete()
        for payload in self._identifier_payloads(data):
            self._create_or_update_identifier(session, case_id, payload)

    def _identifier_payloads(self, data: Dict[str, Any]) -> List[Dict[str, Any]]:
        payloads: List[Dict[str, Any]] = []
        for key in ("identifiers", "case_identifiers", "external_identifiers", "external_references"):
            value = data.get(key)
            if not value:
                continue
            items = value if isinstance(value, list) else [value]
            for item in items:
                payloads.append(self._normalize_identifier_payload(item))

        sub_case_values = data.get("sub_case_ids") or []
        if isinstance(sub_case_values, (str, int)):
            sub_case_values = [sub_case_values]
        for value in sub_case_values:
            payloads.append(self._normalize_identifier_payload({
                "identifier_type": "sub_case_id",
                "identifier_value": value,
                "source_party": data.get("court_or_institution") or data.get("source_party") or "",
            }))

        direct_fields = {
            "case_reference": "case_reference",
            "case_reference_number": "case_reference",
            "dossier_number": "dossier_number",
        }
        for key, identifier_type in direct_fields.items():
            if data.get(key):
                payloads.append(self._normalize_identifier_payload({
                    "identifier_type": identifier_type,
                    "identifier_value": data.get(key),
                    "source_party": data.get("court_or_institution") or data.get("source_party") or "",
                }))

        return [payload for payload in payloads if payload.get("identifier_value")]

    def _normalize_identifier_payload(self, item: Any) -> Dict[str, Any]:
        if isinstance(item, str):
            payload = {"identifier_value": item}
        else:
            payload = dict(item or {})

        value = (
            payload.get("identifier_value")
            or payload.get("value")
            or payload.get("identifier")
            or payload.get("reference")
            or payload.get("reference_number")
            or payload.get("case_number")
            or payload.get("dossier_number")
            or payload.get("id")
        )
        return {
            "identifier_type": str(payload.get("identifier_type") or payload.get("type") or "external_reference").strip() or "external_reference",
            "identifier_value": str(value or "").strip(),
            "source_party": str(payload.get("source_party") or payload.get("issuer") or payload.get("authority") or "").strip(),
            "source_type": str(payload.get("source_type") or payload.get("source") or "").strip(),
            "source_uri": str(payload.get("source_uri") or payload.get("url") or payload.get("uri") or "").strip(),
            "notes": str(payload.get("notes") or payload.get("description") or "").strip(),
            "metadata": payload.get("metadata") or {},
        }

    def _create_or_update_identifier(self, session, case_id: int, data: Dict[str, Any]) -> CaseIdentifier:
        payload = self._normalize_identifier_payload(data)
        value = payload.get("identifier_value")
        if not value:
            raise ValueError("Case identifiers require identifier_value")

        identifier = (
            session.query(CaseIdentifier)
            .filter_by(
                case_id=case_id,
                identifier_type=payload["identifier_type"],
                identifier_value=value,
                source_party=payload["source_party"],
            )
            .one_or_none()
        )
        if not identifier:
            identifier = CaseIdentifier(
                case_id=case_id,
                identifier_type=payload["identifier_type"],
                identifier_value=value,
                source_party=payload["source_party"],
            )
            session.add(identifier)

        identifier.source_type = payload["source_type"] or identifier.source_type
        identifier.source_uri = payload["source_uri"] or identifier.source_uri
        identifier.notes = payload["notes"] or identifier.notes
        if payload.get("metadata"):
            identifier.metadata_json = _json_dump(payload.get("metadata"))
        identifier.updated_at = utcnow()
        return identifier

    def _add_document_version(
        self,
        session,
        document: CaseDocument,
        text: str,
        extraction_method: str,
        version_label: str = "initial",
    ) -> None:
        session.add(DocumentVersion(
            document_id=document.id,
            version_label=version_label,
            extraction_method=extraction_method,
            text_hash=self._hash(text),
            extracted_text=text,
            metadata_json=document.metadata_json,
        ))

    def _create_evidence_link(
        self,
        session,
        case_id: int,
        document_id: int,
        target_type: str,
        target_id: int,
        snippet: str = "",
        relationship: str = "supports",
        strength: str = "medium",
        source_confidence: float = 0.0,
        user_confirmed: bool = False,
    ) -> EvidenceLink:
        if not document_id or not target_id:
            raise ValueError("Evidence links require document_id and target_id")
        document = session.get(CaseDocument, int(document_id))
        if not document or document.case_id != case_id:
            raise ValueError("Evidence document must belong to this case")
        if target_type == "claim":
            claim = session.get(LegalClaim, int(target_id))
            if not claim or claim.case_id != case_id:
                raise ValueError("Evidence claim must belong to this case")
        link = EvidenceLink(
            case_id=case_id,
            document_id=document_id,
            target_type=target_type,
            target_id=target_id,
            snippet=snippet,
            relationship=relationship,
            strength=strength,
            source_confidence=source_confidence,
            user_confirmed=user_confirmed,
        )
        session.add(link)
        session.flush()
        return link

    def _ensure_missing_evidence_reviews(self, session, case_id: int) -> None:
        documents = session.query(CaseDocument).filter_by(case_id=case_id).all()
        documents_count = len(documents)
        case_warning = session.query(MissingEvidenceWarning).filter_by(
            case_id=case_id,
            warning_type="case_without_documents",
        ).order_by(MissingEvidenceWarning.id.desc()).first()
        if documents_count == 0 and not case_warning:
            warning = MissingEvidenceWarning(
                case_id=case_id,
                warning_type="case_without_documents",
                title="No source documents linked",
                description="This case has no documents yet, so the timeline and claims cannot be verified from source material.",
                suggested_action="Import or link at least one email, letter, PDF, decision, or note before relying on the case summary.",
                severity="high",
            )
            session.add(warning)
            session.flush()
            self._audit(session, case_id, "MissingEvidenceWarning", warning.id, "created", "system", {}, self._serialize_missing_evidence(warning), "medium")
        elif documents_count > 0 and case_warning and case_warning.status != "resolved":
            before = self._serialize_missing_evidence(case_warning)
            case_warning.status = "resolved"
            case_warning.updated_at = utcnow()
            self._audit(session, case_id, "MissingEvidenceWarning", case_warning.id, "resolved", "system", before, self._serialize_missing_evidence(case_warning), "low")

        for document in documents:
            readable = bool(str(document.extracted_text or document.ocr_text or "").strip())
            warning = session.query(MissingEvidenceWarning).filter_by(
                case_id=case_id,
                document_id=document.id,
                warning_type="document_text_unavailable",
            ).order_by(MissingEvidenceWarning.id.desc()).first()
            if not readable and not warning:
                title = document.title or document.original_filename or f"Document {document.id}"
                item = MissingEvidenceWarning(
                    case_id=case_id,
                    document_id=document.id,
                    warning_type="document_text_unavailable",
                    title="Document text needs recovery",
                    description=f"{title} is linked to this case, but LARO could not extract readable text from the source.",
                    suggested_action="Open the original source, then paste recovered text or upload a text-readable copy. LARO will preserve the original source and store the recovered extraction as a new version.",
                    severity="high",
                )
                session.add(item)
                session.flush()
                self._audit(session, case_id, "MissingEvidenceWarning", item.id, "created", "system", {}, self._serialize_missing_evidence(item), "medium")
            elif readable and warning and warning.status != "resolved":
                before = self._serialize_missing_evidence(warning)
                warning.status = "resolved"
                warning.updated_at = utcnow()
                self._audit(session, case_id, "MissingEvidenceWarning", warning.id, "resolved", "system", before, self._serialize_missing_evidence(warning), "low")

        claims = session.query(LegalClaim).filter_by(case_id=case_id).all()
        for claim in claims:
            supported = session.query(EvidenceLink).filter_by(
                case_id=case_id,
                target_type="claim",
                target_id=claim.id,
                relationship="supports",
                user_confirmed=True,
            ).first()
            warning = session.query(MissingEvidenceWarning).filter_by(
                case_id=case_id,
                warning_type="unsupported_claim",
                claim_id=claim.id,
            ).order_by(MissingEvidenceWarning.id.desc()).first()
            if not supported and not warning:
                item = MissingEvidenceWarning(
                    case_id=case_id,
                    claim_id=claim.id,
                    warning_type="unsupported_claim",
                    title="Claim lacks source evidence",
                    description=claim.statement[:500],
                    suggested_action="Link a document snippet to this claim or mark the claim as an assumption/allegation.",
                    severity="medium",
                )
                session.add(item)
                session.flush()
                self._audit(session, case_id, "MissingEvidenceWarning", item.id, "created", "system", {}, self._serialize_missing_evidence(item), "medium")
            elif supported and warning and warning.status != "resolved":
                before = self._serialize_missing_evidence(warning)
                warning.status = "resolved"
                warning.updated_at = utcnow()
                self._audit(session, case_id, "MissingEvidenceWarning", warning.id, "resolved", "system", before, self._serialize_missing_evidence(warning), "low")

    def _audit(
        self,
        session,
        case_id: Optional[int],
        entity_type: str,
        entity_id: Optional[int],
        action: str,
        actor: str,
        before_state: Any,
        after_state: Any,
        risk_level: str = "low",
        approval_id: Optional[int] = None,
        source: str = "api",
        user_id: Optional[int] = None,
    ) -> None:
        resolved_user_id = user_id
        if resolved_user_id is None and case_id is not None:
            case = session.get(LegalCase, case_id)
            resolved_user_id = case.user_id if case else None
        session.add(AuditEvent(
            user_id=resolved_user_id,
            case_id=case_id,
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,
            actor=str(actor or "system"),
            source=source,
            before_state=_json_dump(before_state),
            after_state=_json_dump(after_state),
            risk_level=risk_level,
            approval_id=approval_id,
        ))

    @staticmethod
    def _hash(value: str) -> str:
        return hashlib.sha256((value or "").encode("utf-8")).hexdigest()

    @staticmethod
    def _token_fingerprint(token_response: Dict[str, Any]) -> str:
        token_values = [
            str(token_response.get(key) or "")
            for key in ("access_token", "refresh_token", "id_token")
            if token_response.get(key)
        ]
        if not token_values:
            return ""
        return hashlib.sha256("|".join(token_values).encode("utf-8")).hexdigest()

    @staticmethod
    def _safe_connection_metadata(token_response: Dict[str, Any], metadata: Dict[str, Any]) -> Dict[str, Any]:
        safe = dict(metadata or {})
        safe.update({
            "has_access_token": bool(token_response.get("access_token")),
            "has_refresh_token": bool(token_response.get("refresh_token")),
            "has_id_token": bool(token_response.get("id_token")),
        })
        for key in ("token_type", "expires_in", "scope"):
            if key in token_response:
                safe[key] = token_response.get(key)
        for secret_key in ("access_token", "refresh_token", "id_token", "client_secret", "authorization_code", "code"):
            safe.pop(secret_key, None)
        return safe

    @staticmethod
    def _parse_datetime(value: Any) -> Optional[_dt.datetime]:
        if isinstance(value, _dt.datetime):
            return value.replace(tzinfo=None) if value.tzinfo else value
        if not value:
            return None
        text = str(value).strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = _dt.datetime.fromisoformat(text)
        except ValueError:
            return None
        return parsed.replace(tzinfo=None) if parsed.tzinfo else parsed

    @staticmethod
    def _normalize_lawyer_response_type(value: Any) -> str:
        raw = str(value or "unclassified").strip().lower().replace("-", "_").replace(" ", "_")
        aliases = {
            "pre_assessment_positive": "interested",
            "positive": "interested",
            "accepted": "interested",
            "accept": "interested",
            "yes": "interested",
            "more_information_needed": "more_info",
            "more_information": "more_info",
            "needs_more_info": "more_info",
            "request_more_info": "more_info",
            "pre_assessment_negative": "unavailable",
            "negative": "unavailable",
            "declined": "rejected",
            "decline": "rejected",
            "reject": "rejected",
            "no_response": "no_response",
        }
        normalized = aliases.get(raw, raw)
        allowed = {"interested", "more_info", "unavailable", "rejected", "no_response", "unclassified"}
        return normalized if normalized in allowed else "unclassified"

    @staticmethod
    def _outreach_status_for_response(response_type: str) -> str:
        mapping = {
            "interested": "response_interested",
            "more_info": "response_more_info",
            "unavailable": "response_unavailable",
            "rejected": "response_rejected",
            "no_response": "no_response",
            "unclassified": "response_received",
        }
        return mapping.get(response_type, "response_received")

    @staticmethod
    def _title_from_description(data: Dict[str, Any]) -> str:
        description = data.get("description") or data.get("case_description") or "Untitled legal case"
        words = str(description).split()
        return " ".join(words[:10])[:255] or "Untitled legal case"

    def _case_detail(self, session, case: LegalCase) -> Dict[str, Any]:
        data = self._serialize_case(case)
        data["parties"] = [self._serialize_party(item) for item in session.query(Party).filter_by(case_id=case.id).all()]
        data["identifiers"] = [
            self._serialize_identifier(item)
            for item in session.query(CaseIdentifier)
            .filter_by(case_id=case.id)
            .order_by(CaseIdentifier.identifier_type.asc(), CaseIdentifier.identifier_value.asc(), CaseIdentifier.id.asc())
            .all()
        ]
        data["identifiers_count"] = len(data["identifiers"])
        data["documents_count"] = session.query(CaseDocument).filter_by(case_id=case.id).count()
        data["timeline_count"] = session.query(CaseEvent).filter_by(case_id=case.id).count()
        data["claims_count"] = session.query(LegalClaim).filter_by(case_id=case.id).count()
        data["contradictions_count"] = session.query(Contradiction).filter_by(case_id=case.id).count()
        data["missing_evidence_count"] = session.query(MissingEvidenceWarning).filter(
            MissingEvidenceWarning.case_id == case.id,
            MissingEvidenceWarning.status != "resolved",
        ).count()
        data["obligations_count"] = session.query(Obligation).filter(
            Obligation.case_id == case.id,
            Obligation.status.notin_(["resolved", "dismissed"]),
        ).count()
        data["open_loops_count"] = session.query(OpenLoop).filter_by(case_id=case.id, status="open").count()
        data["pending_approvals_count"] = session.query(Approval).filter_by(case_id=case.id, status="pending").count()
        data["case_analysis_review_count"] = session.query(CaseAnalysisReviewItem).filter_by(case_id=case.id, status="needs_review").count()
        return data

    def _serialize_user(self, user: LedgerUser) -> Dict[str, Any]:
        return {"id": user.id, "external_user_id": user.external_user_id, "email": user.email, "created_at": _iso(user.created_at)}

    def _serialize_external_connection(self, item: Optional[ExternalConnection]) -> Dict[str, Any]:
        if not item:
            return {}
        return {
            "id": item.id,
            "user_id": item.user_id,
            "provider": item.provider,
            "status": item.status,
            "connected": item.status == "connected",
            "connected_at": _iso(item.connected_at),
            "disconnected_at": _iso(item.disconnected_at),
            "scopes": _json_load(item.scopes_json, []),
            "token_fingerprint": item.token_fingerprint,
            "metadata": _json_load(item.metadata_json, {}),
            "created_at": _iso(item.created_at),
            "updated_at": _iso(item.updated_at),
        }

    def _serialize_case(self, case: LegalCase) -> Dict[str, Any]:
        return {
            "id": case.id,
            "case_id": case.id,
            "user_id": case.user_id,
            "title": case.title,
            "description": case.description,
            "legal_domain": case.legal_domain,
            "status": case.status,
            "priority": case.priority,
            "desired_outcome": case.desired_outcome,
            "current_summary": case.current_summary,
            "opposing_parties": _json_load(case.opposing_parties, []),
            "court_or_institution": case.court_or_institution,
            "risk_level": case.risk_level,
            "created_at": _iso(case.created_at),
            "updated_at": _iso(case.updated_at),
            "archived_at": _iso(case.archived_at),
        }

    def _serialize_party(self, party: Party) -> Dict[str, Any]:
        return {"id": party.id, "name": party.name, "party_type": party.party_type, "role": party.role, "contact": _json_load(party.contact, {}), "notes": party.notes}

    def _serialize_identifier(self, identifier: CaseIdentifier) -> Dict[str, Any]:
        return {
            "id": identifier.id,
            "case_identifier_id": identifier.id,
            "case_id": identifier.case_id,
            "identifier_type": identifier.identifier_type,
            "identifier_value": identifier.identifier_value,
            "value": identifier.identifier_value,
            "source_party": identifier.source_party,
            "source_type": identifier.source_type,
            "source_uri": identifier.source_uri,
            "notes": identifier.notes,
            "metadata": _json_load(identifier.metadata_json, {}),
            "created_at": _iso(identifier.created_at),
            "updated_at": _iso(identifier.updated_at),
        }

    def _serialize_document(self, document: CaseDocument) -> Dict[str, Any]:
        return {
            "id": document.id,
            "document_id": document.id,
            "case_id": document.case_id,
            "source_type": document.source_type,
            "source_uri": document.source_uri,
            "original_filename": document.original_filename,
            "local_path": document.local_path,
            "content_hash": document.content_hash,
            "document_type": document.document_type,
            "date_on_document": document.date_on_document,
            "sender": document.sender,
            "recipient": document.recipient,
            "title": document.title,
            "ocr_text": document.ocr_text,
            "extracted_text": document.extracted_text,
            "summary": document.summary,
            "relevance_score": document.relevance_score,
            "confidentiality_level": document.confidentiality_level,
            "metadata": _json_load(document.metadata_json, {}),
            "created_at": _iso(document.created_at),
            "updated_at": _iso(document.updated_at),
        }

    def _serialize_document_inbox_item(self, item: DocumentInboxItem) -> Dict[str, Any]:
        analysis = _json_load(item.analysis_json, {}) or {}
        processing = analysis.get("processing") or {}
        text = str(item.extracted_text or item.ocr_text or "")
        return {
            "id": item.id,
            "inbox_item_id": item.id,
            "source_type": item.source_type,
            "source_uri": item.source_uri,
            "original_filename": item.original_filename,
            "has_local_file": bool(item.local_path),
            "content_hash": item.content_hash,
            "document_type": item.document_type,
            "date_on_document": item.date_on_document,
            "sender": item.sender,
            "recipient": item.recipient,
            "title": item.title,
            "summary": item.summary,
            "text_preview": " ".join(text.split())[:360],
            "word_count": int(processing.get("word_count") or len(text.split())),
            "confidentiality_level": item.confidentiality_level,
            "analysis_topics": analysis.get("topics") or [],
            "suggested_matches": _json_load(item.suggested_matches_json, []),
            "suggested_case_id": item.suggested_case_id,
            "match_score": item.match_score,
            "status": item.status,
            "linked_case_id": item.linked_case_id,
            "linked_document_id": item.linked_document_id,
            "linked_at": _iso(item.linked_at),
            "created_at": _iso(item.created_at),
            "updated_at": _iso(item.updated_at),
        }

    def _document_creation_audit_state(self, document: CaseDocument) -> Dict[str, Any]:
        text = str(document.extracted_text or document.ocr_text or "")
        return {
            "document_id": document.id,
            "case_id": document.case_id,
            "source_type": document.source_type,
            "source_uri": document.source_uri,
            "original_filename": document.original_filename,
            "content_hash": document.content_hash,
            "document_type": document.document_type,
            "has_local_file": bool(document.local_path),
            "has_extracted_text": bool(text.strip()),
            "extracted_word_count": len(text.split()),
            "extracted_text_hash": self._hash(text) if text else "",
            "confidentiality_level": document.confidentiality_level,
        }

    def _document_inbox_audit_state(self, item: DocumentInboxItem) -> Dict[str, Any]:
        text = str(item.extracted_text or item.ocr_text or "")
        matches = _json_load(item.suggested_matches_json, []) or []
        return {
            "inbox_item_id": item.id,
            "source_type": item.source_type,
            "source_uri": item.source_uri,
            "original_filename": item.original_filename,
            "content_hash": item.content_hash,
            "document_type": item.document_type,
            "has_local_file": bool(item.local_path),
            "has_extracted_text": bool(text.strip()),
            "extracted_word_count": len(text.split()),
            "extracted_text_hash": self._hash(text) if text else "",
            "suggested_case_ids": [match.get("case_id") for match in matches if isinstance(match, dict)],
            "suggested_case_id": item.suggested_case_id,
            "match_score": item.match_score,
            "status": item.status,
            "linked_case_id": item.linked_case_id,
            "linked_document_id": item.linked_document_id,
        }

    def _document_extraction_audit_state(
        self,
        document: CaseDocument,
        *,
        version_number: Optional[int] = None,
        extraction_method: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Keep audit provenance useful without copying sensitive recovered text into the audit trail."""
        text = str(document.extracted_text or document.ocr_text or "")
        state = {
            "document_id": document.id,
            "source_uri": document.source_uri,
            "content_hash": document.content_hash,
            "has_extracted_text": bool(text.strip()),
            "extracted_word_count": len(text.split()),
            "extracted_text_hash": self._hash(text) if text else "",
        }
        if version_number is not None:
            state["extraction_version"] = version_number
        if extraction_method:
            state["extraction_method"] = extraction_method
        return state

    def _document_analysis_audit_state(self, document: CaseDocument) -> Dict[str, Any]:
        """Keep analysis refresh audits useful without copying source-derived content."""
        metadata = _json_load(document.metadata_json, {})
        analysis = metadata.get("legal_analysis") or {}
        processing = analysis.get("processing") or {}
        return {
            "document_id": document.id,
            "content_hash": document.content_hash,
            "summary_hash": self._hash(document.summary or ""),
            "relevance_score": document.relevance_score,
            "analysis_hash": self._hash(_json_dump(analysis)) if analysis else "",
            "analysis_method": processing.get("analysis_method") or "",
            "has_source_passages": bool((analysis.get("findings") or {}).get("source_passages")),
        }

    def _case_analysis_audit_state(self, item: CaseAnalysisRun) -> Dict[str, Any]:
        content = _json_load(item.content_json, {})
        sources = _json_load(item.source_snapshot_json, [])
        return {
            "analysis_run_id": item.id,
            "analysis_type": item.analysis_type,
            "status": item.status,
            "provider": item.provider,
            "model": item.model,
            "source_document_ids": [source.get("document_id") for source in sources if isinstance(source, dict)],
            "findings_count": len(content.get("findings") or []),
            "review_questions_count": len(content.get("review_questions") or []),
            "content_hash": self._hash(_json_dump(content)),
        }

    def _case_analysis_job_audit_state(self, item: CaseAnalysisJob) -> Dict[str, Any]:
        return {
            "job_id": item.id,
            "run_id": item.run_id,
            "status": item.status,
            "provider": item.provider,
            "model": item.model,
            "total_documents": item.total_documents,
            "completed_documents": item.completed_documents,
            "total_chunks": item.total_chunks,
            "completed_chunks": item.completed_chunks,
            "total_words": item.total_words,
            "processed_words": item.processed_words,
            "total_characters": item.total_characters,
            "processed_characters": item.processed_characters,
            "error_hash": self._hash(item.error or "") if item.error else "",
            "result_hash": self._hash(item.result_json or "{}"),
        }

    @staticmethod
    def _serialize_document_version(item: DocumentVersion) -> Dict[str, Any]:
        return {
            "id": item.id,
            "document_id": item.document_id,
            "version_label": item.version_label,
            "extraction_method": item.extraction_method,
            "text_hash": item.text_hash,
            "extracted_text": item.extracted_text,
            "metadata": _json_load(item.metadata_json, {}),
            "created_at": _iso(item.created_at),
        }

    def _ensure_case_analysis_review_items(
        self,
        session,
        case_id: int,
        analysis_run: Optional[CaseAnalysisRun] = None,
    ) -> None:
        """Materialize cited analysis into review work without creating legal facts."""
        runs = [analysis_run] if analysis_run else session.query(CaseAnalysisRun).filter_by(case_id=case_id).all()
        documents = {
            item.id: item
            for item in session.query(CaseDocument).filter_by(case_id=case_id).all()
        }
        for run in runs:
            if not run:
                continue
            content = _json_load(run.content_json, {})
            candidates = []
            candidates.extend(("finding", index, item) for index, item in enumerate(content.get("findings") or []) if isinstance(item, dict))
            candidates.extend(("review_question", index, item) for index, item in enumerate(content.get("review_questions") or []) if isinstance(item, dict))
            candidates.extend(("timeline_suggestion", index, item) for index, item in enumerate(content.get("timeline_suggestions") or []) if isinstance(item, dict))
            existing_keys = {
                item.finding_key
                for item in session.query(CaseAnalysisReviewItem.finding_key)
                .filter_by(case_id=case_id, analysis_run_id=run.id)
                .all()
            }
            for item_type, index, candidate in candidates:
                finding_key = f"{item_type}:{index}"
                if finding_key in existing_keys:
                    continue
                event_date = ""
                if item_type == "timeline_suggestion":
                    try:
                        event_date = _dt.date.fromisoformat(str(candidate.get("event_date") or "")).isoformat()
                    except ValueError:
                        continue
                validated_sources = []
                seen_sources = set()
                for source in candidate.get("sources") or []:
                    if not isinstance(source, dict):
                        continue
                    try:
                        document_id = int(source.get("document_id"))
                    except (TypeError, ValueError):
                        continue
                    quote = str(source.get("source_quote") or "").strip()
                    document = documents.get(document_id)
                    source_text = str((document.extracted_text or document.ocr_text or "") if document else "")
                    if not self._source_contains_quote(source_text, quote):
                        continue
                    source_key = (document_id, quote)
                    if source_key in seen_sources:
                        continue
                    seen_sources.add(source_key)
                    source_payload = {"document_id": document_id, "source_quote": quote}
                    if event_date:
                        source_payload["event_date"] = event_date
                        for field, limit in {
                            "actor": 255,
                            "action": 120,
                            "affected_party": 255,
                            "event_kind": 80,
                        }.items():
                            value = str(candidate.get(field) or "").strip()
                            source_identity = " ".join((quote, document.sender or "", document.recipient or "")).lower()
                            if field in {"actor", "affected_party"} and value.lower() not in source_identity:
                                continue
                            if field == "action" and value not in {
                                "sent", "received", "wrote", "stated", "requested", "demanded",
                                "confirmed", "explained", "decided", "rejected", "approved", "filed",
                                "paid", "issued invoice", "set deadline", "created obligation", "documented",
                            }:
                                continue
                            if field == "event_kind" and value not in {
                                "event", "communication", "decision", "filing", "financial",
                                "obligation", "deadline", "hearing",
                            }:
                                continue
                            if value:
                                source_payload[field] = value[:limit]
                    validated_sources.append(source_payload)
                if not validated_sources:
                    continue
                description = str(
                    candidate.get("description")
                    if item_type == "timeline_suggestion"
                    else candidate.get("observation") or candidate.get("question") or ""
                ).strip()
                if not description:
                    continue
                category = str(candidate.get("category") or "case-wide observation").replace("_", " ").strip()
                title = (
                    str(candidate.get("title") or "Case-wide timeline proposal")[:255]
                    if item_type == "timeline_suggestion"
                    else f"Verify: {description[:180]}"
                    if item_type == "review_question"
                    else f"Review {category}: {description[:160]}"
                )
                review_item = CaseAnalysisReviewItem(
                    case_id=case_id,
                    analysis_run_id=run.id,
                    finding_key=finding_key,
                    item_type=item_type,
                    title=title[:255],
                    description=description,
                    source_refs=_json_dump(validated_sources),
                    status="needs_review",
                )
                session.add(review_item)
                session.flush()
                self._audit(
                    session, case_id, "CaseAnalysisReviewItem", review_item.id, "created", "system",
                    {}, self._case_analysis_review_item_audit_state(review_item), "low",
                )

    def _sync_case_analysis_coverage_warning(
        self,
        session,
        case_id: int,
        analysis_run: CaseAnalysisRun,
    ) -> None:
        """Keep partial analysis coverage visible in the operational review queue."""
        content = _json_load(analysis_run.content_json, {})
        coverage = content.get("source_coverage") or {}
        if not isinstance(coverage, dict) or not coverage:
            return

        def count(value: Any, fallback: int = 0) -> int:
            try:
                return max(0, int(value))
            except (TypeError, ValueError):
                return fallback

        sources = [
            source for source in _json_load(analysis_run.source_snapshot_json, [])
            if isinstance(source, dict)
        ]
        readable = count(coverage.get("sources_readable"), len(sources))
        represented = count(
            coverage.get("sources_represented"),
            len([source for source in sources if count(source.get("source_characters_analyzed")) > 0]),
        )
        fully_read = count(
            coverage.get("sources_fully_read"),
            len([source for source in sources if not source.get("source_was_truncated")]),
        )
        partially_read = count(
            coverage.get("sources_partially_read"),
            max(0, represented - fully_read),
        )
        partial_sources = [source for source in sources if source.get("source_was_truncated")]
        is_partial = bool(
            content.get("source_was_truncated")
            or partially_read
            or (readable and represented < readable)
            or partial_sources
        )
        open_warnings = [
            warning
            for warning in session.query(MissingEvidenceWarning)
            .filter_by(case_id=case_id, warning_type="analysis_partial_coverage")
            .order_by(MissingEvidenceWarning.id.desc())
            .all()
            if warning.status not in {"resolved", "dismissed"}
        ]

        if not is_partial:
            for warning in open_warnings:
                before = self._serialize_missing_evidence(warning)
                warning.status = "resolved"
                warning.updated_at = utcnow()
                self._audit(
                    session, case_id, "MissingEvidenceWarning", warning.id, "resolved", "system",
                    before, self._serialize_missing_evidence(warning), "low",
                )
            return

        source_titles = [str(source.get("title") or "Source document") for source in partial_sources[:3]]
        omitted_sources = max(0, readable - represented)
        description_parts = [
            f"The latest case-wide reading represented {represented} of {readable} readable sources",
            f"fully read {fully_read}",
        ]
        if partially_read:
            description_parts.append(f"sampled {partially_read} long source{'s' if partially_read != 1 else ''}")
        if omitted_sources:
            description_parts.append(f"did not represent {omitted_sources} readable source{'s' if omitted_sources != 1 else ''}")
        description = "; ".join(description_parts) + "."
        if source_titles:
            description += f" Partial source{'s' if len(source_titles) != 1 else ''}: {', '.join(source_titles)}."
        suggested_action = (
            "Open the partial source with the ? control and review omitted passages before relying on the synthesis. "
            "Rerun case analysis after shortening, splitting, or recovering the source when full coverage is required."
        )
        document_id = None
        if partial_sources:
            try:
                document_id = int(partial_sources[0].get("document_id"))
            except (TypeError, ValueError):
                document_id = None
        severity = "high" if omitted_sources else "medium"

        warning = open_warnings[0] if open_warnings else None
        if not warning:
            warning = MissingEvidenceWarning(
                case_id=case_id,
                document_id=document_id,
                warning_type="analysis_partial_coverage",
                title="Case analysis used partial source coverage",
                description=description,
                suggested_action=suggested_action,
                status="needs_review",
                severity=severity,
            )
            session.add(warning)
            session.flush()
            self._audit(
                session, case_id, "MissingEvidenceWarning", warning.id, "created", "system",
                {}, self._serialize_missing_evidence(warning), "medium",
            )
            return

        before = self._serialize_missing_evidence(warning)
        warning.document_id = document_id
        warning.title = "Case analysis used partial source coverage"
        warning.description = description
        warning.suggested_action = suggested_action
        warning.status = "needs_review"
        warning.severity = severity
        warning.updated_at = utcnow()
        after = self._serialize_missing_evidence(warning)
        if before != after:
            self._audit(
                session, case_id, "MissingEvidenceWarning", warning.id, "updated", "system",
                before, after, "medium",
            )

    @staticmethod
    def _source_contains_quote(source_text: str, quote: str) -> bool:
        normalized_source = " ".join(str(source_text or "").split())
        normalized_quote = " ".join(str(quote or "").split())
        return bool(normalized_quote and normalized_quote in normalized_source)

    def _case_analysis_review_items_for_run(self, session, analysis_run_id: int) -> List[Dict[str, Any]]:
        return [
            self._serialize_case_analysis_review_item(item)
            for item in session.query(CaseAnalysisReviewItem)
            .filter_by(analysis_run_id=analysis_run_id)
            .order_by(CaseAnalysisReviewItem.id.asc())
            .all()
        ]

    def _case_analysis_review_item_audit_state(self, item: CaseAnalysisReviewItem) -> Dict[str, Any]:
        sources = _json_load(item.source_refs, [])
        return {
            "review_item_id": item.id,
            "analysis_run_id": item.analysis_run_id,
            "finding_key": item.finding_key,
            "item_type": item.item_type,
            "status": item.status,
            "target_type": item.target_type,
            "target_id": item.target_id,
            "source_document_ids": [source.get("document_id") for source in sources if isinstance(source, dict)],
            "description_hash": self._hash(item.description or ""),
            "source_refs_hash": self._hash(_json_dump(sources)),
        }

    def _serialize_case_analysis_run(
        self,
        item: CaseAnalysisRun,
        review_items: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        return {
            "id": item.id,
            "case_id": item.case_id,
            "analysis_type": item.analysis_type,
            "status": item.status,
            "provider": item.provider,
            "model": item.model,
            "content": _json_load(item.content_json, {}),
            "source_documents": _json_load(item.source_snapshot_json, []),
            "review_items": review_items if review_items is not None else [],
            "created_at": _iso(item.created_at),
            "updated_at": _iso(item.updated_at),
        }

    @staticmethod
    def _serialize_case_analysis_job(item: CaseAnalysisJob) -> Dict[str, Any]:
        elapsed_seconds = max(0, int(((item.completed_at or utcnow()) - (item.started_at or item.created_at)).total_seconds()))
        total_units = item.total_characters or item.total_chunks or item.total_documents
        completed_units = item.processed_characters or item.completed_chunks or item.completed_documents
        if item.status == "completed":
            progress_percent = 100
            remaining_seconds = 0
        elif item.status == "failed":
            progress_percent = max(0, min(99, int(5 + (90 * completed_units / total_units))) if total_units else 5)
            remaining_seconds = None
        elif item.status == "running":
            progress_percent = max(5, min(96, int(5 + (90 * completed_units / total_units)))) if total_units else 5
            if completed_units and elapsed_seconds and total_units > completed_units:
                remaining_seconds = max(1, int((elapsed_seconds / completed_units) * (total_units - completed_units)))
            elif item.estimated_total_seconds:
                remaining_seconds = max(1, item.estimated_total_seconds - elapsed_seconds)
            else:
                remaining_seconds = None
        else:
            progress_percent = 0
            remaining_seconds = item.estimated_total_seconds or None
        return {
            "job_id": item.id,
            "case_id": item.case_id,
            "run_id": item.run_id,
            "provider": item.provider,
            "model": item.model,
            "status": item.status,
            "stage": item.stage,
            "current_item": item.current_item,
            "total_documents": item.total_documents,
            "completed_documents": item.completed_documents,
            "total_chunks": item.total_chunks,
            "completed_chunks": item.completed_chunks,
            "total_words": item.total_words,
            "processed_words": item.processed_words,
            "total_characters": item.total_characters,
            "processed_characters": item.processed_characters,
            "estimated_total_seconds": item.estimated_total_seconds,
            "estimated_remaining_seconds": remaining_seconds,
            "elapsed_seconds": elapsed_seconds,
            "progress_percent": progress_percent,
            "error": item.error,
            "result": _json_load(item.result_json, {}),
            "started_at": _iso(item.started_at),
            "completed_at": _iso(item.completed_at),
            "created_at": _iso(item.created_at),
            "updated_at": _iso(item.updated_at),
        }

    @staticmethod
    def _serialize_case_analysis_review_item(item: CaseAnalysisReviewItem) -> Dict[str, Any]:
        return {
            "id": item.id,
            "case_id": item.case_id,
            "analysis_run_id": item.analysis_run_id,
            "finding_key": item.finding_key,
            "item_type": item.item_type,
            "title": item.title,
            "description": item.description,
            "source_refs": _json_load(item.source_refs, []),
            "status": item.status,
            "target_type": item.target_type,
            "target_id": item.target_id,
            "created_at": _iso(item.created_at),
            "updated_at": _iso(item.updated_at),
        }

    def _serialize_event(self, event: CaseEvent) -> Dict[str, Any]:
        review_status = "rejected" if event.event_type == "rejected_suggestion" else "confirmed" if event.user_confirmed else "needs_review"
        return {
            "id": event.id,
            "timeline_id": event.id,
            "case_id": event.case_id,
            "event_date": event.event_date,
            "date": event.event_date,
            "event_type": event.event_type,
            "event_kind": event.event_kind,
            "title": event.title,
            "description": event.description,
            "summary": event.description,
            "actor": event.actor,
            "action": event.action,
            "affected_party": event.affected_party,
            "source_confidence": event.source_confidence,
            "user_confirmed": event.user_confirmed,
            "review_status": review_status,
            "is_suggestion": not event.user_confirmed and event.event_type != "rejected_suggestion",
            "created_from_document_id": event.created_from_document_id,
            "created_at": _iso(event.created_at),
            "updated_at": _iso(event.updated_at),
        }

    def _serialize_claim(self, claim: LegalClaim) -> Dict[str, Any]:
        return {
            "id": claim.id,
            "case_id": claim.case_id,
            "asserted_by": claim.asserted_by,
            "position_role": claim.position_role,
            "subject_party": claim.subject_party,
            "claim_type": claim.claim_type,
            "materiality": claim.materiality,
            "statement": claim.statement,
            "status": claim.status,
            "confidence": claim.confidence,
            "created_at": _iso(claim.created_at),
            "updated_at": _iso(claim.updated_at),
        }

    def _serialize_evidence_link(self, link: EvidenceLink) -> Dict[str, Any]:
        return {"id": link.id, "case_id": link.case_id, "document_id": link.document_id, "target_type": link.target_type, "target_id": link.target_id, "snippet": link.snippet, "relationship": link.relationship, "strength": link.strength, "source_confidence": link.source_confidence, "user_confirmed": link.user_confirmed, "created_at": _iso(link.created_at)}

    def _serialize_contradiction(self, item: Contradiction) -> Dict[str, Any]:
        return {"id": item.id, "case_id": item.case_id, "contradiction_type": item.contradiction_type, "title": item.title, "description": item.description, "status": item.status, "severity": item.severity, "source_refs": _json_load(item.source_refs, []), "created_at": _iso(item.created_at), "updated_at": _iso(item.updated_at)}

    def _serialize_missing_evidence(self, item: MissingEvidenceWarning) -> Dict[str, Any]:
        return {"id": item.id, "case_id": item.case_id, "claim_id": item.claim_id, "document_id": item.document_id, "warning_type": item.warning_type, "title": item.title, "description": item.description, "suggested_action": item.suggested_action, "status": item.status, "severity": item.severity, "created_at": _iso(item.created_at), "updated_at": _iso(item.updated_at)}

    def _serialize_deadline(self, item: Deadline) -> Dict[str, Any]:
        return {"id": item.id, "case_id": item.case_id, "due_date": item.due_date, "title": item.title, "description": item.description, "deadline_type": item.deadline_type, "status": item.status, "source_document_id": item.source_document_id, "requires_approval": item.requires_approval, "created_at": _iso(item.created_at), "updated_at": _iso(item.updated_at)}

    def _serialize_obligation(self, item: Obligation) -> Dict[str, Any]:
        return {
            "id": item.id,
            "case_id": item.case_id,
            "title": item.title,
            "description": item.description,
            "responsible_party": item.responsible_party,
            "beneficiary_party": item.beneficiary_party,
            "obligation_type": item.obligation_type,
            "due_date": item.due_date,
            "status": item.status,
            "risk_level": item.risk_level,
            "source_document_id": item.source_document_id,
            "source_quote": item.source_quote,
            "source_confidence": item.source_confidence,
            "user_confirmed": item.user_confirmed,
            "created_at": _iso(item.created_at),
            "updated_at": _iso(item.updated_at),
        }

    def _serialize_open_loop(self, item: OpenLoop) -> Dict[str, Any]:
        return {"id": item.id, "case_id": item.case_id, "title": item.title, "description": item.description, "owner": item.owner, "status": item.status, "next_action": item.next_action, "risk_level": item.risk_level, "created_at": _iso(item.created_at), "updated_at": _iso(item.updated_at)}

    def _serialize_outreach(self, item: LawyerOutreach) -> Dict[str, Any]:
        return {"id": item.id, "case_id": item.case_id, "lawyer_name": item.lawyer_name, "lawyer_email": item.lawyer_email, "legal_field": item.legal_field, "subject": item.subject, "draft_body": item.draft_body, "status": item.status, "approval_id": item.approval_id, "sent_at": _iso(item.sent_at), "follow_up_count": item.follow_up_count, "created_at": _iso(item.created_at)}

    def _serialize_draft(self, item: Draft) -> Dict[str, Any]:
        return {
            "id": item.id,
            "case_id": item.case_id,
            "draft_type": item.draft_type,
            "title": item.title,
            "body": item.body,
            "status": item.status,
            "risk_level": item.risk_level,
            "approval_id": item.approval_id,
            "created_at": _iso(item.created_at),
            "updated_at": _iso(item.updated_at),
        }

    def _serialize_lawyer_response(self, item: LawyerResponse, outreach: Optional[LawyerOutreach] = None) -> Dict[str, Any]:
        payload = {
            "id": item.id,
            "response_id": item.id,
            "outreach_id": item.outreach_id,
            "response_type": item.response_type,
            "status": item.response_type,
            "content": item.content,
            "received_at": _iso(item.received_at),
            "timestamp": _iso(item.received_at),
            "created_at": _iso(item.created_at),
        }
        if outreach:
            payload.update({
                "case_id": outreach.case_id,
                "lawyer_name": outreach.lawyer_name,
                "lawyer_email": outreach.lawyer_email,
                "lawyer_id": outreach.lawyer_email or outreach.id,
                "target_type": "lawyers",
            })
        return payload

    def _serialize_match_result(self, item: Optional[MatchResult]) -> Dict[str, Any]:
        if not item:
            return {}
        return {
            "id": item.id,
            "case_id": item.case_id,
            "match_type": item.match_type,
            "source": item.source,
            "criteria": _json_load(item.criteria_json, {}),
            "payload": _json_load(item.payload_json, {}),
            "created_at": _iso(item.created_at),
            "updated_at": _iso(item.updated_at),
        }

    @staticmethod
    def _normalize_outreach_target_type(value: Any) -> str:
        raw = str(value or "organization").strip().lower()
        aliases = {"org": "organization", "organisations": "organization", "organizations": "organization"}
        normalized = aliases.get(raw, raw)
        if normalized not in {"media", "organization"}:
            raise ValueError("target_type must be media or organization")
        return normalized

    @staticmethod
    def _normalize_outreach_list(value: Any) -> List[str]:
        if value is None:
            return []
        values = value if isinstance(value, list) else [value]
        seen = set()
        result = []
        for item in values:
            text = str(item or "").strip()
            key = text.lower()
            if text and key not in seen:
                seen.add(key)
                result.append(text)
        return result

    def _normalize_outreach_directory_record(self, raw_record: Any) -> Dict[str, Any]:
        record = dict(raw_record or {})
        source_url = str(record.get("source_url") or record.get("url") or "").strip()
        parsed = urlparse(source_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("source_url must be an http(s) URL")
        retrieved_at = self._parse_datetime(record.get("source_retrieved_at") or record.get("retrieved_at"))
        return {
            "target_type": self._normalize_outreach_target_type(record.get("target_type") or record.get("category")),
            "name": str(record.get("name") or "").strip(),
            "subtype": str(record.get("subtype") or "").strip(),
            "parent_org": str(record.get("parent_org") or "").strip(),
            "description": str(record.get("description") or "").strip(),
            "topics": self._normalize_outreach_list(record.get("topics")),
            "legal_fields": self._normalize_outreach_list(record.get("legal_fields")),
            "audience": self._normalize_outreach_list(record.get("audience")),
            "channels": self._normalize_outreach_list(record.get("channels")),
            "region": str(record.get("region") or "Netherlands").strip() or "Netherlands",
            "url": str(record.get("url") or source_url).strip(),
            "contact_url": str(record.get("contact_url") or record.get("url") or source_url).strip(),
            "source_url": source_url,
            "source_label": str(record.get("source_label") or record.get("source_name") or "").strip(),
            "source_retrieved_at": retrieved_at,
            "confidence": str(record.get("confidence") or "unknown").strip().lower() or "unknown",
            "metadata": record.get("metadata") if isinstance(record.get("metadata"), dict) else {},
        }

    @staticmethod
    def _serialize_outreach_directory_target(item: Optional[OutreachDirectoryTarget]) -> Dict[str, Any]:
        if not item:
            return {}
        return {
            "id": item.id,
            "target_id": str(item.id),
            "target_type": item.target_type,
            "name": item.name,
            "subtype": item.subtype,
            "parent_org": item.parent_org,
            "description": item.description,
            "topics": _json_load(item.topics_json, []),
            "legal_fields": _json_load(item.legal_fields_json, []),
            "audience": _json_load(item.audience_json, []),
            "channels": _json_load(item.channels_json, []),
            "region": item.region,
            "url": item.url,
            "contact_url": item.contact_url,
            "source_url": item.source_url,
            "source_label": item.source_label,
            "source_retrieved_at": _iso(item.source_retrieved_at),
            "confidence": item.confidence,
            "status": item.status,
            "metadata": _json_load(item.metadata_json, {}),
            "created_at": _iso(item.created_at),
            "updated_at": _iso(item.updated_at),
        }

    def _serialize_approval(self, item: Approval) -> Dict[str, Any]:
        return {"id": item.id, "case_id": item.case_id, "entity_type": item.entity_type, "entity_id": item.entity_id, "action": item.action, "risk_level": item.risk_level, "status": item.status, "requested_by": item.requested_by, "resolved_by": item.resolved_by, "reason": item.reason, "context": _json_load(item.context_json, {}), "created_at": _iso(item.created_at), "resolved_at": _iso(item.resolved_at)}

    def _serialize_audit(self, item: AuditEvent) -> Dict[str, Any]:
        return {"id": item.id, "case_id": item.case_id, "entity_type": item.entity_type, "entity_id": item.entity_id, "action": item.action, "actor": item.actor, "source": item.source, "before_state": _json_load(item.before_state, {}), "after_state": _json_load(item.after_state, {}), "risk_level": item.risk_level, "approval_id": item.approval_id, "created_at": _iso(item.created_at)}

    @staticmethod
    def _serialize_evidence_import_job(item: EvidenceImportJob) -> Dict[str, Any]:
        elapsed_seconds = max(0, int(((item.completed_at or utcnow()) - (item.started_at or item.created_at)).total_seconds()))
        if item.status == "completed":
            progress_percent = 100
            remaining_seconds = 0
        elif item.status == "failed":
            progress_percent = max(0, min(99, int(10 + (80 * item.completed_items / item.total_items))) if item.total_items else 8)
            remaining_seconds = None
        elif item.total_items:
            progress_percent = max(10, min(95, int(10 + (85 * item.completed_items / item.total_items))))
            if item.completed_items and elapsed_seconds:
                remaining_seconds = max(1, int((elapsed_seconds / item.completed_items) * max(0, item.total_items - item.completed_items)))
            else:
                remaining_seconds = max(1, int(item.estimated_total_seconds or item.total_items * 3))
        elif item.status == "running":
            progress_percent = 6
            remaining_seconds = None
        else:
            progress_percent = 0
            remaining_seconds = None
        return {
            "job_id": item.id,
            "case_id": item.case_id,
            "provider": item.provider,
            "source": item.source,
            "status": item.status,
            "stage": item.stage,
            "current_item": item.current_item,
            "total_items": item.total_items,
            "completed_items": item.completed_items,
            "total_words": item.total_words,
            "processed_words": item.processed_words,
            "imported_count": item.imported_count,
            "skipped_count": item.skipped_count,
            "estimated_total_seconds": item.estimated_total_seconds,
            "estimated_remaining_seconds": remaining_seconds,
            "elapsed_seconds": elapsed_seconds,
            "progress_percent": progress_percent,
            "error": item.error,
            "result": _json_load(item.result_json, {}),
            "started_at": _iso(item.started_at),
            "completed_at": _iso(item.completed_at),
            "created_at": _iso(item.created_at),
            "updated_at": _iso(item.updated_at),
        }

    @staticmethod
    def _risk_level_for_draft(draft_type: str) -> str:
        if draft_type in {"formal_letter", "external_email", "court_filing", "government_submission", "lawyer_outreach", "case_bundle_export"}:
            return "high"
        if draft_type in {"lawyer_summary", "red_line", "case_summary"}:
            return "medium"
        return "low"

    @staticmethod
    def _draft_requires_approval(draft_type: str, risk_level: str, data: Dict[str, Any]) -> bool:
        if data.get("requires_approval") is not None:
            return bool(data.get("requires_approval"))
        high_risk_types = {"formal_letter", "external_email", "court_filing", "government_submission", "lawyer_outreach", "case_bundle_export"}
        return draft_type in high_risk_types or risk_level in {"high", "critical"}

    @staticmethod
    def _approval_action_for_draft(draft_type: str) -> str:
        actions = {
            "formal_letter": "send_formal_legal_letter",
            "external_email": "send_external_legal_email",
            "court_filing": "submit_court_filing",
            "government_submission": "submit_government_communication",
            "lawyer_outreach": "send_external_legal_email",
            "case_bundle_export": "share_case_bundle_externally",
        }
        return actions.get(draft_type, "approve_generated_draft_external_use")

    @staticmethod
    def _default_draft_title(draft_type: str) -> str:
        return draft_type.replace("_", " ").strip().title() or "Generated draft"


def default_database_url(app_root: Optional[str] = None) -> str:
    configured = os.environ.get("LARO_LEDGER_DATABASE_URL")
    if configured:
        return configured
    root = app_root or os.getcwd()
    return "sqlite:///" + os.path.join(root, "instance", "laro_ledger.sqlite3")


def init_legal_ledger(app) -> LegalLedger:
    database_url = app.config.get("LARO_LEDGER_DATABASE_URL") or default_database_url(app.root_path)
    ledger = LegalLedger(database_url)
    ledger.create_all()
    ledger.fail_interrupted_case_analysis_jobs()
    app.config["legal_ledger"] = ledger

    @app.teardown_appcontext
    def close_legal_ledger_session(exception=None):
        active_ledger = app.config.get("legal_ledger") or ledger
        active_ledger.Session.remove()

    return ledger


def get_legal_ledger(app=None) -> LegalLedger:
    if app is not None:
        return app.config["legal_ledger"]
    from flask import current_app

    return current_app.config["legal_ledger"]
