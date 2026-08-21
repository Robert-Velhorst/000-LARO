import io
import gc
import json
import os
import sqlite3
import tempfile
import unittest
import datetime as dt
import zipfile
from unittest import mock

from legal_ledger import LegalLedger, LawyerOutreach
from local_semantic_analysis import LocalSemanticAnalysisProvider


class TestLegalLedgerService(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_url = "sqlite:///" + os.path.join(self.tmp.name, "ledger.sqlite3")
        self.ledger = LegalLedger(self.db_url)
        self.ledger.create_all()

    def tearDown(self):
        self.ledger.close()
        self.tmp.cleanup()

    def test_persists_case_documents_timeline_evidence_and_papertrail(self):
        case = self.ledger.create_case({
            "user_id": "robert",
            "title": "Vivare repair delay",
            "description": "Housing repair dispute",
            "legal_domain": "tenancy_law",
            "desired_outcome": "Repair and compensation",
            "parties": [{"name": "Vivare", "role": "housing provider"}],
        }, actor="robert")
        self.assertEqual(case["parties"][0]["name"], "Vivare")
        self.assertEqual(case["parties"][0]["role"], "housing provider")

        document = self.ledger.add_document(case["case_id"], {
            "source_type": "manual",
            "original_filename": "notice.txt",
            "title": "Repair notice",
            "document_type": "notice",
            "date_on_document": "2024-03-10",
            "sender": "Robert",
            "recipient": "Vivare",
            "extracted_text": "On 2024-03-10 Vivare received notice. Repair deadline 2024-03-24.",
            "summary": "Repair notice and deadline.",
            "relevance_score": 0.91,
            "confidentiality_level": "sensitive",
        }, actor="robert")
        fetched_document = self.ledger.get_document(case["case_id"], document["document_id"])
        self.assertEqual(fetched_document["title"], "Repair notice")

        event = self.ledger.add_event(case["case_id"], {
            "event_date": "2024-03-10",
            "title": "Vivare received notice",
            "description": "Notice sent and received.",
            "actor": "Robert",
            "event_action": "sent",
            "affected_party": "Vivare",
            "event_kind": "communication",
            "created_from_document_id": document["document_id"],
            "source_confidence": 0.91,
        }, actor="robert")

        claim = self.ledger.add_claim(case["case_id"], {
            "statement": "Vivare was notified about the repair issue.",
            "asserted_by": "Robert",
        }, actor="robert")

        link = self.ledger.add_evidence_link(case["case_id"], {
            "document_id": document["document_id"],
            "target_type": "claim",
            "target_id": claim["id"],
            "snippet": "Vivare received notice",
            "relationship": "supports",
            "user_confirmed": True,
        }, actor="robert")

        contradiction = self.ledger.add_contradiction(case["case_id"], {
            "title": "Notice date conflict",
            "description": "One source says March 10, another says March 11.",
            "source_refs": [{"document_id": document["document_id"]}],
        }, actor="system")

        deadline = self.ledger.add_deadline(case["case_id"], {
            "due_date": "2024-03-24",
            "title": "Repair deadline",
            "source_document_id": document["document_id"],
        }, actor="system")

        open_loop = self.ledger.add_open_loop(case["case_id"], {
            "title": "Confirm repair status",
            "next_action": "Ask Robert whether repair happened.",
        }, actor="system")

        graph = self.ledger.papertrail_graph(case["case_id"])
        command_center = self.ledger.command_center("robert")

        self.assertEqual(len(self.ledger.list_cases("robert")), 1)
        self.assertEqual(len(self.ledger.list_documents(case["case_id"])), 1)
        timeline = self.ledger.list_timeline(case["case_id"])
        self.assertEqual(len(timeline), 1)
        self.assertEqual(timeline[0]["actor"], "Robert")
        self.assertEqual(timeline[0]["action"], "sent")
        self.assertEqual(timeline[0]["affected_party"], "Vivare")
        self.assertEqual(timeline[0]["event_kind"], "communication")
        self.assertEqual(link["relationship"], "supports")
        self.assertEqual(contradiction["status"], "needs_review")
        self.assertEqual(deadline["requires_approval"], True)
        self.assertEqual(open_loop["status"], "open")
        confirmed_deadline = self.ledger.update_deadline(case["case_id"], deadline["id"], {"action": "confirm"}, actor="robert")
        self.assertEqual(confirmed_deadline["status"], "confirmed")
        self.assertFalse(confirmed_deadline["requires_approval"])
        resolved_loop = self.ledger.update_open_loop(case["case_id"], open_loop["id"], {"action": "resolve"}, actor="robert")
        self.assertEqual(resolved_loop["status"], "resolved")
        self.assertTrue(any(node["id"] == f"document:{document['document_id']}" for node in graph["nodes"]))
        document_node = next(node for node in graph["nodes"] if node["id"] == f"document:{document['document_id']}")
        claim_node = next(node for node in graph["nodes"] if node["id"] == f"claim:{claim['id']}")
        self.assertEqual(document_node["document_type"], "notice")
        self.assertEqual(document_node["date"], "2024-03-10")
        self.assertEqual(document_node["sender"], "Robert")
        self.assertEqual(document_node["recipient"], "Vivare")
        self.assertEqual(document_node["relevance_score"], 0.91)
        self.assertEqual(document_node["confidentiality_level"], "sensitive")
        self.assertEqual(document_node["extraction_status"], "extracted")
        self.assertTrue(document_node["content_hash"])
        self.assertEqual(claim_node["support_state"], "supported")
        self.assertTrue(any(edge["to"] == f"event:{event['id']}" for edge in graph["edges"]))
        self.assertTrue(any(
            edge["from"] == f"document:{document['document_id']}"
            and edge["to"] == f"contradiction:{contradiction['id']}"
            and edge["type"] == "conflicts_with"
            for edge in graph["edges"]
        ))
        self.assertTrue(any(
            edge["from"] == f"document:{document['document_id']}"
            and edge["to"] == f"deadline:{deadline['id']}"
            and edge["type"] == "suggests_deadline"
            for edge in graph["edges"]
        ))
        self.assertEqual(graph["facets"]["document_types"], ["notice"])
        self.assertEqual(graph["facets"]["claim_support_states"], ["supported"])
        self.assertIn("Vivare", graph["facets"]["parties"])
        self.assertEqual(graph["facets"]["date_from"], "2024-03-10")
        self.assertEqual(graph["facets"]["date_to"], "2024-03-24")
        self.assertEqual(command_center["counts"]["active_cases"], 1)
        self.assertEqual(command_center["counts"]["cases_needing_evidence"], 0)
        self.assertTrue(command_center["next_actions"])
        audit_actions = [item["action"] for item in self.ledger.list_audit_events(case["case_id"])]
        self.assertIn("confirmed", audit_actions)
        self.assertIn("resolved", audit_actions)
        self.assertGreaterEqual(len(audit_actions), 9)

    def test_document_inbox_preserves_source_and_requires_explicit_case_link(self):
        case = self.ledger.create_case({
            "user_id": "robert",
            "title": "CAK objection",
            "identifiers": [{"identifier_value": "CAK-2026-4431"}],
        }, actor="robert")
        other_case = self.ledger.create_case({
            "user_id": "robert",
            "title": "Vivare repairs",
        }, actor="robert")
        source_text = "CAK issued decision CAK-2026-4431 on 2026-06-01."
        staged = self.ledger.stage_document_inbox_item(
            "robert",
            {
                "title": "CAK decision",
                "source_type": "manual_text",
                "source_uri": "manual://inbox/cak-decision",
                "extracted_text": source_text,
                "analysis": {"topics": ["administrative_law"], "processing": {"word_count": 6}},
            },
            suggested_matches=[{
                "case_id": case["case_id"],
                "case_title": case["title"],
                "score": 92,
                "confidence": "high",
                "reasons": ["case reference CAK-2026-4431 appears in the source"],
                "requires_review": True,
            }],
            actor="robert",
        )

        self.assertFalse(staged["duplicate"])
        self.assertEqual(staged["status"], "needs_review")
        self.assertEqual(staged["suggested_case_id"], case["case_id"])
        self.assertNotIn("local_path", staged)
        self.assertEqual(self.ledger.command_center("robert")["counts"]["document_inbox"], 1)
        self.assertEqual(
            self.ledger.command_center("robert")["next_actions"][0]["target"],
            "document-inbox",
        )

        linked = self.ledger.link_document_inbox_item(
            staged["id"], case["case_id"], "robert", actor="robert"
        )
        self.assertTrue(linked["created"])
        self.assertEqual(linked["inbox_item"]["status"], "linked")
        self.assertEqual(linked["document"]["source_uri"], "manual://inbox/cak-decision")
        self.assertEqual(linked["document"]["extracted_text"], source_text)
        self.assertEqual(len(self.ledger.list_document_versions(case["case_id"], linked["document"]["id"])), 1)
        self.assertEqual(self.ledger.command_center("robert")["counts"]["document_inbox"], 0)

        repeated = self.ledger.link_document_inbox_item(
            staged["id"], case["case_id"], "robert", actor="robert"
        )
        self.assertFalse(repeated["created"])
        self.assertEqual(repeated["document"]["id"], linked["document"]["id"])
        with self.assertRaisesRegex(ValueError, "already linked"):
            self.ledger.link_document_inbox_item(
                staged["id"], other_case["case_id"], "robert", actor="robert"
            )

        user_audit = self.ledger.list_audit_events(external_user_id="robert")
        self.assertTrue(any(item["action"] == "staged_for_case_review" for item in user_audit))
        self.assertTrue(any(item["action"] == "linked_to_case" for item in user_audit))
        self.assertNotIn(source_text, json.dumps(user_audit))
        self.assertEqual(self.ledger.list_document_inbox_items("other-user"), [])

    def test_document_inbox_remains_actionable_and_searchable_before_any_case_exists(self):
        staged = self.ledger.stage_document_inbox_item(
            "new-user",
            {
                "title": "Unassigned insurance decision",
                "source_type": "manual_text",
                "extracted_text": "Insurer Noordlicht rejected reimbursement on 2026-07-02.",
                "summary": "Reimbursement rejection awaiting case classification.",
            },
            suggested_matches=[],
            actor="new-user",
        )

        command_center = self.ledger.command_center("new-user")
        self.assertEqual(command_center["counts"]["active_cases"], 0)
        self.assertEqual(command_center["counts"]["document_inbox"], 1)
        self.assertEqual(command_center["next_actions"][0]["target"], "document-inbox")

        search = self.ledger.search_ledger("Noordlicht", "new-user")
        self.assertEqual(search["count"], 1)
        self.assertEqual(search["results"][0]["result_type"], "document_inbox")
        self.assertEqual(search["results"][0]["entity_id"], staged["id"])
        self.assertIsNone(search["results"][0]["case_id"])

    def test_create_all_adds_timeline_and_claim_columns_to_an_existing_database(self):
        legacy_path = os.path.join(self.tmp.name, "legacy-ledger.sqlite3")
        connection = sqlite3.connect(legacy_path)
        connection.execute(
            "CREATE TABLE case_events ("
            "id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL, event_date VARCHAR(40) NOT NULL, "
            "event_type VARCHAR(80), title VARCHAR(255) NOT NULL, description TEXT, "
            "source_confidence FLOAT, user_confirmed BOOLEAN, created_from_document_id INTEGER, "
            "created_at DATETIME, updated_at DATETIME)"
        )
        connection.execute(
            "CREATE TABLE legal_claims ("
            "id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL, asserted_by VARCHAR(255), "
            "claim_type VARCHAR(80), statement TEXT NOT NULL, status VARCHAR(80), confidence FLOAT, "
            "created_at DATETIME, updated_at DATETIME)"
        )
        connection.execute(
            "CREATE TABLE audit_events ("
            "id INTEGER PRIMARY KEY, case_id INTEGER, entity_type VARCHAR(80) NOT NULL, "
            "entity_id INTEGER, action VARCHAR(120) NOT NULL, actor VARCHAR(120), source VARCHAR(120), "
            "before_state TEXT, after_state TEXT, risk_level VARCHAR(40), approval_id INTEGER, created_at DATETIME)"
        )
        connection.commit()
        connection.close()

        legacy = LegalLedger("sqlite:///" + legacy_path)
        try:
            legacy.create_all()
            connection = sqlite3.connect(legacy_path)
            event_columns = {row[1] for row in connection.execute("PRAGMA table_info(case_events)")}
            claim_columns = {row[1] for row in connection.execute("PRAGMA table_info(legal_claims)")}
            audit_columns = {row[1] for row in connection.execute("PRAGMA table_info(audit_events)")}
            connection.close()
        finally:
            legacy.close()

        self.assertTrue({"actor", "action", "affected_party", "event_kind"}.issubset(event_columns))
        self.assertTrue({"position_role", "subject_party", "materiality"}.issubset(claim_columns))
        self.assertIn("user_id", audit_columns)

    def test_source_linked_obligations_are_reviewed_audited_and_exported(self):
        case = self.ledger.create_case({
            "user_id": "robert",
            "title": "Vivare repair obligation",
            "description": "A repair duty needs source review.",
            "parties": [{"name": "Vivare", "role": "housing provider"}],
        }, actor="robert")
        document = self.ledger.add_document(case["case_id"], {
            "title": "Repair agreement",
            "extracted_text": "Vivare must repair the heating before 2026-08-01.",
        }, actor="robert")
        obligation = self.ledger.add_obligation(case["case_id"], {
            "title": "Repair the heating",
            "description": "Vivare must repair the heating.",
            "responsible_party": "Vivare",
            "beneficiary_party": "Robert",
            "due_date": "2026-08-01",
            "source_document_id": document["document_id"],
            "source_quote": "Vivare must repair the heating before 2026-08-01.",
            "source_confidence": 0.9,
            "status": "needs_review",
        }, actor="system")
        self.ledger.add_evidence_link(case["case_id"], {
            "document_id": document["document_id"],
            "target_type": "obligation",
            "target_id": obligation["id"],
            "snippet": obligation["source_quote"],
            "relationship": "states_obligation",
        }, actor="system")

        self.assertEqual(self.ledger.list_obligations(case["case_id"])[0]["responsible_party"], "Vivare")
        queue = self.ledger.case_review_queue(case["case_id"])
        self.assertTrue(any(item["queue_type"] == "obligation" and item["item_id"] == obligation["id"] for item in queue["items"]))
        command_center = self.ledger.command_center("robert")
        self.assertEqual(command_center["counts"]["obligations"], 1)

        graph = self.ledger.papertrail_graph(case["case_id"])
        self.assertTrue(any(node["id"] == f"obligation:{obligation['id']}" for node in graph["nodes"]))
        self.assertEqual(sum(edge["to"] == f"obligation:{obligation['id']}" and edge["type"] == "states_obligation" for edge in graph["edges"]), 1)
        self.assertTrue(any(edge["to"] == f"obligation:{obligation['id']}" and edge["type"] == "responsible_for" for edge in graph["edges"]))

        summary = self.ledger.case_summary(case["case_id"])
        self.assertEqual(summary["risk_review"]["obligations"][0]["source_document_id"], document["document_id"])
        bundle = self.ledger.case_bundle(case["case_id"])
        self.assertEqual(bundle["review_items"]["obligations"][0]["source_quote"], obligation["source_quote"])
        search = self.ledger.search_ledger("repair the heating", "robert")
        self.assertTrue(any(item["result_type"] == "obligation" and item["entity_id"] == obligation["id"] for item in search["results"]))

        confirmed = self.ledger.update_obligation(case["case_id"], obligation["id"], {
            "action": "confirm",
            "responsible_party": "Vivare",
        }, actor="robert")
        self.assertEqual(confirmed["status"], "confirmed")
        self.assertTrue(confirmed["user_confirmed"])
        confirmed_links = [
            item for item in self.ledger.list_evidence_links(case["case_id"])
            if item["target_type"] == "obligation" and item["target_id"] == obligation["id"]
        ]
        self.assertTrue(confirmed_links)
        self.assertTrue(all(item["user_confirmed"] for item in confirmed_links))
        confirmed_queue = self.ledger.case_review_queue(case["case_id"])["items"]
        self.assertFalse(any(item["queue_type"] == "obligation" for item in confirmed_queue))
        self.assertFalse(any(item["queue_type"] == "evidence" and item["source"].get("target_type") == "obligation" for item in confirmed_queue))

        resolved = self.ledger.update_obligation(case["case_id"], obligation["id"], {"action": "resolve"}, actor="robert")
        self.assertEqual(resolved["status"], "resolved")
        self.assertEqual(self.ledger.command_center("robert")["counts"]["obligations"], 0)
        audit_actions = [
            item["action"]
            for item in self.ledger.list_audit_events(case["case_id"])
            if item["entity_type"] == "Obligation"
        ]
        self.assertEqual(audit_actions, ["resolved", "confirmed", "created"])
        with self.assertRaisesRegex(ValueError, "source_quote"):
            self.ledger.add_obligation(case["case_id"], {
                "title": "Unquoted obligation",
                "source_document_id": document["document_id"],
            }, actor="robert")

        other_case = self.ledger.create_case({"user_id": "robert", "title": "Other case"}, actor="robert")
        other_document = self.ledger.add_document(other_case["case_id"], {"title": "Other source"}, actor="robert")
        with self.assertRaisesRegex(ValueError, "same case"):
            self.ledger.update_obligation(case["case_id"], obligation["id"], {
                "action": "update",
                "source_document_id": other_document["document_id"],
            }, actor="robert")

    def test_case_operating_state_derives_primary_action_and_depth(self):
        case = self.ledger.create_case({
            "user_id": "robert",
            "title": "CAK operating state",
            "description": "Administrative decision needs reconstruction.",
            "legal_domain": "administrative_law",
            "parties": [{"name": "CAK", "role": "counterparty"}],
        }, actor="robert")

        initial_state = self.ledger.case_operating_state(case["case_id"])
        self.assertEqual(initial_state["primary_action"]["target"], "review")
        self.assertEqual(initial_state["primary_action"]["queue_type"], "gap")
        self.assertEqual(initial_state["recommended_depth"], "guided")
        self.assertTrue(initial_state["safety"]["external_actions_blocked_without_approval"])

        document = self.ledger.add_document(case["case_id"], {
            "title": "CAK notice",
            "extracted_text": "Notice dated 2024-04-01.",
        }, actor="robert")
        event = self.ledger.add_event(case["case_id"], {
            "event_date": "2024-04-01",
            "title": "CAK sent notice",
            "created_from_document_id": document["document_id"],
        }, actor="system")
        claim = self.ledger.add_claim(case["case_id"], {
            "statement": "CAK sent the notice on 2024-04-01.",
            "status": "needs_review",
        }, actor="system")
        evidence_link = self.ledger.add_evidence_link(case["case_id"], {
            "document_id": document["document_id"],
            "target_type": "claim",
            "target_id": claim["id"],
            "snippet": "Notice dated 2024-04-01.",
        }, actor="system")

        pending_state = self.ledger.case_operating_state(case["case_id"])
        self.assertEqual(pending_state["primary_action"]["target"], "review")
        self.assertEqual(pending_state["primary_action"]["queue_type"], "gap")

        self.ledger.update_evidence_link(case["case_id"], evidence_link["id"], {
            "action": "confirm",
            "relationship": "supports",
        }, actor="robert")
        state = self.ledger.case_operating_state(case["case_id"])
        self.assertEqual(state["primary_action"]["target"], "timeline")
        self.assertEqual(state["primary_action"]["item_id"], event["id"])
        self.assertGreaterEqual(state["traceability"]["documents"], 1)
        self.assertEqual(state["review_queue"]["counts"]["timeline"], 1)
        self.assertTrue(any(lane["key"] == "traceability" for lane in state["readiness"]["lanes"]))

    def test_case_review_queue_unifies_exact_persisted_targets(self):
        due_date = (dt.date.today() + dt.timedelta(days=2)).isoformat()
        case = self.ledger.create_case({
            "user_id": "robert",
            "title": "Unified review queue",
            "description": "One worklist should route to exact records.",
        }, actor="robert")
        document = self.ledger.add_document(case["case_id"], {
            "title": "Queue source",
            "extracted_text": "Decision and deadline source.",
        }, actor="robert")
        event = self.ledger.add_event(case["case_id"], {
            "event_date": due_date,
            "title": "Suggested event",
            "created_from_document_id": document["document_id"],
        }, actor="system")
        claim = self.ledger.add_claim(case["case_id"], {
            "statement": "The institution missed the deadline.",
            "status": "needs_review",
        }, actor="system")
        evidence = self.ledger.add_evidence_link(case["case_id"], {
            "document_id": document["document_id"],
            "target_type": "claim",
            "target_id": claim["id"],
            "snippet": "Decision and deadline source.",
        }, actor="system")
        contradiction = self.ledger.add_contradiction(case["case_id"], {
            "title": "Date conflict",
            "description": "Two sources disagree about the date.",
            "severity": "high",
        }, actor="system")
        gap = self.ledger.add_missing_evidence_warning(case["case_id"], {
            "title": "Proof of receipt missing",
            "suggested_action": "Find the receipt confirmation.",
            "severity": "high",
        }, actor="system")
        deadline = self.ledger.add_deadline(case["case_id"], {
            "due_date": due_date,
            "title": "Submit objection",
        }, actor="system")
        loop = self.ledger.add_open_loop(case["case_id"], {
            "title": "Confirm receipt date",
            "next_action": "Ask Robert to confirm when the letter arrived.",
        }, actor="system")
        outreach = self.ledger.create_outreach_draft(case["case_id"], {
            "lawyer_name": "Review Queue Lawyer",
            "lawyer_email": "queue@example-law.nl",
            "draft_body": "Draft only, do not send.",
        }, actor="robert")

        queue = self.ledger.case_review_queue(case["case_id"])
        items_by_type = {item["queue_type"]: item for item in queue["items"] if item["queue_type"] != "gap"}
        gap_items = [item for item in queue["items"] if item["queue_type"] == "gap"]

        self.assertEqual(queue["case_id"], case["case_id"])
        self.assertGreaterEqual(queue["count"], 8)
        self.assertEqual(items_by_type["approval"]["item_id"], outreach["approval_id"])
        self.assertEqual(items_by_type["deadline"]["item_id"], deadline["id"])
        self.assertEqual(items_by_type["timeline"]["item_id"], event["id"])
        self.assertEqual(items_by_type["claim"]["item_id"], claim["id"])
        self.assertEqual(items_by_type["evidence"]["item_id"], evidence["id"])
        self.assertEqual(items_by_type["contradiction"]["item_id"], contradiction["id"])
        self.assertTrue(any(item["item_id"] == gap["id"] for item in gap_items))
        self.assertEqual(items_by_type["loop"]["item_id"], loop["id"])
        self.assertEqual(items_by_type["approval"]["source"]["status"], "pending")
        self.assertEqual(items_by_type["deadline"]["target"], "review")
        self.assertEqual(items_by_type["timeline"]["target"], "timeline")
        self.assertEqual(items_by_type["evidence"]["target"], "evidence")
        self.assertEqual(queue["counts"]["approval"], 1)

    def test_case_update_replaces_parties_and_preserves_case_context(self):
        case = self.ledger.create_case({
            "user_id": "robert",
            "title": "Administrative dispute",
            "parties": [{"name": "CAK", "party_type": "government_body", "role": "counterparty"}],
        }, actor="robert")

        updated = self.ledger.update_case(case["case_id"], {
            "court_or_institution": "Rechtbank Gelderland",
            "opposing_parties": ["CAK", "Debt collector"],
            "parties": [
                {"name": "CAK", "party_type": "government_body", "role": "decision maker"},
                {"name": "Debt collector", "party_type": "organization", "role": "counterparty"},
            ],
        }, actor="robert")

        self.assertEqual(updated["court_or_institution"], "Rechtbank Gelderland")
        self.assertEqual(updated["opposing_parties"], ["CAK", "Debt collector"])
        self.assertEqual([item["name"] for item in updated["parties"]], ["CAK", "Debt collector"])
        self.assertEqual(updated["parties"][0]["role"], "decision maker")

        refreshed = self.ledger.get_case(case["case_id"])
        self.assertEqual(len(refreshed["parties"]), 2)
        graph = self.ledger.papertrail_graph(case["case_id"])
        party_labels = [node["label"] for node in graph["nodes"] if node["type"] == "party"]
        self.assertEqual(party_labels, ["CAK", "Debt collector"])

    def test_case_identifiers_resolve_external_references(self):
        case = self.ledger.create_case({
            "user_id": "robert",
            "title": "CAK dossier",
            "court_or_institution": "CAK",
            "case_identifiers": [
                {
                    "identifier_type": "dossier_number",
                    "identifier_value": "202020440",
                    "source_party": "CAK",
                    "source_type": "google_drive",
                    "source_uri": "gdrive://file/abc",
                }
            ],
            "sub_case_ids": [" bezwaar-2024-001 "],
        }, actor="robert")

        self.assertEqual(case["identifiers_count"], 2)
        self.assertEqual(
            [item["identifier_value"] for item in case["identifiers"]],
            ["202020440", "bezwaar-2024-001"],
        )

        added = self.ledger.add_case_identifier(case["case_id"], {
            "type": "court_reference",
            "value": "RBGEL-24-123",
            "source_party": "Rechtbank Gelderland",
            "notes": "Reference from incoming court letter.",
        }, actor="robert")
        self.assertEqual(added["identifier_type"], "court_reference")

        duplicate = self.ledger.add_case_identifier(case["case_id"], {
            "identifier_type": "court_reference",
            "identifier_value": "RBGEL-24-123",
            "source_party": "Rechtbank Gelderland",
            "source_uri": "gmail://message/123",
        }, actor="system")
        self.assertEqual(duplicate["id"], added["id"])
        self.assertEqual(duplicate["source_uri"], "gmail://message/123")

        match = self.ledger.lookup_case_identifier(
            "RBGEL-24-123",
            external_user_id="robert",
            identifier_type="court_reference",
        )
        self.assertEqual(match["case"]["case_id"], case["case_id"])
        self.assertEqual(match["identifier"]["source_party"], "Rechtbank Gelderland")

        identifiers = self.ledger.list_case_identifiers(case["case_id"])
        self.assertEqual(len(identifiers), 3)
        graph = self.ledger.papertrail_graph(case["case_id"])
        identifier_nodes = [node for node in graph["nodes"] if node["type"] == "identifier"]
        self.assertEqual(len(identifier_nodes), 3)
        self.assertTrue(any(edge["type"] == "identified_by" for edge in graph["edges"]))

    def test_claim_review_actions_are_persisted_and_audited(self):
        case = self.ledger.create_case({
            "user_id": "robert",
            "title": "Claim review case",
        }, actor="robert")
        claim = self.ledger.add_claim(case["case_id"], {
            "statement": "CAK sent the decision late.",
            "status": "needs_review",
        }, actor="system")

        confirmed = self.ledger.update_claim(case["case_id"], claim["id"], {"action": "confirm"}, actor="robert")
        self.assertEqual(confirmed["status"], "confirmed")

        reopened = self.ledger.update_claim(case["case_id"], claim["id"], {"action": "reopen"}, actor="robert")
        self.assertEqual(reopened["status"], "needs_review")

        dismissed = self.ledger.update_claim(case["case_id"], claim["id"], {"action": "dismiss"}, actor="robert")
        self.assertEqual(dismissed["status"], "dismissed")

        audit_actions = [item["action"] for item in self.ledger.list_audit_events(case["case_id"])]
        self.assertIn("confirmed", audit_actions)
        self.assertIn("reopened", audit_actions)
        self.assertIn("dismissed", audit_actions)

    def test_evidence_link_review_actions_are_persisted_and_audited(self):
        case = self.ledger.create_case({
            "user_id": "robert",
            "title": "Evidence review case",
        }, actor="robert")
        document = self.ledger.add_document(case["case_id"], {
            "title": "CAK letter",
            "original_filename": "cak-letter.txt",
            "extracted_text": "The notice was sent on 2024-04-01.",
        }, actor="robert")
        claim = self.ledger.add_claim(case["case_id"], {
            "statement": "CAK sent the notice on 2024-04-01.",
            "status": "needs_review",
        }, actor="system")
        link = self.ledger.add_evidence_link(case["case_id"], {
            "document_id": document["document_id"],
            "target_type": "claim",
            "target_id": claim["id"],
            "snippet": "The notice was sent on 2024-04-01.",
            "relationship": "supports",
            "strength": "medium",
        }, actor="system")

        confirmed = self.ledger.update_evidence_link(case["case_id"], link["id"], {"action": "confirm"}, actor="robert")
        self.assertTrue(confirmed["user_confirmed"])
        self.assertEqual(confirmed["relationship"], "supports")

        rejected = self.ledger.update_evidence_link(case["case_id"], link["id"], {"action": "reject"}, actor="robert")
        self.assertFalse(rejected["user_confirmed"])
        self.assertEqual(rejected["relationship"], "rejected_suggestion")

        reopened = self.ledger.update_evidence_link(case["case_id"], link["id"], {"action": "reopen"}, actor="robert")
        self.assertFalse(reopened["user_confirmed"])
        self.assertEqual(reopened["relationship"], "needs_review")

        audit_actions = [item["action"] for item in self.ledger.list_audit_events(case["case_id"])]
        self.assertIn("confirmed", audit_actions)
        self.assertIn("rejected", audit_actions)
        self.assertIn("reopened", audit_actions)

    def test_outreach_draft_creates_pending_high_risk_approval(self):
        case = self.ledger.create_case({"user_id": "robert", "title": "CAK dispute"}, actor="robert")
        outreach = self.ledger.create_outreach_draft(case["case_id"], {
            "lawyer_name": "Test Lawyer",
            "lawyer_email": "lawyer@example.com",
            "subject": "Case inquiry",
            "draft_body": "Please review this case.",
        }, actor="robert")

        approvals = self.ledger.list_approvals(case_id=case["case_id"], status="pending")

        self.assertEqual(outreach["status"], "waiting_approval")
        self.assertEqual(len(approvals), 1)
        self.assertEqual(approvals[0]["risk_level"], "high")
        self.assertEqual(approvals[0]["action"], "send_external_legal_email")
        approved = self.ledger.resolve_approval(approvals[0]["id"], "approved", actor="robert")
        outreach = self.ledger.list_outreach(case["case_id"])[0]

        self.assertEqual(approved["status"], "approved")
        self.assertEqual(outreach["status"], "approved_to_send")
        self.assertGreaterEqual(len(self.ledger.list_audit_events(case["case_id"])), 3)

        second_outreach = self.ledger.create_outreach_draft(case["case_id"], {
            "lawyer_name": "Reject Lawyer",
            "lawyer_email": "reject@example.com",
            "draft_body": "Do not send this.",
        }, actor="robert")
        rejected = self.ledger.resolve_approval(second_outreach["approval_id"], "rejected", actor="robert", reason="Not appropriate.")
        second_outreach = next(item for item in self.ledger.list_outreach(case["case_id"]) if item["id"] == second_outreach["id"])

        self.assertEqual(rejected["status"], "rejected")
        self.assertEqual(second_outreach["status"], "approval_rejected")

    def test_outreach_directory_requires_review_before_matching_use(self):
        imported = self.ledger.import_outreach_directory_targets([{
            "target_type": "organization",
            "name": "Tenant support fixture",
            "subtype": "tenant advocacy",
            "topics": ["housing", "rent"],
            "legal_fields": ["PROPERTY_LAW"],
            "source_url": "https://example.test/tenant-support",
            "contact_url": "https://example.test/tenant-support/contact",
            "source_label": "Fixture source",
        }], actor="robert")

        self.assertEqual(imported[0]["status"], "needs_review")
        self.assertEqual(self.ledger.list_outreach_directory_targets(status="approved"), [])

        approved = self.ledger.update_outreach_directory_target(imported[0]["id"], {"action": "approve"}, actor="robert")
        self.assertEqual(approved["status"], "approved")
        approved_records = self.ledger.list_outreach_directory_targets(target_type="organization", status="approved")
        self.assertEqual(len(approved_records), 1)
        self.assertEqual(approved_records[0]["source_url"], "https://example.test/tenant-support")
        audit_actions = [item["action"] for item in self.ledger.list_audit_events()]
        self.assertIn("imported", audit_actions)
        self.assertIn("approved", audit_actions)

    def test_generated_formal_drafts_are_approval_gated_and_traceable(self):
        case = self.ledger.create_case({"user_id": "robert", "title": "Formal CAK letter"}, actor="robert")
        draft = self.ledger.create_draft(case["case_id"], {
            "draft_type": "formal_letter",
            "title": "Formal objection to CAK",
            "body": "Dear CAK, this is a draft objection.",
        }, actor="robert")

        approvals = self.ledger.list_approvals(case_id=case["case_id"], status="pending")

        self.assertEqual(draft["status"], "waiting_approval")
        self.assertEqual(draft["risk_level"], "high")
        self.assertEqual(len(approvals), 1)
        self.assertEqual(approvals[0]["entity_type"], "Draft")
        self.assertEqual(approvals[0]["entity_id"], draft["id"])
        self.assertEqual(approvals[0]["action"], "send_formal_legal_letter")

        approved = self.ledger.resolve_approval(draft["approval_id"], "approved", actor="robert")
        self.assertEqual(approved["status"], "approved")
        approved_draft = self.ledger.get_draft(case["case_id"], draft["id"])
        self.assertEqual(approved_draft["status"], "approved_for_external_use")

        bundle = self.ledger.case_bundle(case["case_id"])
        self.assertEqual(bundle["drafts"][0]["id"], draft["id"])
        graph = self.ledger.papertrail_graph(case["case_id"])
        self.assertTrue(any(node["id"] == f"draft:{draft['id']}" for node in graph["nodes"]))
        self.assertTrue(any(edge["from"] == f"draft:{draft['id']}" and edge["to"] == f"approval:{draft['approval_id']}" for edge in graph["edges"]))
        audit = self.ledger.list_audit_events(case["case_id"])
        self.assertTrue(any(item["entity_type"] == "Draft" and item["action"] == "created" for item in audit))
        self.assertTrue(any(item["entity_type"] == "Draft" and item["action"] == "approval_approved" for item in audit))

    def test_internal_summary_draft_can_be_submitted_for_approval_later(self):
        case = self.ledger.create_case({"user_id": "robert", "title": "Internal summary"}, actor="robert")
        draft = self.ledger.create_draft(case["case_id"], {
            "draft_type": "case_summary",
            "title": "Lawyer-ready summary",
            "body": "Internal working summary.",
        }, actor="system")

        self.assertEqual(draft["status"], "draft")
        self.assertIsNone(draft["approval_id"])

        submitted = self.ledger.update_draft(case["case_id"], draft["id"], {
            "action": "submit_for_approval",
            "approval_reason": "Share this summary with a lawyer.",
        }, actor="robert")
        self.assertEqual(submitted["status"], "waiting_approval")
        self.assertIsNotNone(submitted["approval_id"])
        approvals = self.ledger.list_approvals(case_id=case["case_id"], status="pending")
        self.assertEqual(approvals[0]["entity_type"], "Draft")
        self.assertEqual(approvals[0]["action"], "approve_generated_draft_external_use")

    def test_lawyer_responses_are_persisted_classified_and_audited(self):
        case = self.ledger.create_case({"user_id": "robert", "title": "CAK response tracking"}, actor="robert")
        outreach = self.ledger.create_outreach_draft(case["case_id"], {
            "lawyer_name": "Response Lawyer",
            "lawyer_email": "response@example-law.nl",
            "subject": "Case inquiry",
            "draft_body": "Please review this case.",
        }, actor="robert")
        self.ledger.resolve_approval(outreach["approval_id"], "approved", actor="robert")
        with self.ledger.session_scope() as session:
            item = session.get(LawyerOutreach, outreach["id"])
            item.status = "sent"

        awaiting = self.ledger.command_center("robert")
        self.assertEqual(awaiting["counts"]["cases_awaiting_lawyer_response"], 1)

        response = self.ledger.add_lawyer_response(case["case_id"], outreach["id"], {
            "response_type": "pre_assessment_positive",
            "content": "Interested, please send the evidence bundle.",
            "received_at": "2026-07-01T09:00:00Z",
        }, actor="robert")

        self.assertEqual(response["response_type"], "interested")
        self.assertEqual(response["lawyer_email"], "response@example-law.nl")
        self.assertEqual(response["timestamp"], "2026-07-01T09:00:00Z")
        responses = self.ledger.list_lawyer_responses(case["case_id"])
        self.assertEqual(len(responses), 1)
        outreach_after = self.ledger.list_outreach(case["case_id"])[0]
        self.assertEqual(outreach_after["status"], "response_interested")
        no_longer_awaiting = self.ledger.command_center("robert")
        self.assertEqual(no_longer_awaiting["counts"]["cases_awaiting_lawyer_response"], 0)
        audit = self.ledger.list_audit_events(case["case_id"])
        self.assertTrue(any(item["entity_type"] == "LawyerResponse" and item["action"] == "recorded" for item in audit))
        self.assertTrue(any(item["entity_type"] == "LawyerOutreach" and item["action"] == "response_recorded" for item in audit))

    def test_command_center_surfaces_operational_review_queues(self):
        due_date = (dt.date.today() + dt.timedelta(days=3)).isoformat()
        case = self.ledger.create_case({
            "user_id": "robert",
            "title": "Urgent housing file",
            "description": "Needs evidence and legal follow-up.",
            "risk_level": "high",
        }, actor="robert")
        self.ledger.add_deadline(case["case_id"], {
            "due_date": due_date,
            "title": "Submit objection",
        }, actor="system")
        self.ledger.add_open_loop(case["case_id"], {
            "title": "Robert must confirm dates",
            "next_action": "Confirm receipt and notice dates.",
            "risk_level": "high",
        }, actor="system")
        self.ledger.add_contradiction(case["case_id"], {
            "title": "Notice date conflict",
            "description": "Two sources conflict on the notice date.",
            "severity": "high",
        }, actor="system")
        self.ledger.add_missing_evidence_warning(case["case_id"], {
            "title": "Payment proof missing",
            "suggested_action": "Find bank statement or receipt.",
            "severity": "high",
        }, actor="system")
        outreach = self.ledger.create_outreach_draft(case["case_id"], {
            "lawyer_name": "Housing Lawyer",
            "lawyer_email": "housing@example-law.nl",
            "draft_body": "Please review this urgent case.",
        }, actor="robert")
        with self.ledger.session_scope() as session:
            item = session.get(LawyerOutreach, outreach["id"])
            item.status = "sent"

        dashboard = self.ledger.command_center("robert")

        self.assertEqual(dashboard["counts"]["active_cases"], 1)
        self.assertEqual(dashboard["counts"]["urgent_deadlines"], 1)
        self.assertEqual(dashboard["counts"]["cases_needing_robert"], 1)
        self.assertEqual(dashboard["counts"]["cases_needing_evidence"], 1)
        self.assertEqual(dashboard["counts"]["pending_outreach_approval"], 1)
        self.assertEqual(dashboard["counts"]["cases_awaiting_lawyer_response"], 1)
        self.assertGreaterEqual(dashboard["counts"]["high_risk_items"], 4)
        self.assertEqual(dashboard["review_queues"]["cases_needing_robert"][0]["case_id"], case["case_id"])
        self.assertEqual(dashboard["urgent_deadlines"][0]["due_date"], due_date)
        self.assertEqual(dashboard["pending_outreach_approval"][0]["action"], "send_external_legal_email")
        self.assertEqual(dashboard["awaiting_lawyer_response"][0]["status"], "sent")
        self.assertTrue(any(item["item_type"] == "deadline" for item in dashboard["high_risk_items"]))
        next_actions_by_target = {item["target"]: item for item in dashboard["next_actions"]}
        self.assertEqual(next_actions_by_target["approvals"]["queue_type"], "approval")
        self.assertIsNotNone(next_actions_by_target["approvals"]["item_id"])
        self.assertEqual(next_actions_by_target["deadlines"]["queue_type"], "deadline")
        self.assertIsNotNone(next_actions_by_target["deadlines"]["item_id"])
        self.assertEqual(next_actions_by_target["contradictions"]["queue_type"], "contradiction")
        self.assertIsNotNone(next_actions_by_target["contradictions"]["item_id"])
        self.assertEqual(next_actions_by_target["missing-evidence"]["queue_type"], "gap")
        self.assertIsNotNone(next_actions_by_target["missing-evidence"]["item_id"])
        self.assertEqual(next_actions_by_target["open-loops"]["queue_type"], "loop")
        self.assertIsNotNone(next_actions_by_target["open-loops"]["item_id"])

    def test_missing_evidence_and_bundle_are_generated_from_persisted_records(self):
        case = self.ledger.create_case({
            "user_id": "robert",
            "title": "CAK proof dispute",
            "description": "Need to prove payment and notice.",
        }, actor="robert")
        claim = self.ledger.add_claim(case["case_id"], {
            "statement": "Robert paid the invoice before the deadline.",
            "asserted_by": "Robert",
        }, actor="robert")

        warnings = self.ledger.list_missing_evidence(case["case_id"])
        self.assertTrue(any(item["warning_type"] == "case_without_documents" for item in warnings))
        self.assertTrue(any(item["claim_id"] == claim["id"] and item["status"] == "needs_review" for item in warnings))

        document = self.ledger.add_document(case["case_id"], {
            "title": "Payment confirmation",
            "document_type": "bank_record",
            "extracted_text": "Payment was sent before the deadline.",
        }, actor="robert")
        evidence_link = self.ledger.add_evidence_link(case["case_id"], {
            "document_id": document["document_id"],
            "target_type": "claim",
            "target_id": claim["id"],
            "snippet": "Payment was sent before the deadline.",
        }, actor="robert")
        confirmed_link = self.ledger.update_evidence_link(
            case["case_id"], evidence_link["id"], {"action": "confirm"}, actor="robert"
        )
        self.assertTrue(confirmed_link["user_confirmed"])

        refreshed = self.ledger.list_missing_evidence(case["case_id"])
        self.assertTrue(all(item["status"] == "resolved" for item in refreshed))

        summary = self.ledger.case_summary(case["case_id"])
        red_line = self.ledger.red_line_thread(case["case_id"])
        bundle = self.ledger.case_bundle(case["case_id"])

        self.assertEqual(len(summary["claims"]["supported"]), 1)
        self.assertEqual(len(summary["claims"]["unsupported"]), 0)
        self.assertIn("Confirmed supported claims: 1", red_line["body"])
        self.assertIn(f"doc {document['document_id']}: Payment confirmation", red_line["body"])
        self.assertIn("source: doc", red_line["body"])
        self.assertIn("source_documents", red_line["sections"])
        self.assertIn("source_linked_chronology", red_line["sections"])
        self.assertIn("next_actions", red_line["sections"])
        self.assertEqual(bundle["share_status"], "internal_only_until_approved")
        self.assertTrue(bundle["external_sharing_requires_approval"])
        self.assertFalse(bundle["external_sharing_allowed"])
        self.assertEqual(bundle["source_documents"][0]["document_id"], document["document_id"])
        self.assertIn("source_linked_timeline", bundle)
        self.assertIn("next_actions", bundle)

        approval = self.ledger.request_case_bundle_share_approval(case["case_id"], actor="robert")
        duplicate = self.ledger.request_case_bundle_share_approval(case["case_id"], actor="robert")
        self.assertEqual(approval["id"], duplicate["id"])
        self.assertEqual(approval["entity_type"], "CaseBundle")
        self.assertEqual(approval["action"], "share_case_bundle_externally")
        self.assertEqual(approval["risk_level"], "high")

        pending_bundle = self.ledger.case_bundle(case["case_id"])
        self.assertEqual(pending_bundle["share_status"], "external_share_approval_pending")
        self.assertEqual(pending_bundle["external_sharing_approval"]["id"], approval["id"])
        self.assertFalse(pending_bundle["external_sharing_allowed"])

        approved = self.ledger.resolve_approval(approval["id"], "approved", actor="robert")
        self.assertEqual(approved["status"], "approved")
        approved_bundle = self.ledger.case_bundle(case["case_id"])
        self.assertEqual(approved_bundle["share_status"], "external_share_approved")
        self.assertTrue(approved_bundle["external_sharing_allowed"])
        self.assertEqual(approved_bundle["bundle_snapshot_hash"], approval["context"]["bundle_snapshot_hash"])

        self.ledger.update_case(case["case_id"], {"current_summary": "Case changed after approval."}, actor="robert")
        stale_bundle = self.ledger.case_bundle(case["case_id"])
        self.assertEqual(stale_bundle["share_status"], "external_share_approval_stale")
        self.assertTrue(stale_bundle["approval_stale"])
        self.assertFalse(stale_bundle["external_sharing_allowed"])

        fresh_pending = self.ledger.request_case_bundle_share_approval(case["case_id"], actor="robert")
        self.assertNotEqual(fresh_pending["id"], approval["id"])
        self.ledger.add_event(case["case_id"], {
            "event_date": "2026-07-13",
            "title": "New event after approval request",
            "description": "The snapshot changed again.",
        }, actor="robert")
        with self.assertRaisesRegex(ValueError, "case changed"):
            self.ledger.resolve_approval(fresh_pending["id"], "approved", actor="robert")

        replacement = self.ledger.request_case_bundle_share_approval(case["case_id"], actor="robert")
        self.assertNotEqual(replacement["id"], fresh_pending["id"])
        superseded = next(item for item in self.ledger.list_approvals(case["case_id"]) if item["id"] == fresh_pending["id"])
        self.assertEqual(superseded["status"], "superseded")
        self.ledger.resolve_approval(replacement["id"], "approved", actor="robert")
        refreshed_bundle = self.ledger.case_bundle(case["case_id"])
        self.assertTrue(refreshed_bundle["external_sharing_allowed"])
        self.assertFalse(refreshed_bundle["approval_stale"])

    def test_proposed_evidence_is_not_counted_as_confirmed_claim_support(self):
        case = self.ledger.create_case({
            "user_id": "robert",
            "title": "Evidence confirmation boundary",
            "description": "Proposed evidence must remain review-only.",
        }, actor="robert")
        claim = self.ledger.add_claim(case["case_id"], {
            "statement": "Robert sent the notice before the stated deadline.",
            "asserted_by": "Robert",
        }, actor="robert")
        document = self.ledger.add_document(case["case_id"], {
            "title": "Notice email",
            "document_type": "email",
            "extracted_text": "The notice was sent on 2024-05-13.",
        }, actor="robert")
        link = self.ledger.add_evidence_link(case["case_id"], {
            "document_id": document["document_id"],
            "target_type": "claim",
            "target_id": claim["id"],
            "relationship": "supports",
            "snippet": "The notice was sent on 2024-05-13.",
        }, actor="robert")

        summary = self.ledger.case_summary(case["case_id"])
        dossier = self.ledger.case_comprehension_dossier(case["case_id"])
        red_line = self.ledger.red_line_thread(case["case_id"])

        self.assertEqual(summary["claims"]["supported"], [])
        self.assertEqual(len(summary["claims"]["proposed_support"]), 1)
        self.assertEqual(summary["claims"]["unsupported"], [])
        self.assertEqual(dossier["positions"]["supported"], [])
        self.assertEqual(len(dossier["positions"]["proposed_support"]), 1)
        self.assertEqual(len(dossier["positions"]["proposed_support"][0]["proposed_sources"]), 1)
        self.assertTrue(any(action["label"] == "Classify proposed evidence links" for action in dossier["next_actions"]))
        self.assertIn("Confirmed supported claims: 0", red_line["body"])
        self.assertIn("Claims with evidence awaiting classification: 1", red_line["body"])
        self.assertIn("pending classification: source: doc", red_line["body"])

        confirmed = self.ledger.update_evidence_link(
            case["case_id"], link["id"], {"action": "confirm"}, actor="robert"
        )
        self.assertTrue(confirmed["user_confirmed"])
        confirmed_summary = self.ledger.case_summary(case["case_id"])
        self.assertEqual(len(confirmed_summary["claims"]["supported"]), 1)
        self.assertEqual(confirmed_summary["claims"]["proposed_support"], [])

    def test_position_matrix_keeps_support_dispute_context_and_pending_sources_distinct(self):
        case = self.ledger.create_case({"user_id": "robert", "title": "Competing payment positions"}, actor="robert")
        claim = self.ledger.add_claim(case["case_id"], {
            "statement": "The payment was received before the deadline.",
            "asserted_by": "CAK",
            "position_role": "institution",
            "subject_party": "Robert",
            "claim_type": "factual",
            "materiality": "high",
        }, actor="robert")
        support_doc = self.ledger.add_document(case["case_id"], {
            "title": "CAK receipt",
            "extracted_text": "Payment received on 2024-05-13.",
        }, actor="robert")
        dispute_doc = self.ledger.add_document(case["case_id"], {
            "title": "Bank return notice",
            "extracted_text": "The payment was returned on 2024-05-13.",
        }, actor="robert")
        pending_doc = self.ledger.add_document(case["case_id"], {
            "title": "Account correspondence",
            "extracted_text": "The account remained under review.",
        }, actor="robert")
        context_doc = self.ledger.add_document(case["case_id"], {
            "title": "Account terms",
            "extracted_text": "Payments are normally processed within two working days.",
        }, actor="robert")
        support = self.ledger.add_evidence_link(case["case_id"], {
            "document_id": support_doc["document_id"],
            "target_type": "claim",
            "target_id": claim["id"],
            "relationship": "supports",
            "snippet": "Payment received on 2024-05-13.",
        }, actor="robert")
        dispute = self.ledger.add_evidence_link(case["case_id"], {
            "document_id": dispute_doc["document_id"],
            "target_type": "claim",
            "target_id": claim["id"],
            "relationship": "disputes",
            "snippet": "The payment was returned on 2024-05-13.",
        }, actor="robert")
        pending = self.ledger.add_evidence_link(case["case_id"], {
            "document_id": pending_doc["document_id"],
            "target_type": "claim",
            "target_id": claim["id"],
            "relationship": "suggests_claim",
            "snippet": "The account remained under review.",
        }, actor="document_intelligence")
        context = self.ledger.add_evidence_link(case["case_id"], {
            "document_id": context_doc["document_id"],
            "target_type": "claim",
            "target_id": claim["id"],
            "relationship": "context",
            "snippet": "Payments are normally processed within two working days.",
        }, actor="robert")

        warnings = self.ledger.list_missing_evidence(case["case_id"])
        self.assertTrue(any(item["claim_id"] == claim["id"] and item["status"] == "needs_review" for item in warnings))
        with self.assertRaisesRegex(ValueError, "supports, disputes, or contextualizes"):
            self.ledger.update_evidence_link(case["case_id"], pending["id"], {"action": "confirm"}, actor="robert")

        self.ledger.update_evidence_link(case["case_id"], support["id"], {"action": "confirm"}, actor="robert")
        self.ledger.update_evidence_link(case["case_id"], dispute["id"], {"action": "confirm"}, actor="robert")
        self.ledger.update_evidence_link(case["case_id"], context["id"], {"action": "confirm"}, actor="robert")
        summary = self.ledger.case_summary(case["case_id"])
        dossier = self.ledger.case_comprehension_dossier(case["case_id"])
        matrix = self.ledger.case_position_matrix(case["case_id"])

        self.assertEqual(summary["claims"]["supported"], [])
        self.assertEqual(len(summary["claims"]["mixed"]), 1)
        self.assertEqual(dossier["positions"]["all"][0]["evidence_state"], "mixed")
        self.assertEqual(len(dossier["positions"]["all"][0]["supporting_sources"]), 1)
        self.assertEqual(len(dossier["positions"]["all"][0]["disputing_sources"]), 1)
        self.assertEqual(len(dossier["positions"]["all"][0]["context_sources"]), 1)
        self.assertEqual(len(dossier["positions"]["all"][0]["proposed_sources"]), 1)
        self.assertEqual(matrix["counts"]["mixed"], 1)
        self.assertEqual(matrix["counts"]["pending_source_classification"], 1)
        self.assertEqual(matrix["groups"][0]["asserted_by"], "CAK")
        self.assertEqual(matrix["groups"][0]["position_role"], "institution")
        self.assertTrue(matrix["legal_safety"]["mixed_evidence_is_not_presented_as_supported"])
        self.assertTrue(any(action["label"] == "Classify proposed evidence links" for action in dossier["next_actions"]))
        red_line_body = self.ledger.red_line_thread(case["case_id"])["body"]
        self.assertIn("Mixed support and dispute: 1", red_line_body)
        self.assertIn("Claims with evidence awaiting classification: 1", red_line_body)

    def test_timeline_suggestions_can_be_edited_approved_and_rejected(self):
        case = self.ledger.create_case({"user_id": "robert", "title": "CAK timeline review"}, actor="robert")
        document = self.ledger.add_document(case["case_id"], {
            "title": "CAK decision",
            "document_type": "decision",
            "extracted_text": "Decision dated 2024-05-01. Objection deadline 2024-05-15.",
        }, actor="robert")

        suggested = self.ledger.add_event(case["case_id"], {
            "event_date": "2024-05-01",
            "title": "Timeline suggestion",
            "description": "Decision dated 2024-05-01.",
            "event_type": "suggested_from_document",
            "created_from_document_id": document["document_id"],
            "user_confirmed": False,
        }, actor="system")

        self.assertEqual(suggested["review_status"], "needs_review")
        graph = self.ledger.papertrail_graph(case["case_id"])
        event_edge = next(edge for edge in graph["edges"] if edge["to"] == f"event:{suggested['id']}")
        self.assertFalse(event_edge["user_confirmed"])

        edited = self.ledger.update_event(case["case_id"], suggested["id"], {
            "action": "edit",
            "event_date": "2024-05-02",
            "title": "CAK decision received",
            "description": "Robert received the CAK decision.",
        }, actor="robert")
        self.assertEqual(edited["event_date"], "2024-05-02")
        self.assertEqual(edited["title"], "CAK decision received")
        self.assertEqual(edited["review_status"], "needs_review")

        approved = self.ledger.update_event(case["case_id"], suggested["id"], {"action": "approve"}, actor="robert")
        self.assertTrue(approved["user_confirmed"])
        self.assertEqual(approved["event_type"], "confirmed_from_document")
        self.assertEqual(approved["review_status"], "confirmed")

        graph = self.ledger.papertrail_graph(case["case_id"])
        event_edge = next(edge for edge in graph["edges"] if edge["to"] == f"event:{suggested['id']}")
        self.assertTrue(event_edge["user_confirmed"])

        rejected = self.ledger.add_event(case["case_id"], {
            "event_date": "2024-05-15",
            "title": "Wrong objection deadline",
            "description": "Candidate extracted deadline that should be rejected.",
            "event_type": "suggested_from_document",
            "created_from_document_id": document["document_id"],
            "user_confirmed": False,
        }, actor="system")
        rejected = self.ledger.update_event(case["case_id"], rejected["id"], {"action": "reject"}, actor="robert")
        self.assertEqual(rejected["review_status"], "rejected")
        self.assertEqual(rejected["event_type"], "rejected_suggestion")

        summary = self.ledger.case_summary(case["case_id"])
        titles = [event["title"] for event in summary["factual_reconstruction"]["known_events"]]
        self.assertIn("CAK decision received", titles)
        self.assertNotIn("Wrong objection deadline", titles)

    def test_case_analysis_jobs_persist_real_progress_and_prevent_duplicates(self):
        case = self.ledger.create_case({"user_id": "robert", "title": "Full-source analysis"}, actor="robert")
        workload = {
            "provider": "ollama",
            "model": "local-fixture",
            "total_documents": 2,
            "total_words": 1200,
            "total_characters": 7200,
            "estimated_total_seconds": 30,
        }

        created = self.ledger.create_case_analysis_job(case["case_id"], workload, actor="robert")
        duplicate = self.ledger.create_case_analysis_job(case["case_id"], workload, actor="robert")

        self.assertEqual(created["job_id"], duplicate["job_id"])
        self.assertEqual(created["status"], "queued")
        running = self.ledger.update_case_analysis_job(case["case_id"], created["job_id"], {
            "status": "running",
            "stage": "Reading source chunk 2 of 4",
            "total_chunks": 4,
            "completed_chunks": 2,
            "completed_documents": 1,
            "processed_words": 600,
            "processed_characters": 3600,
        }, actor="robert")
        self.assertGreater(running["progress_percent"], 40)
        self.assertLess(running["progress_percent"], 100)
        completed = self.ledger.update_case_analysis_job(case["case_id"], created["job_id"], {
            "status": "completed",
            "stage": "Full-source reading stored for cited review",
            "completed_chunks": 4,
            "completed_documents": 2,
            "processed_words": 1200,
            "processed_characters": 7200,
            "result": {"findings_count": 3, "source_preserved": True},
        }, actor="robert")

        self.assertEqual(completed["progress_percent"], 100)
        self.assertEqual(completed["estimated_remaining_seconds"], 0)
        self.assertEqual(completed["result"]["findings_count"], 3)
        self.assertEqual(self.ledger.get_case_analysis_job(case["case_id"], created["job_id"])["status"], "completed")
        job_audits = [
            item for item in self.ledger.list_audit_events(case_id=case["case_id"])
            if item["entity_type"] == "CaseAnalysisJob"
        ]
        self.assertEqual({item["action"] for item in job_audits}, {"created", "completed"})
        retry = self.ledger.create_case_analysis_job(case["case_id"], workload, actor="robert")
        self.assertNotEqual(retry["job_id"], created["job_id"])
        self.assertEqual(self.ledger.fail_interrupted_case_analysis_jobs(), 1)
        interrupted = self.ledger.get_case_analysis_job(case["case_id"], retry["job_id"])
        self.assertEqual(interrupted["status"], "failed")
        self.assertIn("restarted", interrupted["error"])


class TestLegalLedgerApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        cls.ledger_url = "sqlite:///" + os.path.join(cls.tmp.name, "api-ledger.sqlite3")
        os.environ["LARO_LEDGER_DATABASE_URL"] = cls.ledger_url
        os.environ["LARO_UPLOAD_ROOT"] = os.path.join(cls.tmp.name, "uploads")
        import app as app_module
        from legal_ledger import LegalLedger

        cls.app_module = app_module
        cls.previous_ledger = app_module.legal_ledger
        cls.previous_config_ledger = app_module.app.config.get("legal_ledger")
        cls.previous_config_url = app_module.app.config.get("LARO_LEDGER_DATABASE_URL")
        cls.ledger = LegalLedger(cls.ledger_url)
        cls.ledger.create_all()
        app_module.legal_ledger = cls.ledger
        app_module.app.config["legal_ledger"] = cls.ledger
        app_module.app.config["LARO_LEDGER_DATABASE_URL"] = cls.ledger_url
        cls.client = app_module.app.test_client()

    @classmethod
    def tearDownClass(cls):
        cls.ledger.close()
        gc.collect()
        cls.app_module.legal_ledger = cls.previous_ledger
        cls.app_module.app.config["legal_ledger"] = cls.previous_config_ledger
        if cls.previous_config_url is None:
            cls.app_module.app.config.pop("LARO_LEDGER_DATABASE_URL", None)
        else:
            cls.app_module.app.config["LARO_LEDGER_DATABASE_URL"] = cls.previous_config_url
        cls.tmp.cleanup()

    def setUp(self):
        token = self.app_module.auth_system._create_session("ledger@example.com", "user")
        self.headers = {"Authorization": f"Bearer {token}"}

    def test_identifier_lookup_is_scoped_to_authenticated_owner(self):
        victim_token = self.app_module.auth_system._create_session("identifier-owner@example.com", "user")
        victim_headers = {"Authorization": f"Bearer {victim_token}"}
        created = self.client.post("/api/cases", json={
            "title": "Private identifier case",
            "description": "Must not be discoverable by another account.",
        }, headers=victim_headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]
        identifier_value = "PRIVATE-IDENTIFIER-2026-001"
        identifier = self.client.post(f"/api/cases/{case_id}/identifiers", json={
            "identifier_type": "court_reference",
            "identifier_value": identifier_value,
            "source_party": "Rechtbank",
        }, headers=victim_headers)
        self.assertEqual(identifier.status_code, 201)

        denied = self.client.get(
            f"/api/case-identifiers/lookup?identifier={identifier_value}",
            headers=self.headers,
        )
        self.assertEqual(denied.status_code, 404)
        self.assertEqual(denied.get_json(), {"error": "Case identifier not found"})

        allowed = self.client.get(
            f"/api/case-identifiers/lookup?identifier={identifier_value}",
            headers=victim_headers,
        )
        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(allowed.get_json()["case"]["case_id"], case_id)

    def test_live_api_has_no_demo_state_stores(self):
        for attribute in (
            "cases",
            "documents",
            "document_analysis",
            "evidence_timelines",
            "outreach_campaigns",
            "lawyer_matches",
            "outreach_target_matches",
            "google_connections",
        ):
            self.assertFalse(hasattr(self.app_module, attribute), attribute)

    def test_case_ledger_api_slice(self):
        local_login = self.client.post("/api/auth/session-login", json={"email": "robert.local@laro"})
        self.assertEqual(local_login.status_code, 200)
        self.assertIn("token", local_login.get_json())

        created = self.client.post("/api/cases", json={
            "title": "CAK billing dispute",
            "description": "Invoices and decisions need review.",
            "legal_domain": "administrative_law",
            "parties": ["CAK"],
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]
        self.assertEqual([item["name"] for item in created.get_json()["parties"]], ["CAK"])

        context_update = self.client.patch(f"/api/cases/{case_id}", json={
            "court_or_institution": "Rechtbank Gelderland",
            "opposing_parties": ["CAK", "Incassobureau"],
            "parties": [
                {"name": "CAK", "party_type": "government_body", "role": "decision maker"},
                {"name": "Incassobureau", "party_type": "organization", "role": "counterparty"},
            ],
        }, headers=self.headers)
        self.assertEqual(context_update.status_code, 200)
        self.assertEqual(context_update.get_json()["court_or_institution"], "Rechtbank Gelderland")
        self.assertEqual([item["name"] for item in context_update.get_json()["parties"]], ["CAK", "Incassobureau"])

        identifier = self.client.post(f"/api/cases/{case_id}/identifiers", json={
            "identifier_type": "dossier_number",
            "identifier_value": "202020440",
            "source_party": "CAK",
            "source_type": "google_drive",
        }, headers=self.headers)
        self.assertEqual(identifier.status_code, 201)

        self.assertEqual(identifier.get_json()["identifier_value"], "202020440")

        identifiers = self.client.get(f"/api/cases/{case_id}/identifiers", headers=self.headers)
        self.assertEqual(identifiers.status_code, 200)
        self.assertEqual(identifiers.get_json()["count"], 1)

        identifier_lookup = self.client.get(
            "/api/case-identifiers/lookup?identifier=202020440&type=dossier_number",
            headers=self.headers,
        )
        self.assertEqual(identifier_lookup.status_code, 200)
        self.assertEqual(identifier_lookup.get_json()["case"]["case_id"], case_id)

        document = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "CAK decision",
            "document_type": "decision",
            "extracted_text": "Decision dated 2024-04-01.",
        }, headers=self.headers)
        self.assertEqual(document.status_code, 201)
        document_id = document.get_json()["document_id"]

        event = self.client.post(f"/api/cases/{case_id}/timeline", json={
            "event_date": "2024-04-01",
            "title": "CAK issued decision",
            "created_from_document_id": document_id,
            "description": "Decision received.",
        }, headers=self.headers)
        self.assertEqual(event.status_code, 201)
        claim = self.client.post(f"/api/cases/{case_id}/claims", json={
            "statement": "The CAK decision was received after the stated deadline.",
            "status": "needs_review",
        }, headers=self.headers)
        self.assertEqual(claim.status_code, 201)
        claim_id = claim.get_json()["id"]

        claim_review = self.client.patch(
            f"/api/cases/{case_id}/claims/{claim_id}",
            json={"action": "confirm"},
            headers=self.headers,
        )
        self.assertEqual(claim_review.status_code, 200)
        self.assertEqual(claim_review.get_json()["status"], "confirmed")

        evidence = self.client.post(f"/api/cases/{case_id}/evidence", json={
            "document_id": document_id,
            "target_type": "claim",
            "target_id": claim_id,
            "snippet": "Decision dated 2024-04-01.",
            "relationship": "supports",
        }, headers=self.headers)
        self.assertEqual(evidence.status_code, 201)
        evidence_id = evidence.get_json()["id"]

        evidence_review = self.client.patch(
            f"/api/cases/{case_id}/evidence/{evidence_id}",
            json={"action": "confirm"},
            headers=self.headers,
        )
        self.assertEqual(evidence_review.status_code, 200)
        self.assertTrue(evidence_review.get_json()["user_confirmed"])

        outreach = self.client.post(f"/api/cases/{case_id}/outreach", json={
            "lawyer_name": "Advocaat Test",
            "lawyer_email": "advocaat@example.com",
            "draft_body": "Draft only, do not send.",
        }, headers=self.headers)
        self.assertEqual(outreach.status_code, 201)
        self.assertEqual(outreach.get_json()["status"], "waiting_approval")

        draft = self.client.post(f"/api/cases/{case_id}/drafts", json={
            "draft_type": "formal_letter",
            "title": "Formal CAK objection",
            "body": "Draft only. Do not send externally without approval.",
        }, headers=self.headers)
        self.assertEqual(draft.status_code, 201)
        draft_payload = draft.get_json()
        self.assertEqual(draft_payload["status"], "waiting_approval")
        self.assertEqual(draft_payload["risk_level"], "high")
        self.assertIsNotNone(draft_payload["approval_id"])

        listed_drafts = self.client.get(f"/api/cases/{case_id}/drafts", headers=self.headers)
        self.assertEqual(listed_drafts.status_code, 200)
        self.assertEqual(listed_drafts.get_json()["count"], 1)
        self.assertEqual(listed_drafts.get_json()["drafts"][0]["id"], draft_payload["id"])

        command_center = self.client.get("/api/cases/command-center", headers=self.headers)
        self.assertEqual(command_center.status_code, 200)
        self.assertGreaterEqual(command_center.get_json()["counts"]["active_cases"], 1)
        self.assertIn("review_queues", command_center.get_json())
        self.assertGreaterEqual(command_center.get_json()["counts"]["pending_outreach_approval"], 1)

        command_alias = self.client.get("/api/command-center", headers=self.headers)
        dashboard_alias = self.client.get("/api/dashboard/command-center", headers=self.headers)
        self.assertEqual(command_alias.status_code, 200)
        self.assertEqual(dashboard_alias.status_code, 200)
        self.assertEqual(command_alias.get_json()["counts"]["active_cases"], command_center.get_json()["counts"]["active_cases"])
        self.assertIn("urgent_deadlines", dashboard_alias.get_json()["counts"])

        operating_state = self.client.get(f"/api/cases/{case_id}/operating-state", headers=self.headers)
        self.assertEqual(operating_state.status_code, 200)
        operating_payload = operating_state.get_json()
        self.assertIn("primary_action", operating_payload)
        self.assertIn("readiness", operating_payload)
        self.assertTrue(operating_payload["safety"]["external_actions_blocked_without_approval"])

        review_queue = self.client.get(f"/api/cases/{case_id}/review-queue", headers=self.headers)
        self.assertEqual(review_queue.status_code, 200)
        review_payload = review_queue.get_json()
        self.assertEqual(review_payload["case_id"], case_id)
        self.assertGreaterEqual(review_payload["count"], 1)
        self.assertTrue(any(item["queue_type"] == "approval" and item["item_id"] for item in review_payload["items"]))

        approvals = self.client.get("/api/approvals?status=pending", headers=self.headers)
        self.assertEqual(approvals.status_code, 200)
        self.assertGreaterEqual(approvals.get_json()["count"], 1)
        approval_id = outreach.get_json()["approval_id"]

        resolved = self.client.patch(f"/api/approvals/{approval_id}", json={"status": "approved"}, headers=self.headers)
        self.assertEqual(resolved.status_code, 200)
        self.assertEqual(resolved.get_json()["status"], "approved")

        resolved_draft = self.client.patch(f"/api/approvals/{draft_payload['approval_id']}", json={"status": "approved"}, headers=self.headers)
        self.assertEqual(resolved_draft.status_code, 200)
        fetched_draft = self.client.get(f"/api/cases/{case_id}/drafts/{draft_payload['id']}", headers=self.headers)
        self.assertEqual(fetched_draft.status_code, 200)
        self.assertEqual(fetched_draft.get_json()["status"], "approved_for_external_use")

        outreach_list = self.client.get(f"/api/cases/{case_id}/outreach", headers=self.headers)
        self.assertEqual(outreach_list.status_code, 200)
        self.assertEqual(outreach_list.get_json()["outreach"][0]["status"], "approved_to_send")
        outreach_id = outreach.get_json()["id"]

        recorded_response = self.client.post(
            f"/api/cases/{case_id}/outreach/{outreach_id}/responses",
            json={
                "response_type": "more_information_needed",
                "content": "Please send the timeline and documents first.",
                "received_at": "2026-07-01T10:30:00Z",
            },
            headers=self.headers,
        )
        self.assertEqual(recorded_response.status_code, 201)
        self.assertEqual(recorded_response.get_json()["response_type"], "more_info")

        response_list = self.client.get(f"/api/cases/{case_id}/outreach/responses", headers=self.headers)
        self.assertEqual(response_list.status_code, 200)
        self.assertEqual(response_list.get_json()["count"], 1)
        self.assertEqual(response_list.get_json()["responses"][0]["lawyer_email"], "advocaat@example.com")

        status = self.client.get(f"/api/outreach/{case_id}/status", headers=self.headers)
        self.assertEqual(status.status_code, 200)
        self.assertEqual(status.get_json()["statistics"]["responses_received"], 1)
        self.assertEqual(status.get_json()["statistics"]["more_info_requests"], 1)

        analytics = self.client.get(f"/api/outreach/{case_id}/analytics", headers=self.headers)
        self.assertEqual(analytics.status_code, 200)
        self.assertEqual(analytics.get_json()["responses_received"], 1)
        self.assertEqual(analytics.get_json()["categories"]["lawyers"]["responded"], 1)

        graph = self.client.get(f"/api/cases/{case_id}/papertrail", headers=self.headers)
        self.assertEqual(graph.status_code, 200)
        self.assertTrue(graph.get_json()["nodes"])
        self.assertTrue(graph.get_json()["edges"])
        party_nodes = [node["label"] for node in graph.get_json()["nodes"] if node["type"] == "party"]
        self.assertEqual(party_nodes, ["CAK", "Incassobureau"])
        identifier_nodes = [node["label"] for node in graph.get_json()["nodes"] if node["type"] == "identifier"]
        self.assertEqual(identifier_nodes, ["202020440"])
        draft_nodes = [node for node in graph.get_json()["nodes"] if node["type"] == "draft"]
        self.assertEqual(draft_nodes[0]["id"], f"draft:{draft_payload['id']}")
        self.assertEqual(draft_nodes[0]["status"], "approved_for_external_use")

        missing = self.client.get(f"/api/cases/{case_id}/missing-evidence", headers=self.headers)
        self.assertEqual(missing.status_code, 200)
        self.assertIn("missing_evidence", missing.get_json())

        summary = self.client.get(f"/api/cases/{case_id}/summary", headers=self.headers)
        self.assertEqual(summary.status_code, 200)
        self.assertIn("risk_review", summary.get_json())

        red_line = self.client.get(f"/api/cases/{case_id}/red-line", headers=self.headers)
        self.assertEqual(red_line.status_code, 200)
        self.assertIn("Chronology:", red_line.get_json()["body"])

        bundle = self.client.get(f"/api/cases/{case_id}/bundle", headers=self.headers)
        self.assertEqual(bundle.status_code, 200)
        self.assertTrue(bundle.get_json()["external_sharing_requires_approval"])
        self.assertEqual(bundle.get_json()["share_status"], "internal_only_until_approved")
        self.assertEqual(bundle.get_json()["drafts"][0]["id"], draft_payload["id"])

    def test_position_matrix_api_requires_explicit_claim_evidence_classification(self):
        created = self.client.post("/api/cases", json={"title": "Position matrix API case"}, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]
        document = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "Counterparty letter",
            "extracted_text": "CAK states that no payment was received.",
        }, headers=self.headers)
        self.assertEqual(document.status_code, 201)
        claim = self.client.post(f"/api/cases/{case_id}/claims", json={
            "statement": "No payment was received.",
            "asserted_by": "CAK",
            "position_role": "counterparty",
            "subject_party": "Robert",
            "claim_type": "allegation",
            "materiality": "critical",
        }, headers=self.headers)
        self.assertEqual(claim.status_code, 201)
        self.assertEqual(claim.get_json()["position_role"], "counterparty")
        link = self.client.post(f"/api/cases/{case_id}/evidence", json={
            "document_id": document.get_json()["document_id"],
            "target_type": "claim",
            "target_id": claim.get_json()["id"],
            "relationship": "suggests_claim",
            "snippet": "CAK states that no payment was received.",
        }, headers=self.headers)
        self.assertEqual(link.status_code, 201)

        unsafe_confirmation = self.client.patch(
            f"/api/cases/{case_id}/evidence/{link.get_json()['id']}",
            json={"action": "confirm"},
            headers=self.headers,
        )
        self.assertEqual(unsafe_confirmation.status_code, 400)
        self.assertIn("supports, disputes, or contextualizes", unsafe_confirmation.get_json()["error"])
        classified = self.client.patch(
            f"/api/cases/{case_id}/evidence/{link.get_json()['id']}",
            json={"action": "confirm", "relationship": "disputes"},
            headers=self.headers,
        )
        self.assertEqual(classified.status_code, 200)
        self.assertEqual(classified.get_json()["relationship"], "disputes")

        matrix = self.client.get(f"/api/cases/{case_id}/positions", headers=self.headers)
        self.assertEqual(matrix.status_code, 200)
        payload = matrix.get_json()
        self.assertEqual(payload["counts"]["disputed"], 1)
        self.assertEqual(payload["groups"][0]["asserted_by"], "CAK")
        self.assertEqual(payload["groups"][0]["claims"][0]["materiality"], "critical")
        self.assertTrue(payload["legal_safety"]["claim_review_does_not_establish_truth"])

    def test_obligation_api_links_source_and_requires_explicit_review(self):
        created = self.client.post("/api/cases", json={
            "title": "API obligation case",
            "description": "A source-linked duty needs review.",
            "parties": [{"name": "CAK", "role": "decision maker"}],
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]
        document = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "CAK information request",
            "extracted_text": "Robert must provide the bank statement by 2026-08-14.",
        }, headers=self.headers)
        self.assertEqual(document.status_code, 201)
        document_id = document.get_json()["document_id"]

        missing_quote = self.client.post(f"/api/cases/{case_id}/obligations", json={
            "title": "Unquoted duty",
            "description": "A paraphrase must not be stored as a source quote.",
            "source_document_id": document_id,
        }, headers=self.headers)
        self.assertEqual(missing_quote.status_code, 400)
        self.assertIn("source_quote", missing_quote.get_json()["error"])

        response = self.client.post(f"/api/cases/{case_id}/obligations", json={
            "title": "Provide bank statement",
            "description": "Robert must provide the bank statement.",
            "responsible_party": "Robert",
            "beneficiary_party": "CAK",
            "due_date": "2026-08-14",
            "source_document_id": document_id,
            "source_quote": "Robert must provide the bank statement by 2026-08-14.",
            "status": "needs_review",
        }, headers=self.headers)
        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        obligation_id = payload["id"]
        self.assertEqual(payload["status"], "needs_review")
        self.assertFalse(payload["user_confirmed"])
        self.assertEqual(payload["evidence_link"]["target_type"], "obligation")

        listed = self.client.get(f"/api/cases/{case_id}/obligations", headers=self.headers)
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.get_json()["obligations"][0]["source_document_id"], document_id)

        queue = self.client.get(f"/api/cases/{case_id}/review-queue", headers=self.headers).get_json()
        self.assertTrue(any(item["queue_type"] == "obligation" and item["item_id"] == obligation_id for item in queue["items"]))
        graph = self.client.get(f"/api/cases/{case_id}/papertrail", headers=self.headers).get_json()
        self.assertTrue(any(node["id"] == f"obligation:{obligation_id}" for node in graph["nodes"]))
        self.assertEqual(sum(edge["to"] == f"obligation:{obligation_id}" and edge["type"] == "states_obligation" for edge in graph["edges"]), 1)

        confirmed = self.client.patch(f"/api/cases/{case_id}/obligations/{obligation_id}", json={
            "action": "confirm",
            "responsible_party": "Robert",
        }, headers=self.headers)
        self.assertEqual(confirmed.status_code, 200)
        self.assertTrue(confirmed.get_json()["user_confirmed"])
        self.assertEqual(confirmed.get_json()["status"], "confirmed")
        confirmed_evidence = self.client.get(f"/api/cases/{case_id}/evidence", headers=self.headers).get_json()["evidence_links"]
        obligation_link = next(item for item in confirmed_evidence if item["target_type"] == "obligation" and item["target_id"] == obligation_id)
        self.assertTrue(obligation_link["user_confirmed"])

        reopened = self.client.patch(f"/api/cases/{case_id}/obligations/{obligation_id}", json={"action": "reopen"}, headers=self.headers)
        self.assertEqual(reopened.status_code, 200)
        self.assertEqual(reopened.get_json()["status"], "needs_review")
        reopened_evidence = self.client.get(f"/api/cases/{case_id}/evidence", headers=self.headers).get_json()["evidence_links"]
        reopened_link = next(item for item in reopened_evidence if item["target_type"] == "obligation" and item["target_id"] == obligation_id)
        self.assertFalse(reopened_link["user_confirmed"])
        self.assertEqual(reopened_link["relationship"], "states_obligation")
        dismissed = self.client.patch(f"/api/cases/{case_id}/obligations/{obligation_id}", json={"action": "dismiss"}, headers=self.headers)
        self.assertEqual(dismissed.status_code, 200)
        self.assertEqual(dismissed.get_json()["status"], "dismissed")
        dismissed_evidence = self.client.get(f"/api/cases/{case_id}/evidence", headers=self.headers).get_json()["evidence_links"]
        dismissed_link = next(item for item in dismissed_evidence if item["target_type"] == "obligation" and item["target_id"] == obligation_id)
        self.assertEqual(dismissed_link["relationship"], "rejected_suggestion")

        audit = self.client.get(f"/api/audit?case_id={case_id}", headers=self.headers).get_json()["audit_events"]
        obligation_actions = [item["action"] for item in audit if item["entity_type"] == "Obligation"]
        self.assertEqual(obligation_actions, ["dismissed", "reopened", "confirmed", "created"])

    def test_extracted_obligation_prefers_explicit_due_marker_over_document_date(self):
        created = self.client.post("/api/cases", json={
            "title": "Obligation date inference",
            "description": "Document date and duty date must stay distinct.",
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]
        source_text = "In its decision dated 2026-07-10, CAK stated Robert must provide the bank statement by 2026-08-14."
        document = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "CAK dated request",
            "extracted_text": source_text,
            "analyze": True,
        }, headers=self.headers)
        self.assertEqual(document.status_code, 201)
        obligations = document.get_json()["obligation_suggestions"]
        self.assertEqual(len(obligations), 1)
        self.assertEqual(obligations[0]["due_date"], "2026-08-14")
        self.assertEqual(obligations[0]["source_quote"], source_text)

        ambiguous = self.app_module._obligation_due_date(
            "The letter dated 2026-07-10 discusses a meeting on 2026-08-14.",
            {"dates": [
                {"raw": "2026-07-10", "normalized": "2026-07-10", "context": "The letter dated 2026-07-10 discusses a meeting on 2026-08-14."},
                {"raw": "2026-08-14", "normalized": "2026-08-14", "context": "The letter dated 2026-07-10 discusses a meeting on 2026-08-14."},
            ]},
        )
        self.assertEqual(ambiguous, "")

    def test_local_session_bootstrap_is_limited_to_loopback_owner(self):
        original_owner = self.app_module.app.config.get("LARO_LOCAL_ACCOUNT_EMAIL")
        self.app_module.app.config["LARO_LOCAL_ACCOUNT_EMAIL"] = "owner@laro.test"
        try:
            owner = self.client.post("/api/auth/session-login", json={"email": "owner@laro.test"})
            self.assertEqual(owner.status_code, 200)
            self.assertEqual(owner.get_json()["email"], "owner@laro.test")
            self.assertIn("token", owner.get_json())

            impersonation = self.client.post("/api/auth/session-login", json={"email": "other@laro.test"})
            self.assertEqual(impersonation.status_code, 403)
            self.assertNotIn("token", impersonation.get_json())

            remote = self.client.post(
                "/api/auth/session-login",
                json={"email": "owner@laro.test"},
                environ_overrides={"REMOTE_ADDR": "192.0.2.55"},
            )
            self.assertEqual(remote.status_code, 403)
            self.assertNotIn("token", remote.get_json())

            spoofed = self.client.post(
                "/api/auth/session-login",
                json={"email": "owner@laro.test"},
                environ_overrides={"REMOTE_ADDR": "192.0.2.55"},
                headers={"X-Forwarded-For": "127.0.0.1"},
            )
            self.assertEqual(spoofed.status_code, 403)
            self.assertNotIn("token", spoofed.get_json())
        finally:
            self.app_module.app.config["LARO_LOCAL_ACCOUNT_EMAIL"] = original_owner

    def test_local_runtime_helpers_only_accept_loopback_hosts(self):
        self.assertTrue(self.app_module._is_loopback_host("127.0.0.1"))
        self.assertTrue(self.app_module._is_loopback_host("::1"))
        self.assertTrue(self.app_module._is_loopback_host("localhost"))
        self.assertFalse(self.app_module._is_loopback_host("0.0.0.0"))
        self.assertFalse(self.app_module._is_loopback_host("192.0.2.55"))

    def test_legacy_case_endpoints_are_ledger_backed(self):
        created = self.client.post("/api/cases", json={
            "title": "Legacy compatible ledger case",
            "description": "Older callers should still receive durable case data.",
            "legal_domain": "administrative_law",
            "desired_outcome": "Correct the decision",
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]

        document = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "Source decision",
            "document_type": "decision",
            "extracted_text": "Decision text for durable legacy endpoint test.",
        }, headers=self.headers)
        self.assertEqual(document.status_code, 201)

        event = self.client.post(f"/api/cases/{case_id}/timeline", json={
            "event_date": "2024-05-01",
            "title": "Decision received",
            "description": "The source decision was received.",
            "created_from_document_id": document.get_json()["document_id"],
        }, headers=self.headers)
        self.assertEqual(event.status_code, 201)

        legacy_list = self.client.get("/api/user/cases", headers=self.headers)
        self.assertEqual(legacy_list.status_code, 200)
        legacy_cases = legacy_list.get_json()["cases"]
        legacy_case = next(item for item in legacy_cases if item["case_id"] == case_id)
        self.assertEqual(legacy_case["title"], "Legacy compatible ledger case")
        self.assertEqual(legacy_case["documents_count"], 1)
        self.assertEqual(legacy_case["timeline_count"], 1)

        legacy_detail = self.client.get(f"/api/case/{case_id}", headers=self.headers)
        self.assertEqual(legacy_detail.status_code, 200)
        self.assertEqual(legacy_detail.get_json()["case_id"], case_id)
        self.assertEqual(legacy_detail.get_json()["documents_count"], 1)

    def test_legacy_document_endpoints_are_ledger_backed(self):
        created = self.client.post("/api/cases", json={
            "title": "Legacy document compatibility case",
            "description": "Documents, analysis, and timeline should survive cache clears.",
            "legal_domain": "administrative_law",
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]

        pasted = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "Pasted decision with analysis",
            "document_type": "manual_note",
            "extracted_text": (
                "Decision dated 2024-05-01. CAK stated Robert must pay 125 euro. "
                "Objection deadline 2024-05-15."
            ),
            "analyze": True,
        }, headers=self.headers)
        self.assertEqual(pasted.status_code, 201)
        document_id = pasted.get_json()["document"]["document_id"]

        documents = self.client.get(f"/api/documents/{case_id}", headers=self.headers)
        self.assertEqual(documents.status_code, 200)
        self.assertEqual(documents.get_json()["documents"][0]["document_id"], document_id)
        self.assertEqual(
            documents.get_json()["documents"][0]["metadata"]["legal_analysis"]["document_type"],
            "decision",
        )

        analysis = self.client.get(f"/api/documents/{case_id}/analysis", headers=self.headers)
        self.assertEqual(analysis.status_code, 200)
        self.assertEqual(analysis.get_json()["document_count"], 1)
        analysis_map = analysis.get_json()["analysis"]
        self.assertIn(str(document_id), {str(key) for key in analysis_map.keys()})
        document_analysis = analysis_map[str(document_id)]
        self.assertEqual(document_analysis["document"]["document_id"], document_id)
        self.assertTrue(document_analysis["document"]["has_extracted_text"])
        self.assertIn("source_links", document_analysis)
        self.assertIn("timeline_events", document_analysis)
        self.assertGreaterEqual(document_analysis["reading_status"]["timeline_events"], 1)
        self.assertTrue(document_analysis["legal_safety"]["requires_human_review"])

        timeline = self.client.get(f"/api/documents/{case_id}/timeline", headers=self.headers)
        self.assertEqual(timeline.status_code, 200)
        self.assertGreaterEqual(timeline.get_json()["event_count"], 1)
        self.assertEqual(timeline.get_json()["storage"], "legal_ledger")
        self.assertTrue(timeline.get_json()["source_linked_timeline"])
        self.assertTrue(
            any(item["created_from_document_id"] == document_id for item in timeline.get_json()["timeline"])
        )
        self.assertTrue(
            any(item["source"]["document_id"] == document_id for item in timeline.get_json()["source_linked_timeline"])
        )

    def test_case_analysis_creates_ledger_case(self):
        with mock.patch.object(self.app_module.case_matcher, "match_legal_fields", return_value=["administrative_law"]), \
             mock.patch.object(self.app_module.case_matcher, "analyze_case_complexity", return_value={"complexity_level": "High"}), \
             mock.patch.object(self.app_module.case_matcher, "generate_case_summary", return_value="Decision dispute summary."), \
             mock.patch.object(self.app_module, "publish_event") as publish_event, \
             mock.patch.object(self.app_module.timeseries_manager, "record_case_event"):
            response = self.client.post("/api/case/analyze", json={
                "case_description": "The government decision and billing history need reconstruction.",
                "title": "Analysis-created durable case",
            }, headers=self.headers)

        self.assertEqual(response.status_code, 201)
        case_id = response.get_json()["case_id"]
        publish_event.assert_called_once()

        stored = self.client.get(f"/api/cases/{case_id}", headers=self.headers)
        self.assertEqual(stored.status_code, 200)
        self.assertEqual(stored.get_json()["title"], "Analysis-created durable case")
        self.assertEqual(stored.get_json()["legal_domain"], "administrative_law")

        legacy_list = self.client.get("/api/user/cases", headers=self.headers)
        self.assertEqual(legacy_list.status_code, 200)
        returned_case_ids = [item["case_id"] for item in legacy_list.get_json()["cases"]]
        self.assertIn(case_id, returned_case_ids)

        share_approval = self.client.post(
            f"/api/cases/{case_id}/bundle/share-approval",
            json={"reason": "Prepare for lawyer review."},
            headers=self.headers,
        )
        self.assertEqual(share_approval.status_code, 201)
        share_payload = share_approval.get_json()
        self.assertEqual(share_payload["entity_type"], "CaseBundle")
        self.assertEqual(share_payload["action"], "share_case_bundle_externally")
        self.assertEqual(share_payload["status"], "pending")

        duplicate_share_approval = self.client.post(
            f"/api/cases/{case_id}/bundle/share-approval",
            json={"reason": "Duplicate request should return pending approval."},
            headers=self.headers,
        )
        self.assertEqual(duplicate_share_approval.status_code, 201)
        self.assertEqual(duplicate_share_approval.get_json()["id"], share_payload["id"])

        pending_bundle = self.client.get(f"/api/cases/{case_id}/bundle", headers=self.headers)
        self.assertEqual(pending_bundle.status_code, 200)
        self.assertEqual(pending_bundle.get_json()["share_status"], "external_share_approval_pending")
        self.assertFalse(pending_bundle.get_json()["external_sharing_allowed"])

        resolved_share = self.client.patch(
            f"/api/approvals/{share_payload['id']}",
            json={"status": "approved"},
            headers=self.headers,
        )
        self.assertEqual(resolved_share.status_code, 200)
        approved_bundle = self.client.get(f"/api/cases/{case_id}/bundle", headers=self.headers)
        self.assertEqual(approved_bundle.get_json()["share_status"], "external_share_approved")
        self.assertTrue(approved_bundle.get_json()["external_sharing_allowed"])

    def test_case_bundle_download_requires_current_approval_and_is_audited(self):
        created = self.client.post("/api/cases", json={
            "title": "Bundle export case",
            "description": "A source-linked case bundle must be reviewable before export.",
            "legal_domain": "administrative_law",
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]
        self.ledger.add_document(case_id, {
            "original_filename": "decision.txt",
            "mime_type": "text/plain",
            "extracted_text": "The authority issued its decision on 12 March 2026.",
            "source_uri": "https://drive.google.com/file/d/source-document/view",
            "source_provider": "google_drive",
        }, actor="ledger@example.com")

        blocked = self.client.get(f"/api/cases/{case_id}/bundle/download", headers=self.headers)
        self.assertEqual(blocked.status_code, 409)
        self.assertFalse(blocked.get_json()["external_sharing_allowed"])

        requested = self.client.post(
            f"/api/cases/{case_id}/bundle/share-approval",
            json={"reason": "Send the reviewed bundle to counsel."},
            headers=self.headers,
        )
        self.assertEqual(requested.status_code, 201)
        approval_id = requested.get_json()["id"]
        approved = self.client.patch(
            f"/api/approvals/{approval_id}",
            json={"status": "approved"},
            headers=self.headers,
        )
        self.assertEqual(approved.status_code, 200)

        downloaded = self.client.get(f"/api/cases/{case_id}/bundle/download", headers=self.headers)
        self.assertEqual(downloaded.status_code, 200)
        self.assertEqual(downloaded.mimetype, "application/zip")
        self.assertEqual(downloaded.headers["X-LARO-Approval-Id"], str(approval_id))
        with zipfile.ZipFile(io.BytesIO(downloaded.data)) as archive:
            archive_names = archive.namelist()
            self.assertIn("manifest.json", archive_names)
            extracted_name = next(
                name for name in archive_names
                if name.startswith("documents/") and name.endswith("_decision_extracted.txt")
            )
            self.assertIn("issued its decision", archive.read(extracted_name).decode("utf-8"))
            manifest = json.loads(archive.read("manifest.json"))
        self.assertEqual(manifest["approval_id"], approval_id)
        self.assertEqual(
            manifest["bundle_snapshot_hash"],
            downloaded.headers["X-LARO-Snapshot-SHA256"],
        )

        audit = self.client.get(f"/api/audit?case_id={case_id}", headers=self.headers)
        self.assertEqual(audit.status_code, 200)
        export_records = [
            item for item in audit.get_json()["audit_events"]
            if item["action"] == "case_bundle_exported"
        ]
        self.assertTrue(export_records)
        self.assertEqual(export_records[0]["approval_id"], approval_id)

        changed = self.client.patch(
            f"/api/cases/{case_id}",
            json={"current_summary": "The source set changed after approval."},
            headers=self.headers,
        )
        self.assertEqual(changed.status_code, 200)
        stale = self.client.get(f"/api/cases/{case_id}/bundle/download", headers=self.headers)
        self.assertEqual(stale.status_code, 409)
        self.assertTrue(stale.get_json()["approval_stale"])

    def test_legacy_outreach_start_creates_approval_gated_drafts_without_sending(self):
        created = self.client.post("/api/cases", json={
            "title": "Legacy outreach safety case",
            "description": "CAK decision and objection deadline need legal review.",
            "legal_domain": "ADMINISTRATIVE_LAW",
            "current_summary": "Robert needs help objecting to a CAK administrative decision.",
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]

        started = self.client.post("/api/outreach/start", json={
            "case_id": case_id,
            "legal_field": "ADMINISTRATIVE_LAW",
            "max_lawyers": 2,
            "postcode_or_city": "Amsterdam",
            "radius_km": 100,
            "candidate_lawyers": [
                {
                    "lawyer_id": 901,
                    "name": "Approval Gate Lawyer",
                    "email": "approval.gate@example-law.nl",
                    "city": "Amsterdam",
                    "distance_km": 8,
                    "legal_fields": ["ADMINISTRATIVE_LAW"],
                    "nova_rechtsgebieden": ["bestuursrecht", "bezwaar"],
                    "specialization_associations": ["VAR"],
                    "financed_legal_aid": True,
                    "response_rate": 0.6,
                    "acceptance_rate": 0.2,
                }
            ],
        }, headers=self.headers)
        self.assertEqual(started.status_code, 200)
        payload = started.get_json()

        self.assertTrue(payload["approval_required"])
        self.assertEqual(payload["external_messages_sent"], 0)
        self.assertEqual(payload["status"], "waiting_approval")
        self.assertGreaterEqual(payload["draft_count"], 1)
        self.assertEqual(payload["outreach_count"], payload["draft_count"])
        outreach_list = self.client.get(f"/api/cases/{case_id}/outreach", headers=self.headers)
        self.assertEqual(outreach_list.status_code, 200)
        outreach_records = outreach_list.get_json()["outreach"]
        self.assertEqual(len(outreach_records), payload["draft_count"])
        self.assertTrue(all(item["status"] == "waiting_approval" for item in outreach_records))

        approvals = self.client.get(f"/api/approvals?case_id={case_id}&status=pending", headers=self.headers)
        self.assertEqual(approvals.status_code, 200)
        approval_payload = approvals.get_json()
        self.assertEqual(approval_payload["count"], payload["draft_count"])
        self.assertTrue(all(item["action"] == "send_external_legal_email" for item in approval_payload["approvals"]))
        self.assertTrue(all(item["risk_level"] == "high" for item in approval_payload["approvals"]))

        status = self.client.get(f"/api/outreach/{case_id}/status", headers=self.headers)
        self.assertEqual(status.status_code, 200)
        status_payload = status.get_json()
        self.assertTrue(status_payload["approval_required"])
        self.assertEqual(status_payload["external_messages_sent"], 0)
        self.assertEqual(status_payload["statistics"]["waiting_approval"], payload["draft_count"])

        persisted_lawyer_matches = self.client.get(f"/api/lawyers/{case_id}/matches", headers=self.headers)
        self.assertEqual(persisted_lawyer_matches.status_code, 200)
        self.assertEqual(
            persisted_lawyer_matches.get_json()["matched_lawyers"][0]["name"],
            "Approval Gate Lawyer",
        )

        follow_up = self.client.post(f"/api/outreach/{case_id}/follow-up", headers=self.headers)
        self.assertEqual(follow_up.status_code, 409)
        self.assertEqual(follow_up.get_json()["follow_ups_sent"], 0)
        self.assertEqual(follow_up.get_json()["external_messages_sent"], 0)
        self.assertTrue(follow_up.get_json()["approval_required"])

    def test_legacy_matching_search_billing_and_analytics_use_persisted_cases(self):
        created = self.client.post("/api/cases", json={
            "title": "Persisted compatibility case",
            "description": "Administrative CAK objection with proof of payment and deadline evidence.",
            "legal_domain": "ADMINISTRATIVE_LAW",
            "desired_outcome": "Prepare objection and find a lawyer.",
            "court_or_institution": "CAK",
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]

        document = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "CAK payment proof",
            "extracted_text": "CAK stated Robert must pay 125 euro. Payment proof was requested.",
        }, headers=self.headers)
        self.assertEqual(document.status_code, 201)

        taxonomy = self.client.get("/api/lawyers/taxonomy", headers=self.headers)
        self.assertEqual(taxonomy.status_code, 200)
        self.assertEqual(taxonomy.get_json()["registered_area_count"], 35)
        self.assertTrue(any(item["key"] == "ADMINISTRATIVE_LAW" for item in taxonomy.get_json()["areas"]))

        lawyers = self.client.post("/api/lawyers/match", json={
            "case_id": case_id,
            "max_results": 2,
            "candidate_lawyers": [
                {
                    "lawyer_id": "admin-1",
                    "name": "Persisted Case Lawyer",
                    "email": "persisted.case@example-law.nl",
                    "legal_fields": ["ADMINISTRATIVE_LAW"],
                    "nova_rechtsgebieden": ["bestuursrecht", "bezwaar"],
                    "city": "Amsterdam",
                    "financed_legal_aid": True,
                }
            ],
        }, headers=self.headers)
        self.assertEqual(lawyers.status_code, 200)
        lawyer_payload = lawyers.get_json()
        self.assertEqual(lawyer_payload["matched_lawyers"][0]["name"], "Persisted Case Lawyer")
        self.assertIn("ADMINISTRATIVE_LAW", lawyer_payload["case_profile"]["selected_legal_fields"])
        self.assertEqual(lawyer_payload["case_profile"]["source_coverage"]["documents"], 1)
        self.assertFalse(lawyer_payload["case_profile"]["raw_case_text_shared_with_directory"])
        stored_lawyers = self.client.get(f"/api/lawyers/{case_id}/matches", headers=self.headers)
        self.assertEqual(stored_lawyers.status_code, 200)
        self.assertEqual(stored_lawyers.get_json()["matched_lawyers"][0]["name"], "Persisted Case Lawyer")

        media = self.client.post("/api/outreach/targets/match", json={
            "case_id": case_id,
            "target_type": "media",
            "candidate_targets": [
                {
                    "target_id": "radar-test",
                    "name": "Radar",
                    "target_type": "media",
                    "description": "Consumer program covering government and payment disputes.",
                    "legal_fields": ["ADMINISTRATIVE_LAW"],
                    "topics": ["consumer", "government"],
                }
            ],
        }, headers=self.headers)
        self.assertEqual(media.status_code, 200)
        self.assertEqual(media.get_json()["matched_targets"][0]["name"], "Radar")
        stored_media = self.client.get(f"/api/outreach/{case_id}/targets/media", headers=self.headers)
        self.assertEqual(stored_media.status_code, 200)
        self.assertEqual(stored_media.get_json()["matched_targets"][0]["name"], "Radar")

        restarted_lawyers = self.client.get(f"/api/lawyers/{case_id}/matches", headers=self.headers)
        self.assertEqual(restarted_lawyers.status_code, 200)
        self.assertEqual(restarted_lawyers.get_json()["matched_lawyers"][0]["name"], "Persisted Case Lawyer")

        restarted_media = self.client.get(f"/api/outreach/{case_id}/targets/media", headers=self.headers)
        self.assertEqual(restarted_media.status_code, 200)
        self.assertEqual(restarted_media.get_json()["matched_targets"][0]["name"], "Radar")

        outreach = self.client.post(f"/api/cases/{case_id}/outreach", json={
            "lawyer_name": "Persisted Case Lawyer",
            "lawyer_email": "persisted.case@example-law.nl",
            "legal_field": "ADMINISTRATIVE_LAW",
            "draft_body": "Draft only. Await approval.",
        }, headers=self.headers)
        self.assertEqual(outreach.status_code, 201)

        analytics = self.client.get(f"/api/outreach/{case_id}/analytics", headers=self.headers)
        self.assertEqual(analytics.status_code, 200)
        self.assertEqual(analytics.get_json()["total_outreaches"], 1)
        self.assertGreaterEqual(analytics.get_json()["matched_targets"], 2)

        billing = self.client.get(f"/api/billing/{case_id}", headers=self.headers)
        self.assertEqual(billing.status_code, 200)
        self.assertGreater(billing.get_json()["resource_usage"]["storage_bytes_used"], 0)

        search = self.client.get("/api/search?q=payment", headers=self.headers)
        self.assertEqual(search.status_code, 200)
        search_payload = search.get_json()
        self.assertTrue(any(item.get("case_id") == case_id for item in search_payload["results"]))
        self.assertTrue(any(
            item.get("result_type") == "document" and item.get("target") == "documents"
            for item in search_payload["results"]
        ))
        self.assertGreaterEqual(search_payload["facets"]["document"], 1)

    def test_api_matches_only_approved_outreach_directory_records(self):
        created = self.client.post("/api/cases", json={
            "title": "Directory matching case",
            "description": "Tenant needs help with a rent and maintenance dispute.",
            "legal_domain": "PROPERTY_LAW",
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]

        imported = self.client.post("/api/outreach/directory/import", json={"targets": [{
            "target_type": "organization",
            "name": "Tenant directory fixture",
            "subtype": "tenant advocacy",
            "topics": ["housing", "rent", "maintenance"],
            "legal_fields": ["PROPERTY_LAW"],
            "source_url": "https://example.test/tenant-directory",
            "contact_url": "https://example.test/tenant-directory/contact",
        }]}, headers=self.headers)
        self.assertEqual(imported.status_code, 201)
        target_id = imported.get_json()["targets"][0]["id"]

        before_review = self.client.post("/api/outreach/targets/match", json={
            "case_id": case_id,
            "target_type": "organization",
        }, headers=self.headers)
        self.assertEqual(before_review.status_code, 200)
        self.assertEqual(before_review.get_json()["source_mode"], "directory_required")
        self.assertEqual(before_review.get_json()["matched_targets"], [])

        approved = self.client.patch(
            f"/api/outreach/directory/targets/{target_id}",
            json={"action": "approve"},
            headers=self.headers,
        )
        self.assertEqual(approved.status_code, 200)
        self.assertEqual(approved.get_json()["status"], "approved")

        matched = self.client.post("/api/outreach/targets/match", json={
            "case_id": case_id,
            "target_type": "organization",
        }, headers=self.headers)
        self.assertEqual(matched.status_code, 200)
        self.assertEqual(matched.get_json()["source_mode"], "approved_directory")
        self.assertEqual(matched.get_json()["matched_targets"][0]["name"], "Tenant directory fixture")

    def test_api_discovery_requires_confirmation_and_keeps_targets_in_review(self):
        missing_confirmation = self.client.post("/api/outreach/directory/discover", json={
            "target_type": "organization",
            "query": "Dutch tenant support organisations",
        }, headers=self.headers)
        self.assertEqual(missing_confirmation.status_code, 400)

        discovered_record = {
            "target_type": "organization",
            "name": "Discovered tenant support",
            "subtype": "organization discovery candidate",
            "description": "Public search snippet",
            "topics": [],
            "legal_fields": [],
            "channels": ["web"],
            "source_url": "https://example.test/discovered-tenant-support",
            "url": "https://example.test/discovered-tenant-support",
            "source_label": "DuckDuckGo public web search",
            "source_retrieved_at": "2026-07-10T12:00:00+00:00",
            "confidence": "discovery_candidate",
            "metadata": {"discovery_query": "Dutch tenant support organisations"},
        }
        discovery_payload = {
            "provider": "duckduckgo_html",
            "provider_label": "DuckDuckGo public web search",
            "query": "Dutch tenant support organisations",
            "retrieved_at": "2026-07-10T12:00:00+00:00",
            "candidates": [discovered_record],
            "result_count": 1,
            "search_url": "https://html.duckduckgo.com/html/?q=tenant",
        }
        with mock.patch.object(self.app_module.OutreachTargetDiscovery, "discover", return_value=discovery_payload):
            response = self.client.post("/api/outreach/directory/discover", json={
                "target_type": "organization",
                "query": "Dutch tenant support organisations",
                "confirm_external_search": True,
            }, headers=self.headers)

        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        self.assertEqual(payload["provider"], "duckduckgo_html")
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["targets"][0]["status"], "needs_review")
        self.assertEqual(self.ledger.list_outreach_directory_targets(status="approved"), [])
        audit_items = self.ledger.list_audit_events()
        discovery_audit = [item for item in audit_items if item["action"] == "discovered_for_review"]
        self.assertEqual(len(discovery_audit), 1)
        self.assertEqual(discovery_audit[0]["source"], "web_search")

    def test_case_aware_outreach_discovery_uses_derived_fields_and_audits_coverage(self):
        created = self.client.post("/api/cases", json={
            "title": "Private tenancy dispute",
            "description": "Confidential narrative must remain inside LARO.",
            "legal_domain": "PROPERTY_LAW",
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]

        missing_confirmation = self.client.post("/api/outreach/directory/discover-case", json={
            "case_id": case_id,
            "target_type": "organization",
        }, headers=self.headers)
        self.assertEqual(missing_confirmation.status_code, 400)

        discovery_payload = {
            "provider": "duckduckgo_html_multi_query",
            "provider_label": "DuckDuckGo public web search",
            "retrieved_at": "2026-07-13T10:00:00+00:00",
            "candidates": [{
                "target_type": "organization",
                "name": "Tenant support candidate",
                "subtype": "advocacy candidate",
                "description": "Tenant advocacy source",
                "topics": ["Huurrecht"],
                "legal_fields": ["PROPERTY_LAW"],
                "channels": ["web"],
                "source_url": "https://example.test/case-tenant-support",
                "url": "https://example.test/case-tenant-support",
                "source_label": "DuckDuckGo public web search",
                "source_retrieved_at": "2026-07-13T10:00:00+00:00",
                "confidence": "discovery_candidate",
                "metadata": {"safe_query_only": True, "raw_case_text_shared": False},
            }],
            "result_count": 1,
            "query_plan": [{
                "query": "Nederland Huurrecht belangenorganisatie vereniging",
                "pillar": "advocacy",
                "legal_field": "PROPERTY_LAW",
                "legal_area": "Huurrecht",
                "raw_case_text_shared": False,
            }],
            "coverage": {
                "planned_query_count": 1,
                "completed_query_count": 1,
                "failed_query_count": 0,
                "returned_candidate_count": 1,
                "unique_domain_count": 1,
                "legal_fields": ["PROPERTY_LAW"],
                "external_values_sent": ["Nederland Huurrecht belangenorganisatie vereniging"],
                "raw_case_text_shared": False,
                "completeness": "bounded_public_web_discovery_not_exhaustive",
            },
        }
        with mock.patch.object(
            self.app_module.OutreachTargetDiscovery,
            "discover_for_case",
            return_value=discovery_payload,
        ) as discover:
            response = self.client.post("/api/outreach/directory/discover-case", json={
                "case_id": case_id,
                "target_type": "organization",
                "limit": 40,
                "confirm_external_search": True,
            }, headers=self.headers)

        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["targets"][0]["status"], "needs_review")
        self.assertFalse(payload["case_profile"]["raw_case_text_shared"])
        self.assertIn("PROPERTY_LAW", discover.call_args.kwargs["legal_fields"])
        self.assertNotIn("Confidential narrative", str(discover.call_args))
        audit_items = self.ledger.list_audit_events()
        self.assertTrue(any(
            item["action"] == "case_discovered_for_review" and item["source"] == "case_web_search"
            for item in audit_items
        ))
        case_audit = self.ledger.list_audit_events(case_id)
        self.assertTrue(any(
            item["action"] == "outreach_directory_case_discovery"
            and item["after_state"].get("raw_case_text_shared") is False
            for item in case_audit
        ))

        with mock.patch.object(
            self.app_module.OutreachTargetDiscovery,
            "discover_for_case",
            side_effect=self.app_module.OutreachDiscoveryError("Public provider requested human verification"),
        ):
            blocked = self.client.post("/api/outreach/directory/discover-case", json={
                "case_id": case_id,
                "target_type": "media",
                "confirm_external_search": True,
            }, headers=self.headers)
        self.assertEqual(blocked.status_code, 400)
        self.assertIn("human verification", blocked.get_json()["error"])
        case_audit = self.ledger.list_audit_events(case_id)
        self.assertTrue(any(
            item["action"] == "outreach_directory_case_discovery_failed"
            and item["after_state"].get("raw_case_text_shared") is False
            for item in case_audit
        ))

    def test_upload_document_persists_extraction_and_timeline_suggestions(self):
        created = self.client.post("/api/cases", json={
            "title": "Upload evidence case",
            "description": "Testing local upload intake.",
            "legal_domain": "administrative_law",
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]

        upload = self.client.post(
            f"/api/cases/{case_id}/documents/upload",
            data={
                "file": (
                    io.BytesIO(b"Decision dated 2024-05-01. CAK stated Robert must pay 125 euro. Robert objected to the payment basis. Objection deadline 2024-05-15."),
                    "decision.txt",
                ),
                "title": "Decision upload",
            },
            content_type="multipart/form-data",
            headers=self.headers,
        )

        self.assertEqual(upload.status_code, 201)
        payload = upload.get_json()
        self.assertEqual(payload["document"]["title"], "Decision upload")
        self.assertIn("Decision dated", payload["document"]["extracted_text"])
        self.assertEqual(payload["document"]["source_type"], "manual_upload")
        self.assertTrue(payload["storage"]["content_hash"])
        self.assertTrue(payload["timeline_suggestions"])
        self.assertFalse(payload["timeline_suggestions"][0]["user_confirmed"])
        self.assertTrue(payload["deadline_suggestions"])
        self.assertTrue(payload["open_loop_suggestions"])
        self.assertTrue(payload["claim_suggestions"])
        self.assertEqual(payload["claim_suggestions"][0]["status"], "needs_review")
        self.assertEqual(payload["claim_suggestions"][0]["claim_type"], "document_statement")
        self.assertEqual(payload["claim_suggestions"][0]["asserted_by"], "document_intelligence")
        self.assertGreaterEqual(payload["evidence_links_created"], 4)
        target_types = {link["target_type"] for link in payload["evidence_links"]}
        self.assertIn("event", target_types)
        self.assertIn("claim", target_types)
        self.assertIn("deadline", target_types)
        self.assertIn("open_loop", target_types)
        self.assertTrue(any("Objection deadline" in link["snippet"] for link in payload["evidence_links"]))
        self.assertTrue(any("Robert must pay 125 euro" in link["snippet"] for link in payload["evidence_links"]))
        self.assertEqual(payload["deadline_suggestions"][0]["due_date"], "2024-05-15")
        self.assertEqual(payload["deadline_suggestions"][0]["status"], "needs_review")
        self.assertEqual(payload["deadline_suggestions"][0]["source_document_id"], payload["document"]["document_id"])
        suggestion_id = payload["timeline_suggestions"][0]["id"]

        approved = self.client.patch(f"/api/cases/{case_id}/timeline/{suggestion_id}", json={
            "action": "approve",
            "title": "Decision deadline reviewed",
            "description": "Robert reviewed and accepted the extracted event.",
        }, headers=self.headers)
        self.assertEqual(approved.status_code, 200)
        approved_payload = approved.get_json()
        self.assertTrue(approved_payload["user_confirmed"])
        self.assertEqual(approved_payload["review_status"], "confirmed")
        self.assertEqual(approved_payload["title"], "Decision deadline reviewed")

        documents = self.client.get(f"/api/cases/{case_id}/documents", headers=self.headers)
        self.assertEqual(documents.status_code, 200)
        self.assertEqual(len(documents.get_json()["documents"]), 1)

        document_id = payload["document"]["document_id"]
        document_detail = self.client.get(f"/api/cases/{case_id}/documents/{document_id}", headers=self.headers)
        self.assertEqual(document_detail.status_code, 200)
        self.assertTrue(document_detail.get_json()["can_open_file"])
        self.assertEqual(document_detail.get_json()["file_url"], f"/api/cases/{case_id}/documents/{document_id}/file")

        document_file = self.client.get(f"/api/cases/{case_id}/documents/{document_id}/file", headers=self.headers)
        self.assertEqual(document_file.status_code, 200)
        self.assertIn(b"Objection deadline 2024-05-15", document_file.data)
        document_file.close()

        timeline = self.client.get(f"/api/cases/{case_id}/timeline", headers=self.headers)
        self.assertEqual(timeline.status_code, 200)
        self.assertTrue(timeline.get_json()["timeline"])

        evidence = self.client.get(f"/api/cases/{case_id}/evidence", headers=self.headers)
        self.assertEqual(evidence.status_code, 200)
        evidence_payload = evidence.get_json()["evidence_links"]
        self.assertTrue(any(link["target_type"] == "deadline" for link in evidence_payload))
        self.assertTrue(any(link["target_type"] == "open_loop" for link in evidence_payload))
        self.assertTrue(any(link["target_type"] == "claim" for link in evidence_payload))

        claims = self.client.get(f"/api/cases/{case_id}/claims", headers=self.headers)
        self.assertEqual(claims.status_code, 200)
        claim_payload = claims.get_json()["claims"]
        self.assertTrue(any(claim["status"] == "needs_review" and "Robert must pay 125 euro" in claim["statement"] for claim in claim_payload))

        deadlines = self.client.get(f"/api/cases/{case_id}/deadlines", headers=self.headers)
        self.assertEqual(deadlines.status_code, 200)
        self.assertTrue(any(item["due_date"] == "2024-05-15" and item["requires_approval"] for item in deadlines.get_json()["deadlines"]))
        deadline_id = deadlines.get_json()["deadlines"][0]["id"]
        confirmed_deadline = self.client.patch(f"/api/cases/{case_id}/deadlines/{deadline_id}", json={"action": "confirm"}, headers=self.headers)
        self.assertEqual(confirmed_deadline.status_code, 200)
        self.assertEqual(confirmed_deadline.get_json()["status"], "confirmed")
        self.assertFalse(confirmed_deadline.get_json()["requires_approval"])

        loops = self.client.get(f"/api/cases/{case_id}/open-loops", headers=self.headers)
        self.assertEqual(loops.status_code, 200)
        self.assertTrue(any("objection" in item["description"].lower() for item in loops.get_json()["open_loops"]))
        loop_id = loops.get_json()["open_loops"][0]["id"]
        resolved_loop = self.client.patch(f"/api/cases/{case_id}/open-loops/{loop_id}", json={"action": "resolve"}, headers=self.headers)
        self.assertEqual(resolved_loop.status_code, 200)
        self.assertEqual(resolved_loop.get_json()["status"], "resolved")

        audit = self.client.get(f"/api/audit?case_id={case_id}", headers=self.headers)
        self.assertEqual(audit.status_code, 200)
        audit_actions = [item["action"] for item in audit.get_json()["audit_events"]]
        self.assertIn("confirmed", audit_actions)
        self.assertIn("resolved", audit_actions)

    def test_manual_text_document_can_run_document_intelligence(self):
        created = self.client.post("/api/cases", json={
            "title": "Pasted evidence case",
            "description": "Testing pasted legal text intake.",
            "legal_domain": "administrative_law",
            "court_or_institution": "CAK",
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]

        pasted = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "Pasted CAK decision",
            "document_type": "manual_note",
            "extracted_text": "Decision dated 2024-05-01. CAK stated Robert must pay 125 euro. Robert objected. Objection deadline 2024-05-15.",
            "analyze": True,
        }, headers=self.headers)

        self.assertEqual(pasted.status_code, 201)
        payload = pasted.get_json()
        self.assertEqual(payload["document"]["source_type"], "manual_text")
        self.assertEqual(payload["document"]["metadata"]["input_mode"], "pasted_text_fast_add")
        self.assertTrue(payload["timeline_suggestions"])
        self.assertTrue(payload["deadline_suggestions"])
        self.assertTrue(payload["open_loop_suggestions"])
        self.assertTrue(payload["claim_suggestions"])
        self.assertGreaterEqual(payload["evidence_links_created"], 4)
        self.assertEqual(payload["storage"]["content_hash"], payload["document"]["content_hash"])
        document_id = payload["document"]["document_id"]
        detail = self.client.get(f"/api/cases/{case_id}/documents/{document_id}", headers=self.headers)
        self.assertEqual(detail.status_code, 200)
        self.assertFalse(detail.get_json()["can_open_file"])
        self.assertIsNone(detail.get_json()["file_url"])

        timeline = self.client.get(f"/api/cases/{case_id}/timeline", headers=self.headers)
        self.assertTrue(any(item["created_from_document_id"] == document_id for item in timeline.get_json()["timeline"]))

    def test_case_comprehension_dossier_summarizes_source_linked_reading(self):
        created = self.client.post("/api/cases", json={
            "title": "CAK deep reading case",
            "description": "Testing case-level source comprehension.",
            "legal_domain": "administrative_law",
            "court_or_institution": "CAK",
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]

        pasted = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "CAK objection decision",
            "document_type": "decision",
            "extracted_text": (
                "Decision dated 2024-05-01. CAK stated Robert must pay 125 euro. "
                "Robert objected to the payment basis. Objection deadline 2024-05-15. "
                "CAK requested proof of payment."
            ),
            "analyze": True,
        }, headers=self.headers)
        self.assertEqual(pasted.status_code, 201)
        document_id = pasted.get_json()["document"]["document_id"]

        dossier = self.client.get(f"/api/cases/{case_id}/comprehension", headers=self.headers)
        self.assertEqual(dossier.status_code, 200)
        payload = dossier.get_json()
        self.assertEqual(payload["case_id"], case_id)
        self.assertEqual(payload["reading_status"]["documents_total"], 1)
        self.assertEqual(payload["reading_status"]["documents_readable"], 1)
        self.assertGreaterEqual(payload["reading_status"]["source_links"], 4)
        self.assertTrue(payload["legal_safety"]["facts_are_source_summaries"])
        self.assertTrue(payload["legal_safety"]["no_external_action_taken"])

        source = payload["source_documents"][0]
        self.assertEqual(source["document_id"], document_id)
        self.assertEqual(source["title"], "CAK objection decision")
        self.assertTrue(source["readable"])
        self.assertTrue(source["dates"])
        self.assertTrue(source["obligations"])

        self.assertTrue(payload["chronology"])
        first_event = payload["chronology"][0]
        self.assertEqual(first_event["source"]["document_id"], document_id)
        self.assertIn(first_event["review_status"], {"needs_review", "confirmed"})

        self.assertTrue(payload["positions"]["all"])
        self.assertFalse(any(item["supporting_sources"] for item in payload["positions"]["all"]))
        self.assertTrue(any(item["proposed_sources"] for item in payload["positions"]["all"]))
        self.assertTrue(any(item["target"] in {"timeline", "evidence", "claims", "review", "bundle"} for item in payload["next_actions"]))

    def test_document_aggregation_persists_comprehension_artifacts(self):
        created = self.client.post("/api/cases", json={
            "title": "Aggregated source case",
            "description": "Testing legacy aggregation into the ledger intelligence path.",
            "legal_domain": "administrative_law",
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]

        aggregate_path = os.path.join(self.tmp.name, "aggregated-cak-source.txt")
        with open(aggregate_path, "w", encoding="utf-8") as handle:
            handle.write(
                "Decision dated 2024-05-01. CAK stated Robert must pay 125 euro. "
                "Objection deadline 2024-05-15. CAK requested proof of payment."
            )

        aggregate = self.client.post("/api/documents/aggregate", json={
            "case_id": case_id,
            "source": "manual",
            "file_path": aggregate_path,
            "document_name": "Aggregated CAK decision.txt",
        }, headers=self.headers)

        self.assertEqual(aggregate.status_code, 200)
        payload = aggregate.get_json()
        self.assertEqual(payload["document_count"], 1)
        self.assertTrue(payload["persisted_documents"])
        self.assertTrue(payload["persisted_timeline"])
        self.assertTrue(payload["persisted_evidence_links"])
        self.assertTrue(payload["persisted_claims"])
        self.assertTrue(payload["persisted_deadlines"])
        self.assertEqual(payload["persisted_documents"][0]["metadata"]["legal_analysis"]["document_type"], "decision")
        self.assertEqual(payload["comprehension"]["reading_status"]["documents_readable"], 1)
        self.assertGreaterEqual(payload["comprehension"]["reading_status"]["source_links"], 4)
        dossier = self.client.get(f"/api/cases/{case_id}/comprehension", headers=self.headers)
        self.assertEqual(dossier.status_code, 200)
        self.assertTrue(dossier.get_json()["chronology"])
        self.assertFalse(any(item["supporting_sources"] for item in dossier.get_json()["positions"]["all"]))
        self.assertTrue(any(item["proposed_sources"] for item in dossier.get_json()["positions"]["all"]))

    def test_source_batch_import_reads_meta_tagged_gmail_and_drive_records(self):
        created = self.client.post("/api/cases", json={
            "title": "Meta tagged source case",
            "description": "Testing Gmail and Drive source import into comprehension.",
            "legal_domain": "administrative_law",
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]

        source_batch = {
            "source_type": "gmail",
            "meta_tag": "LARO:CAK",
            "documents": [
                {
                    "id": "gmail-msg-1",
                    "subject": "CAK objection deadline",
                    "from": "cak@example.nl",
                    "to": "robert@example.nl",
                    "plain_text": (
                        "Decision dated 2024-05-01. CAK stated Robert must pay 125 euro. "
                        "Objection deadline 2024-05-15."
                    ),
                    "labels": ["LARO:CAK"],
                },
                {
                    "source_type": "google_drive",
                    "file_id": "drive-file-1",
                    "name": "Proof request letter",
                    "web_view_link": "https://drive.example/drive-file-1",
                    "content": "Follow-up dated 2024-05-02. CAK requested proof of payment before 2024-05-20.",
                    "tags": ["LARO:CAK"],
                },
            ],
        }

        imported = self.client.post(
            f"/api/cases/{case_id}/documents/import-sources",
            json=source_batch,
            headers=self.headers,
        )

        self.assertEqual(imported.status_code, 201)
        payload = imported.get_json()
        self.assertEqual(payload["imported_count"], 2)
        self.assertEqual(payload["skipped_count"], 0)
        self.assertEqual(payload["meta_tag"], "LARO:CAK")
        self.assertGreaterEqual(payload["artifact_counts"]["timeline_suggestions"], 2)
        self.assertGreaterEqual(payload["artifact_counts"]["evidence_links"], 4)
        self.assertEqual(payload["comprehension"]["reading_status"]["documents_readable"], 2)
        documents = self.client.get(f"/api/cases/{case_id}/documents", headers=self.headers)
        source_uris = {item["source_uri"] for item in documents.get_json()["documents"]}
        self.assertIn("gmail://message/gmail-msg-1", source_uris)
        self.assertIn("https://drive.example/drive-file-1", source_uris)
        self.assertTrue(all(item["metadata"].get("legal_analysis") for item in documents.get_json()["documents"]))
        self.assertTrue(all(item["metadata"].get("meta_tag") == "LARO:CAK" for item in documents.get_json()["documents"]))

        duplicate = self.client.post(
            f"/api/cases/{case_id}/documents/import-sources",
            json=source_batch,
            headers=self.headers,
        )
        self.assertEqual(duplicate.status_code, 201)
        duplicate_payload = duplicate.get_json()
        self.assertEqual(duplicate_payload["imported_count"], 0)
        self.assertEqual(duplicate_payload["skipped_count"], 2)
        self.assertTrue(all(item["reason"] == "duplicate_source_uri" for item in duplicate_payload["skipped_documents"]))

        dossier = self.client.get(f"/api/cases/{case_id}/comprehension", headers=self.headers)
        self.assertEqual(dossier.status_code, 200)
        self.assertEqual(dossier.get_json()["reading_status"]["documents_total"], 2)
        self.assertTrue(dossier.get_json()["chronology"])
        self.assertTrue(any(item["source"]["source_uri"] for item in dossier.get_json()["chronology"]))

    def test_google_pull_imports_into_the_ledger_and_records_audit_activity(self):
        from google_token_store import LocalEncryptedTokenStore

        created = self.client.post("/api/cases", json={
            "title": "Read-only Google import case",
            "description": "Import explicitly queried Google source material.",
            "legal_domain": "administrative_law",
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]

        vault = LocalEncryptedTokenStore(os.path.join(self.tmp.name, "google-token-vault"))
        vault.save("ledger@example.com", "google", {"access_token": "test-access-token"})
        connector = mock.Mock()
        connector.fetch.return_value = ([
            {
                "id": "google-message-1",
                "source_type": "gmail",
                "source_uri": "https://mail.google.com/mail/u/0/#all/google-message-1",
                "title": "CAK decision",
                "document_type": "email",
                "sender": "CAK <cak@example.nl>",
                "recipient": "Robert <robert@example.nl>",
                "plain_text": "Decision dated 2026-07-01. CAK requested proof of payment before 2026-07-15.",
            },
            {
                "id": "google-message-1:attachment-1",
                "source_type": "gmail_attachment",
                "source_uri": "https://mail.google.com/mail/u/0/#all/google-message-1?attachment=attachment-1",
                "title": "CAK decision - decision.txt",
                "original_filename": "decision.txt",
                "document_type": "text/plain",
                "sender": "CAK <cak@example.nl>",
                "recipient": "Robert <robert@example.nl>",
                "content": "Decision attachment dated 2026-07-02. CAK set a deadline of 2026-07-15 for payment proof.",
                "metadata": {"gmail_message_id": "google-message-1", "gmail_attachment_id": "attachment-1"},
            },
        ], None)

        with mock.patch.object(self.app_module, "google_token_store", vault), \
             mock.patch.object(self.app_module, "GoogleEvidenceConnector", return_value=connector), \
             mock.patch.object(self.app_module, "google_oauth_config", return_value={
                 "configured": True,
                 "client_id": "client-id",
                 "client_secret": "client-secret",
             }):
            pulled = self.client.post(
                f"/api/cases/{case_id}/documents/pull-google",
                json={"source": "gmail", "query": "label:LARO-CAK", "max_items": 5},
                headers=self.headers,
            )

        self.assertEqual(pulled.status_code, 201)
        payload = pulled.get_json()
        self.assertEqual(payload["imported_count"], 2)
        self.assertEqual(payload["connector"]["mode"], "read_only")
        self.assertEqual(payload["imported_documents"][0]["document"]["source_type"], "gmail")
        self.assertEqual(payload["imported_documents"][1]["document"]["source_type"], "gmail_attachment")
        self.assertTrue(payload["artifact_counts"]["timeline_suggestions"])

        timeline = self.client.get(f"/api/cases/{case_id}/timeline", headers=self.headers)
        self.assertEqual(timeline.status_code, 200)
        self.assertTrue(any("attachment=attachment-1" in item.get("source_uri", "") for item in timeline.get_json()["timeline"]))

        audit = self.client.get(f"/api/audit?case_id={case_id}", headers=self.headers)
        self.assertEqual(audit.status_code, 200)
        self.assertTrue(any(item["action"] == "google_sources_pulled" for item in audit.get_json()["audit_events"]))

    def test_google_pull_job_reports_real_source_and_word_progress(self):
        from google_token_store import LocalEncryptedTokenStore

        created = self.client.post("/api/cases", json={
            "title": "Google import job case",
            "description": "Track durable local Google import progress.",
            "legal_domain": "administrative_law",
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]

        vault = LocalEncryptedTokenStore(os.path.join(self.tmp.name, "google-job-token-vault"))
        vault.save("ledger@example.com", "google", {"access_token": "test-access-token"})
        connector = mock.Mock()
        connector.fetch.return_value = ([
            {
                "id": "google-job-message-1",
                "source_type": "gmail",
                "source_uri": "https://mail.google.com/mail/u/0/#all/google-job-message-1",
                "title": "CAK evidence email",
                "plain_text": "CAK decision dated 2026-07-01 requests proof of payment before 2026-07-15.",
            },
            {
                "id": "google-job-file-1",
                "source_type": "google_drive",
                "source_uri": "https://drive.example/google-job-file-1",
                "title": "Payment evidence",
                "content": "Bank transfer receipt dated 2026-07-02 confirms the requested payment was made.",
            },
        ], None)
        immediate_executor = mock.Mock()
        immediate_executor.submit.side_effect = lambda function, *args: function(*args)

        with mock.patch.object(self.app_module, "google_token_store", vault), \
             mock.patch.object(self.app_module, "GoogleEvidenceConnector", return_value=connector), \
             mock.patch.object(self.app_module, "google_pull_executor", immediate_executor), \
             mock.patch.object(self.app_module, "google_oauth_config", return_value={
                 "configured": True,
                 "client_id": "client-id",
                 "client_secret": "client-secret",
             }):
            started = self.client.post(
                f"/api/cases/{case_id}/documents/pull-google/jobs",
                json={
                    "source": "gmail",
                    "query": "label:LARO-CAK",
                    "max_items": 5,
                    "days_back": 45,
                    "sort_order": "oldest",
                },
                headers=self.headers,
            )

        self.assertEqual(started.status_code, 202)
        job_id = started.get_json()["job"]["job_id"]
        job = self.client.get(
            f"/api/cases/{case_id}/documents/pull-google/jobs/{job_id}",
            headers=self.headers,
        )
        self.assertEqual(job.status_code, 200)
        payload = job.get_json()["job"]
        self.assertEqual(payload["status"], "completed")
        self.assertEqual(payload["progress_percent"], 100)
        self.assertEqual(payload["total_items"], 2)
        self.assertEqual(payload["completed_items"], 2)
        self.assertGreater(payload["total_words"], 0)
        self.assertEqual(payload["processed_words"], payload["total_words"])
        self.assertEqual(payload["result"]["imported_count"], 2)
        self.assertEqual(payload["result"]["connector"]["mode"], "read_only")
        connector.fetch.assert_called_once_with(
            "gmail",
            "label:LARO-CAK",
            5,
            days_back=45,
            sort_order="oldest",
        )
        listed = self.client.get(
            f"/api/cases/{case_id}/documents/pull-google/jobs",
            headers=self.headers,
        )
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.get_json()["jobs"][0]["job_id"], job_id)
        audit = self.client.get(f"/api/audit?case_id={case_id}", headers=self.headers)
        actions = [item["action"] for item in audit.get_json()["audit_events"]]
        self.assertIn("created", actions)
        self.assertIn("completed", actions)
        self.assertIn("google_sources_pulled", actions)

    def test_upload_document_surfaces_contradictions_and_missing_evidence(self):
        created = self.client.post("/api/cases", json={
            "title": "Conflicting evidence case",
            "description": "Testing conflict review from uploaded sources.",
            "legal_domain": "administrative_law",
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]

        first_upload = self.client.post(
            f"/api/cases/{case_id}/documents/upload",
            data={
                "file": (
                    io.BytesIO(b"Decision dated 2024-05-01. Objection deadline 2024-05-15. CAK stated Robert must pay 125 euro."),
                    "first-decision.txt",
                ),
                "title": "First decision",
            },
            content_type="multipart/form-data",
            headers=self.headers,
        )
        self.assertEqual(first_upload.status_code, 201)
        first_payload = first_upload.get_json()
        self.assertTrue(first_payload["obligation_suggestions"])
        self.assertEqual(first_payload["obligation_suggestions"][0]["responsible_party"], "Robert")
        self.assertFalse(first_payload["obligation_suggestions"][0]["user_confirmed"])

        second_upload = self.client.post(
            f"/api/cases/{case_id}/documents/upload",
            data={
                "file": (
                    io.BytesIO(b"Follow-up dated 2024-05-02. Objection deadline 2024-05-20. CAK stated proof of payment missing."),
                    "follow-up.txt",
                ),
                "title": "Follow-up letter",
            },
            content_type="multipart/form-data",
            headers=self.headers,
        )
        self.assertEqual(second_upload.status_code, 201)
        payload = second_upload.get_json()

        self.assertTrue(payload["contradiction_suggestions"])
        self.assertEqual(payload["contradiction_suggestions"][0]["status"], "needs_review")
        self.assertEqual(payload["contradiction_suggestions"][0]["contradiction_type"], "date_conflict")
        self.assertTrue(any(ref.get("date") == "2024-05-20" for ref in payload["contradiction_suggestions"][0]["source_refs"]))
        self.assertTrue(payload["missing_evidence_suggestions"])
        self.assertEqual(payload["missing_evidence_suggestions"][0]["warning_type"], "document_requested_evidence")
        target_types = {link["target_type"] for link in payload["evidence_links"]}
        self.assertIn("contradiction", target_types)
        self.assertIn("missing_evidence", target_types)

        contradictions = self.client.get(f"/api/cases/{case_id}/contradictions", headers=self.headers)
        self.assertEqual(contradictions.status_code, 200)
        self.assertTrue(any("2024-05-20" in item["description"] for item in contradictions.get_json()["contradictions"]))

        missing = self.client.get(f"/api/cases/{case_id}/missing-evidence", headers=self.headers)
        self.assertEqual(missing.status_code, 200)
        self.assertTrue(any(item["warning_type"] == "document_requested_evidence" for item in missing.get_json()["missing_evidence"]))

        graph = self.client.get(f"/api/cases/{case_id}/papertrail", headers=self.headers)
        self.assertEqual(graph.status_code, 200)
        graph_nodes = {node["type"] for node in graph.get_json()["nodes"]}
        graph_edges = {edge["type"] for edge in graph.get_json()["edges"]}
        self.assertIn("contradiction", graph_nodes)
        self.assertIn("missing_evidence", graph_nodes)
        self.assertIn("obligation", graph_nodes)
        self.assertIn("conflicts_with", graph_edges)
        self.assertIn("indicates_gap", graph_edges)
        self.assertIn("states_obligation", graph_edges)

        obligations = self.client.get(f"/api/cases/{case_id}/obligations", headers=self.headers)
        self.assertEqual(obligations.status_code, 200)
        self.assertTrue(any(item["responsible_party"] == "Robert" for item in obligations.get_json()["obligations"]))

        contradiction_id = contradictions.get_json()["contradictions"][0]["id"]
        resolved_contradiction = self.client.patch(
            f"/api/cases/{case_id}/contradictions/{contradiction_id}",
            json={"action": "resolve"},
            headers=self.headers,
        )
        self.assertEqual(resolved_contradiction.status_code, 200)
        self.assertEqual(resolved_contradiction.get_json()["status"], "resolved")

        reopened_contradiction = self.client.patch(
            f"/api/cases/{case_id}/contradictions/{contradiction_id}",
            json={"action": "reopen"},
            headers=self.headers,
        )
        self.assertEqual(reopened_contradiction.status_code, 200)
        self.assertEqual(reopened_contradiction.get_json()["status"], "needs_review")

        warning_id = next(
            item["id"]
            for item in missing.get_json()["missing_evidence"]
            if item["warning_type"] == "document_requested_evidence"
        )
        dismissed_warning = self.client.patch(
            f"/api/cases/{case_id}/missing-evidence/{warning_id}",
            json={"action": "dismiss"},
            headers=self.headers,
        )
        self.assertEqual(dismissed_warning.status_code, 200)
        self.assertEqual(dismissed_warning.get_json()["status"], "dismissed")

        resolved_warning = self.client.patch(
            f"/api/cases/{case_id}/missing-evidence/{warning_id}",
            json={"action": "resolve"},
            headers=self.headers,
        )
        self.assertEqual(resolved_warning.status_code, 200)
        self.assertEqual(resolved_warning.get_json()["status"], "resolved")

        audit = self.client.get(f"/api/audit?case_id={case_id}", headers=self.headers)
        self.assertEqual(audit.status_code, 200)
        audit_events = audit.get_json()["audit_events"]
        self.assertTrue(any(item["entity_type"] == "Contradiction" and item["action"] == "resolved" for item in audit_events))
        self.assertTrue(any(item["entity_type"] == "Contradiction" and item["action"] == "reopened" for item in audit_events))
        self.assertTrue(any(item["entity_type"] == "MissingEvidenceWarning" and item["action"] == "dismissed" for item in audit_events))
        self.assertTrue(any(item["entity_type"] == "MissingEvidenceWarning" and item["action"] == "resolved" for item in audit_events))

    def test_recovered_document_text_is_versioned_and_enters_case_analysis(self):
        created = self.client.post("/api/cases", json={
            "title": "Scanned decision recovery",
            "description": "A scanned decision needs text recovery before it can be reviewed.",
            "legal_domain": "administrative_law",
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]

        source = self.client.post(f"/api/cases/{case_id}/documents", json={
            "source_type": "manual_upload",
            "source_uri": "local://case/scanned-decision.pdf",
            "original_filename": "scanned-decision.pdf",
            "document_type": "pdf",
            "title": "Scanned CAK decision",
        }, headers=self.headers)
        self.assertEqual(source.status_code, 201)
        document_id = source.get_json()["document_id"]

        missing_before = self.client.get(f"/api/cases/{case_id}/missing-evidence", headers=self.headers)
        self.assertTrue(any(
            item["warning_type"] == "document_text_unavailable" and item["document_id"] == document_id
            for item in missing_before.get_json()["missing_evidence"]
        ))

        recovered = self.client.post(f"/api/cases/{case_id}/documents/{document_id}/recover-text", json={
            "ocr_text": "CAK besluit van 2026-07-01. Dien bezwaar in voor 2026-07-15."
        }, headers=self.headers)
        self.assertEqual(recovered.status_code, 200)
        recovered_payload = recovered.get_json()
        self.assertTrue(recovered_payload["source_preserved"])
        self.assertTrue(recovered_payload["analysis"]["readable"])
        self.assertTrue(recovered_payload["created_artifacts"])
        self.assertIn("CAK besluit", recovered_payload["document"]["extracted_text"])

        versions = self.client.get(f"/api/cases/{case_id}/documents/{document_id}/versions", headers=self.headers)
        self.assertEqual(versions.status_code, 200)
        self.assertEqual(len(versions.get_json()["versions"]), 2)
        self.assertEqual(versions.get_json()["versions"][0]["extraction_method"], "manual_text_recovery")

        missing_after = self.client.get(f"/api/cases/{case_id}/missing-evidence", headers=self.headers)
        warning = next(item for item in missing_after.get_json()["missing_evidence"] if item["document_id"] == document_id)
        self.assertEqual(warning["status"], "resolved")
        audit = self.client.get(f"/api/audit?case_id={case_id}", headers=self.headers)
        recovery_audit = next(item for item in audit.get_json()["audit_events"] if item["action"] == "extraction_recovered")
        self.assertTrue(recovery_audit["after_state"]["extracted_text_hash"])
        self.assertNotIn("CAK besluit", str(recovery_audit["after_state"]))

    def test_reanalysis_refreshes_derived_passages_without_changing_source_or_versions(self):
        created = self.client.post("/api/cases", json={
            "title": "Existing source analysis refresh",
            "description": "A readable source needs the newer passage analysis.",
            "legal_domain": "administrative_law",
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]

        source_text = "CAK decided on 2026-07-01 that Robert must pay EUR 125. File an objection before 2026-07-15."
        source = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "Existing CAK decision",
            "source_type": "manual_text",
            "extracted_text": source_text,
        }, headers=self.headers)
        self.assertEqual(source.status_code, 201)
        document_id = source.get_json()["document_id"]

        versions_before = self.client.get(f"/api/cases/{case_id}/documents/{document_id}/versions", headers=self.headers)
        self.assertEqual(len(versions_before.get_json()["versions"]), 1)

        refreshed = self.client.post(f"/api/cases/{case_id}/documents/{document_id}/reanalyze", headers=self.headers)
        self.assertEqual(refreshed.status_code, 200)
        payload = refreshed.get_json()
        self.assertTrue(payload["source_preserved"])
        self.assertTrue(payload["extraction_version_unchanged"])
        self.assertFalse(payload["created_artifacts"])
        self.assertEqual(payload["document"]["extracted_text"], source_text)
        self.assertTrue(payload["analysis"]["findings"]["source_passages"])
        self.assertEqual(payload["analysis"]["processing"]["analysis_method"], "rule_based_source_passage_v1")

        versions_after = self.client.get(f"/api/cases/{case_id}/documents/{document_id}/versions", headers=self.headers)
        self.assertEqual(len(versions_after.get_json()["versions"]), 1)
        audit = self.client.get(f"/api/audit?case_id={case_id}", headers=self.headers)
        refreshed_audit = next(item for item in audit.get_json()["audit_events"] if item["action"] == "analysis_refreshed")
        self.assertTrue(refreshed_audit["after_state"]["analysis_hash"])
        self.assertNotIn(source_text, str(refreshed_audit["after_state"]))

    def test_case_wide_analysis_persists_review_only_cited_synthesis(self):
        created = self.client.post("/api/cases", json={
            "title": "Cross-document CAK review",
            "description": "Compare the decision with the later payment notice.",
            "legal_domain": "administrative_law",
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]

        first = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "CAK decision",
            "extracted_text": "CAK decided that Robert must pay EUR 125 on 2026-07-01.",
        }, headers=self.headers)
        second = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "Payment notice",
            "extracted_text": "The payment notice asks Robert to pay EUR 250 before 2026-07-15.",
        }, headers=self.headers)
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)

        def fixture_analysis(documents, case_context):
            first_doc, second_doc = documents
            return {
                "status": "completed",
                "provider": "ollama",
                "model": "fixture-local-model",
                "findings": [{
                    "category": "cross_document_conflict",
                    "observation": "The sources reference different payment amounts.",
                    "sources": [
                        {"document_id": str(first_doc["document_id"]), "source_quote": "CAK decided that Robert must pay EUR 125 on 2026-07-01."},
                        {"document_id": str(second_doc["document_id"]), "source_quote": "The payment notice asks Robert to pay EUR 250 before 2026-07-15."},
                    ],
                    "review_status": "needs_review",
                }],
                "review_questions": [],
                "source_documents": [
                    {"document_id": first_doc["document_id"], "title": first_doc["title"], "content_hash": first_doc["content_hash"], "source_was_truncated": False},
                    {"document_id": second_doc["document_id"], "title": second_doc["title"], "content_hash": second_doc["content_hash"], "source_was_truncated": False},
                ],
                "limitations": ["Review each cited source."],
            }

        with mock.patch.object(self.app_module.document_intelligence.semantic_provider, "analyze_case", side_effect=fixture_analysis):
            response = self.client.post(f"/api/cases/{case_id}/case-analysis", headers=self.headers)

        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        self.assertTrue(payload["source_preserved"])
        self.assertFalse(payload["created_artifacts"])
        self.assertTrue(payload["requires_human_review"])
        run = payload["run"]
        self.assertEqual(run["status"], "completed")
        self.assertEqual(run["content"]["findings"][0]["review_status"], "needs_review")
        self.assertEqual(len(run["source_documents"]), 2)

        listed = self.client.get(f"/api/cases/{case_id}/case-analysis", headers=self.headers)
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.get_json()["latest"]["id"], run["id"])
        audit = self.client.get(f"/api/audit?case_id={case_id}", headers=self.headers)
        analysis_audit = next(item for item in audit.get_json()["audit_events"] if item["entity_type"] == "CaseAnalysisRun")
        self.assertEqual(analysis_audit["after_state"]["findings_count"], 1)
        self.assertNotIn("EUR 125", str(analysis_audit["after_state"]))

    def test_case_wide_analysis_does_not_persist_a_run_when_local_model_is_unavailable(self):
        created = self.client.post("/api/cases", json={"title": "Unavailable local analysis"}, headers=self.headers)
        case_id = created.get_json()["case_id"]
        self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "Readable source",
            "extracted_text": "CAK decision dated 2026-07-01.",
        }, headers=self.headers)

        unavailable = {
            "status": "unavailable",
            "provider": "ollama",
            "model": "",
            "findings": [],
            "review_questions": [],
            "source_documents": [],
            "limitations": ["The configured local model was unavailable."],
        }
        with mock.patch.object(self.app_module.document_intelligence.semantic_provider, "analyze_case", return_value=unavailable):
            response = self.client.post(f"/api/cases/{case_id}/case-analysis", headers=self.headers)

        self.assertEqual(response.status_code, 409)
        self.assertTrue(response.get_json()["source_preserved"])
        listed = self.client.get(f"/api/cases/{case_id}/case-analysis", headers=self.headers)
        self.assertEqual(listed.get_json()["runs"], [])

    def test_case_wide_analysis_uses_deterministic_local_comparison_without_ollama(self):
        created = self.client.post("/api/cases", json={"title": "Deterministic case reading"}, headers=self.headers)
        case_id = created.get_json()["case_id"]
        first = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "First payment amount",
            "extracted_text": "The decision dated 2024-05-01 records a payment amount of EUR 125.",
        }, headers=self.headers).get_json()
        second = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "Second payment amount",
            "extracted_text": "The notice dated 2024-05-15 records a payment amount of EUR 250.",
        }, headers=self.headers).get_json()

        provider = LocalSemanticAnalysisProvider({"provider": "rule_based"})
        with mock.patch.object(self.app_module.document_intelligence, "semantic_provider", provider):
            response = self.client.post(f"/api/cases/{case_id}/case-analysis", headers=self.headers)

        self.assertEqual(response.status_code, 201)
        run = response.get_json()["run"]
        self.assertEqual(run["provider"], "rule_based")
        self.assertEqual(run["content"]["source_coverage"]["sources_readable"], 2)
        self.assertEqual(run["content"]["source_coverage"]["sources_represented"], 2)
        self.assertEqual(run["content"]["source_coverage"]["sources_fully_read"], 2)
        self.assertFalse(run["content"]["source_was_truncated"])
        conflict = next(item for item in run["content"]["findings"] if item["category"] == "cross_document_conflict")
        self.assertEqual(
            {source["document_id"] for source in conflict["sources"]},
            {str(first["document_id"]), str(second["document_id"])},
        )
        self.assertEqual([item["event_date"] for item in run["content"]["timeline_suggestions"]], ["2024-05-01", "2024-05-15"])
        self.assertEqual(
            len(run["review_items"]),
            len(run["content"]["findings"]) + len(run["content"]["review_questions"]) + len(run["content"]["timeline_suggestions"]),
        )
        self.assertTrue(all(item["status"] == "needs_review" for item in run["review_items"]))

    def test_case_analysis_job_api_tracks_full_source_progress_and_refreshes_run(self):
        created = self.client.post("/api/cases", json={"title": "Durable full-source reading"}, headers=self.headers)
        case_id = created.get_json()["case_id"]
        late_source = "Opening history. " + ("Background detail. " * 120) + "The final decision is dated 2026-12-05."
        self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "Long source",
            "extracted_text": late_source,
        }, headers=self.headers)
        provider = LocalSemanticAnalysisProvider({"provider": "rule_based", "max_chars": 1000})

        with mock.patch.object(self.app_module.document_intelligence, "semantic_provider", provider), \
             mock.patch.object(self.app_module.case_analysis_executor, "submit") as submit:
            started = self.client.post(f"/api/cases/{case_id}/case-analysis/jobs", headers=self.headers)
            self.assertEqual(started.status_code, 202)
            job = started.get_json()["job"]
            duplicate = self.client.post(f"/api/cases/{case_id}/case-analysis/jobs", headers=self.headers)
            self.assertEqual(duplicate.status_code, 200)
            self.assertTrue(duplicate.get_json()["reused_active_job"])
            self.assertEqual(duplicate.get_json()["job"]["job_id"], job["job_id"])
            submit.assert_called_once()
            submitted = submit.call_args.args
            self.assertIs(submitted[0], self.app_module._run_case_analysis_job)
            self.app_module._run_case_analysis_job(*submitted[1:])

        completed = self.client.get(
            f"/api/cases/{case_id}/case-analysis/jobs/{job['job_id']}", headers=self.headers
        )
        self.assertEqual(completed.status_code, 200)
        completed_job = completed.get_json()["job"]
        self.assertEqual(completed_job["status"], "completed")
        self.assertEqual(completed_job["progress_percent"], 100)
        self.assertEqual(completed_job["processed_words"], completed_job["total_words"])
        self.assertEqual(completed_job["processed_characters"], completed_job["total_characters"])
        self.assertTrue(completed_job["result"]["source_preserved"])
        listed_jobs = self.client.get(f"/api/cases/{case_id}/case-analysis/jobs", headers=self.headers)
        self.assertEqual(listed_jobs.get_json()["jobs"][0]["job_id"], job["job_id"])
        runs = self.client.get(f"/api/cases/{case_id}/case-analysis", headers=self.headers).get_json()
        self.assertEqual(runs["latest"]["id"], completed_job["run_id"])
        self.assertEqual(runs["latest"]["content"]["source_coverage"]["coverage_percent"], 100.0)
        self.assertEqual(runs["latest"]["content"]["analysis_method"], "full_source_deterministic_comparison_v2")
        self.assertTrue(any(
            item["event_date"] == "2026-12-05"
            for item in runs["latest"]["content"]["timeline_suggestions"]
        ))

    def test_case_wide_timeline_proposal_requires_explicit_conversion_and_keeps_citations(self):
        created = self.client.post("/api/cases", json={"title": "Timeline proposal conversion"}, headers=self.headers)
        case_id = created.get_json()["case_id"]
        document = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "Dated decision",
            "extracted_text": "The authority issued its decision to Robert on 2024-05-01.",
        }, headers=self.headers).get_json()

        def fixture_analysis(documents, case_context):
            return {
                "status": "completed",
                "provider": "rule_based",
                "findings": [],
                "review_questions": [],
                "timeline_suggestions": [{
                    "event_date": "2024-05-01",
                    "title": "Decision mentioned in source",
                    "description": "Cited source passage for 2024-05-01: The authority issued its decision to Robert on 2024-05-01.",
                    "actor": "The authority",
                    "action": "decided",
                    "affected_party": "Robert",
                    "event_kind": "decision",
                    "sources": [{
                        "document_id": str(document["document_id"]),
                        "source_quote": "The authority issued its decision to Robert on 2024-05-01.",
                    }],
                }],
                "source_documents": [],
                "limitations": [],
            }

        with mock.patch.object(self.app_module.document_intelligence.semantic_provider, "analyze_case", side_effect=fixture_analysis):
            analysis = self.client.post(f"/api/cases/{case_id}/case-analysis", headers=self.headers)
        self.assertEqual(analysis.status_code, 201)
        run = analysis.get_json()["run"]
        review_item = next(item for item in run["review_items"] if item["item_type"] == "timeline_suggestion")
        self.assertEqual(review_item["source_refs"][0]["event_date"], "2024-05-01")
        self.assertEqual(review_item["source_refs"][0]["actor"], "The authority")

        converted = self.client.patch(
            f"/api/cases/{case_id}/case-analysis/review-items/{review_item['id']}",
            json={"action": "timeline"},
            headers=self.headers,
        )
        self.assertEqual(converted.status_code, 200)
        converted_item = converted.get_json()["review_item"]
        self.assertEqual(converted_item["status"], "converted")
        self.assertEqual(converted_item["target_type"], "event")

        timeline = self.client.get(f"/api/cases/{case_id}/timeline", headers=self.headers).get_json()["timeline"]
        event = next(item for item in timeline if item["id"] == converted_item["target_id"])
        self.assertEqual(event["event_date"], "2024-05-01")
        self.assertEqual(event["actor"], "The authority")
        self.assertEqual(event["action"], "decided")
        self.assertEqual(event["affected_party"], "Robert")
        self.assertEqual(event["event_kind"], "decision")
        self.assertTrue(event["is_suggestion"])
        self.assertEqual(event["source"]["document_id"], document["document_id"])
        evidence = self.client.get(f"/api/cases/{case_id}/evidence", headers=self.headers).get_json()["evidence_links"]
        self.assertTrue(any(link["target_type"] == "event" and link["target_id"] == event["id"] for link in evidence))

    def test_case_wide_timeline_proposal_can_be_confirmed_in_one_review_action(self):
        created = self.client.post("/api/cases", json={"title": "Direct timeline confirmation"}, headers=self.headers)
        case_id = created.get_json()["case_id"]
        source_quote = "The authority issued its decision on 2024-05-01."
        document = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "Dated decision",
            "extracted_text": source_quote,
        }, headers=self.headers).get_json()

        fixture_analysis = {
            "status": "completed",
            "provider": "rule_based",
            "findings": [],
            "review_questions": [],
            "timeline_suggestions": [{
                "event_date": "2024-05-01",
                "title": "Decision mentioned in source",
                "description": f"Cited source passage for 2024-05-01: {source_quote}",
                "sources": [{
                    "document_id": str(document["document_id"]),
                    "source_quote": source_quote,
                }],
            }],
            "source_documents": [],
            "limitations": [],
        }
        with mock.patch.object(self.app_module.document_intelligence.semantic_provider, "analyze_case", return_value=fixture_analysis):
            analysis = self.client.post(f"/api/cases/{case_id}/case-analysis", headers=self.headers)
        review_item = next(item for item in analysis.get_json()["run"]["review_items"] if item["item_type"] == "timeline_suggestion")

        confirmed = self.client.patch(
            f"/api/cases/{case_id}/case-analysis/review-items/{review_item['id']}",
            json={"action": "confirm_timeline"},
            headers=self.headers,
        )
        self.assertEqual(confirmed.status_code, 200)
        payload = confirmed.get_json()
        self.assertTrue(payload["confirmation_applied"])
        self.assertFalse(payload["requires_human_review"])
        self.assertEqual(payload["review_item"]["status"], "converted")

        timeline = self.client.get(f"/api/cases/{case_id}/timeline", headers=self.headers).get_json()["timeline"]
        event = next(item for item in timeline if item["id"] == payload["review_item"]["target_id"])
        self.assertTrue(event["user_confirmed"])
        self.assertFalse(event["is_suggestion"])
        self.assertEqual(event["event_type"], "confirmed_from_case_analysis")
        evidence = self.client.get(f"/api/cases/{case_id}/evidence", headers=self.headers).get_json()["evidence_links"]
        link = next(item for item in evidence if item["target_type"] == "event" and item["target_id"] == event["id"])
        self.assertTrue(link["user_confirmed"])
        self.assertEqual(link["relationship"], "supports")
        queue = self.client.get(f"/api/cases/{case_id}/review-queue", headers=self.headers).get_json()["items"]
        self.assertFalse(any(item["queue_type"] in {"case_analysis", "timeline"} for item in queue))
        audit = self.client.get(f"/api/audit?case_id={case_id}", headers=self.headers).get_json()["audit_events"]
        self.assertTrue(any(item["entity_type"] == "CaseAnalysisReviewItem" and item["action"] == "confirmed_as_event" for item in audit))

    def test_case_wide_review_citations_accept_normalized_whitespace_only(self):
        created = self.client.post("/api/cases", json={"title": "Whitespace citation"}, headers=self.headers)
        case_id = created.get_json()["case_id"]
        document = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "Wrapped decision",
            "extracted_text": "The authority issued\nits decision on 2024-05-01.",
        }, headers=self.headers).get_json()
        fixture_analysis = {
            "status": "completed",
            "provider": "rule_based",
            "findings": [],
            "review_questions": [],
            "timeline_suggestions": [{
                "event_date": "2024-05-01",
                "title": "Decision mentioned in source",
                "description": "The authority issued its decision.",
                "sources": [{
                    "document_id": str(document["document_id"]),
                    "source_quote": "The authority issued its decision on 2024-05-01.",
                }],
            }],
            "source_documents": [],
            "limitations": [],
        }
        with mock.patch.object(self.app_module.document_intelligence.semantic_provider, "analyze_case", return_value=fixture_analysis):
            analysis = self.client.post(f"/api/cases/{case_id}/case-analysis", headers=self.headers)

        self.assertEqual(analysis.status_code, 201)
        review_items = analysis.get_json()["run"]["review_items"]
        self.assertEqual(len(review_items), 1)
        self.assertEqual(review_items[0]["source_refs"][0]["document_id"], document["document_id"])

    def test_partial_case_analysis_coverage_enters_and_clears_the_review_queue(self):
        created = self.client.post("/api/cases", json={"title": "Coverage warning"}, headers=self.headers)
        case_id = created.get_json()["case_id"]
        document = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "Long authority file",
            "extracted_text": "Authority evidence " * 200,
        }, headers=self.headers).get_json()
        source_document = {
            "document_id": document["document_id"],
            "title": "Long authority file",
            "source_characters_total": 3800,
            "source_characters_analyzed": 900,
            "source_was_truncated": True,
        }
        partial_analysis = {
            "status": "completed",
            "provider": "rule_based",
            "findings": [],
            "review_questions": [],
            "timeline_suggestions": [],
            "source_documents": [source_document],
            "source_was_truncated": True,
            "source_coverage": {
                "sources_readable": 1,
                "sources_represented": 1,
                "sources_fully_read": 0,
                "sources_partially_read": 1,
            },
            "limitations": [],
        }
        full_analysis = {
            **partial_analysis,
            "source_documents": [{**source_document, "source_characters_analyzed": 3800, "source_was_truncated": False}],
            "source_was_truncated": False,
            "source_coverage": {
                "sources_readable": 1,
                "sources_represented": 1,
                "sources_fully_read": 1,
                "sources_partially_read": 0,
            },
        }
        with mock.patch.object(
            self.app_module.document_intelligence.semantic_provider,
            "analyze_case",
            side_effect=[partial_analysis, full_analysis],
        ):
            first_run = self.client.post(f"/api/cases/{case_id}/case-analysis", headers=self.headers)
            self.assertEqual(first_run.status_code, 201)
            warnings = self.client.get(f"/api/cases/{case_id}/missing-evidence", headers=self.headers).get_json()["missing_evidence"]
            warning = next(item for item in warnings if item["warning_type"] == "analysis_partial_coverage")
            self.assertEqual(warning["status"], "needs_review")
            self.assertEqual(warning["document_id"], document["document_id"])
            queue = self.client.get(f"/api/cases/{case_id}/review-queue", headers=self.headers).get_json()["items"]
            self.assertTrue(any(item["queue_type"] == "gap" and item["item_id"] == warning["id"] for item in queue))

            second_run = self.client.post(f"/api/cases/{case_id}/case-analysis", headers=self.headers)
            self.assertEqual(second_run.status_code, 201)

        warnings = self.client.get(f"/api/cases/{case_id}/missing-evidence", headers=self.headers).get_json()["missing_evidence"]
        warning = next(item for item in warnings if item["warning_type"] == "analysis_partial_coverage")
        self.assertEqual(warning["status"], "resolved")
        queue = self.client.get(f"/api/cases/{case_id}/review-queue", headers=self.headers).get_json()["items"]
        self.assertFalse(any(item["queue_type"] == "gap" and item["item_id"] == warning["id"] for item in queue))

    def test_case_wide_timeline_conversion_reuses_exact_source_linked_event(self):
        created = self.client.post("/api/cases", json={"title": "Timeline deduplication"}, headers=self.headers)
        case_id = created.get_json()["case_id"]
        source_quote = "The authority issued its decision on 2024-05-01."
        document = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "Dated decision",
            "extracted_text": source_quote,
        }, headers=self.headers).get_json()
        existing_event = self.client.post(f"/api/cases/{case_id}/timeline", json={
            "event_date": "2024-05-01",
            "title": "Decision mentioned in source",
            "description": source_quote,
            "created_from_document_id": document["document_id"],
            "evidence_quote": source_quote,
        }, headers=self.headers)
        self.assertEqual(existing_event.status_code, 201)
        existing_event_id = existing_event.get_json()["id"]

        def fixture_analysis(documents, case_context):
            return {
                "status": "completed",
                "provider": "rule_based",
                "findings": [],
                "review_questions": [],
                "timeline_suggestions": [{
                    "event_date": "2024-05-01",
                    "title": "Decision mentioned in source",
                    "description": f"Cited source passage for 2024-05-01: {source_quote}",
                    "sources": [{
                        "document_id": str(document["document_id"]),
                        "source_quote": source_quote,
                    }],
                }],
                "source_documents": [],
                "limitations": [],
            }

        with mock.patch.object(self.app_module.document_intelligence.semantic_provider, "analyze_case", side_effect=fixture_analysis):
            analysis = self.client.post(f"/api/cases/{case_id}/case-analysis", headers=self.headers)
        review_item = next(item for item in analysis.get_json()["run"]["review_items"] if item["item_type"] == "timeline_suggestion")

        converted = self.client.patch(
            f"/api/cases/{case_id}/case-analysis/review-items/{review_item['id']}",
            json={"action": "timeline"},
            headers=self.headers,
        )
        self.assertEqual(converted.status_code, 200)
        self.assertEqual(converted.get_json()["review_item"]["target_id"], existing_event_id)

        timeline = self.client.get(f"/api/cases/{case_id}/timeline", headers=self.headers).get_json()["timeline"]
        self.assertEqual([event["id"] for event in timeline], [existing_event_id])
        evidence = self.client.get(f"/api/cases/{case_id}/evidence", headers=self.headers).get_json()["evidence_links"]
        matching_links = [
            link for link in evidence
            if link["target_type"] == "event"
            and link["target_id"] == existing_event_id
            and link["document_id"] == document["document_id"]
            and link["snippet"] == source_quote
        ]
        self.assertEqual(len(matching_links), 1)

    def test_document_inbox_api_suggests_links_and_keeps_users_isolated(self):
        created = self.client.post("/api/cases", json={
            "title": "CAK objection 2026",
            "description": "Administrative objection against a CAK decision.",
            "legal_domain": "administrative_law",
            "court_or_institution": "CAK",
            "case_reference": "CAK-2026-4431",
            "parties": [{"name": "CAK", "party_type": "government_body"}],
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]

        staged = self.client.post("/api/document-inbox", json={
            "title": "Decision CAK-2026-4431",
            "source_type": "manual_text",
            "extracted_text": (
                "On 2026-06-01 CAK issued decision CAK-2026-4431. "
                "Robert submitted an objection on 2026-06-08."
            ),
        }, headers=self.headers)
        self.assertEqual(staged.status_code, 201)
        staged_payload = staged.get_json()
        item = staged_payload["item"]
        self.assertEqual(item["status"], "needs_review")
        self.assertEqual(item["suggested_matches"][0]["case_id"], case_id)
        self.assertTrue(item["suggested_matches"][0]["requires_review"])
        self.assertFalse(staged_payload["external_action_taken"])

        command_center = self.client.get("/api/cases/command-center", headers=self.headers)
        self.assertEqual(command_center.status_code, 200)
        self.assertGreaterEqual(command_center.get_json()["counts"]["document_inbox"], 1)
        self.assertTrue(any(
            action["target"] == "document-inbox"
            for action in command_center.get_json()["next_actions"]
        ))

        other_token = self.app_module.auth_system._create_session("inbox-other@laro.test", "user")
        other_headers = {"Authorization": f"Bearer {other_token}"}
        self.assertEqual(self.client.get("/api/document-inbox", headers=other_headers).get_json()["items"], [])
        self.assertEqual(
            self.client.get(f"/api/document-inbox/{item['id']}", headers=other_headers).status_code,
            404,
        )
        self.assertEqual(
            self.client.post(
                f"/api/document-inbox/{item['id']}/link",
                json={"case_id": case_id},
                headers=other_headers,
            ).status_code,
            404,
        )

        linked = self.client.post(
            f"/api/document-inbox/{item['id']}/link",
            json={"case_id": case_id},
            headers=self.headers,
        )
        self.assertEqual(linked.status_code, 201)
        linked_payload = linked.get_json()
        self.assertTrue(linked_payload["source_preserved"])
        self.assertFalse(linked_payload["external_action_taken"])
        self.assertEqual(linked_payload["inbox_item"]["status"], "linked")
        self.assertEqual(linked_payload["document"]["case_id"], case_id)
        self.assertGreaterEqual(len(linked_payload["timeline_suggestions"]), 1)

        documents = self.client.get(f"/api/cases/{case_id}/documents", headers=self.headers).get_json()["documents"]
        self.assertEqual(len([doc for doc in documents if doc["content_hash"] == item["content_hash"]]), 1)
        duplicate = self.client.post("/api/document-inbox", json={
            "title": "Decision CAK-2026-4431",
            "source_type": "manual_text",
            "extracted_text": (
                "On 2026-06-01 CAK issued decision CAK-2026-4431. "
                "Robert submitted an objection on 2026-06-08."
            ),
        }, headers=self.headers)
        self.assertEqual(duplicate.status_code, 200)
        self.assertTrue(duplicate.get_json()["item"]["duplicate"])
        self.assertEqual(duplicate.get_json()["item"]["id"], item["id"])

        audit = self.client.get("/api/audit", headers=self.headers).get_json()["audit_events"]
        self.assertTrue(any(record["action"] == "staged_for_case_review" for record in audit))
        self.assertTrue(any(record["action"] == "linked_to_case" for record in audit))

    def test_document_inbox_upload_keeps_the_file_local_without_exposing_its_path(self):
        source_bytes = b"On 2026-07-02 insurer Noordlicht denied reimbursement under NL-7781."
        uploaded = self.client.post(
            "/api/document-inbox/upload",
            data={
                "file": (io.BytesIO(source_bytes), "insurance-decision.txt"),
                "title": "Insurance decision NL-7781",
                "source_type": "manual_upload",
                "confidentiality_level": "sensitive",
            },
            content_type="multipart/form-data",
            headers=self.headers,
        )

        self.assertEqual(uploaded.status_code, 201)
        payload = uploaded.get_json()
        item = payload["item"]
        self.assertTrue(payload["storage"]["kept_local"])
        self.assertEqual(payload["storage"]["size_bytes"], len(source_bytes))
        self.assertTrue(item["has_local_file"])
        self.assertEqual(item["confidentiality_level"], "sensitive")
        self.assertNotIn("local_path", item)
        self.assertNotIn("local_path", json.dumps(payload))

        stored_files = []
        for root, _, filenames in os.walk(os.environ["LARO_UPLOAD_ROOT"]):
            stored_files.extend(os.path.join(root, name) for name in filenames)
        matching_files = [
            path for path in stored_files
            if item["content_hash"][:20] in os.path.basename(path)
        ]
        self.assertEqual(len(matching_files), 1)
        with open(matching_files[0], "rb") as handle:
            self.assertEqual(handle.read(), source_bytes)

        duplicate = self.client.post(
            "/api/document-inbox/upload",
            data={
                "file": (io.BytesIO(source_bytes), "renamed-insurance-decision.txt"),
                "title": "Renamed copy of NL-7781",
            },
            content_type="multipart/form-data",
            headers=self.headers,
        )
        self.assertEqual(duplicate.status_code, 200)
        self.assertTrue(duplicate.get_json()["item"]["duplicate"])
        self.assertEqual(duplicate.get_json()["item"]["id"], item["id"])
        stored_files_after_duplicate = []
        for root, _, filenames in os.walk(os.environ["LARO_UPLOAD_ROOT"]):
            stored_files_after_duplicate.extend(os.path.join(root, name) for name in filenames)
        self.assertEqual(set(stored_files_after_duplicate), set(stored_files))

        dismissed = self.client.patch(
            f"/api/document-inbox/{item['id']}",
            json={"action": "dismiss"},
            headers=self.headers,
        )
        self.assertEqual(dismissed.status_code, 200)
        self.assertEqual(dismissed.get_json()["status"], "dismissed")
        dismissed_items = self.client.get(
            "/api/document-inbox?status=dismissed",
            headers=self.headers,
        ).get_json()["items"]
        self.assertTrue(any(record["id"] == item["id"] for record in dismissed_items))
        self.assertTrue(os.path.isfile(matching_files[0]))

    def test_case_endpoints_do_not_expose_another_authenticated_users_ledger(self):
        created = self.client.post("/api/cases", json={"title": "Private legal matter"}, headers=self.headers)
        case_id = created.get_json()["case_id"]
        self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "Private source",
            "extracted_text": "Private legal evidence.",
        }, headers=self.headers)
        outreach = self.client.post(f"/api/cases/{case_id}/outreach", json={
            "lawyer_name": "Private Lawyer",
            "lawyer_email": "private@example-law.test",
            "subject": "Private case inquiry",
            "draft_body": "Private legal correspondence draft.",
        }, headers=self.headers)
        approval_id = outreach.get_json()["approval_id"]

        other_token = self.app_module.auth_system._create_session("other-user@laro.test", "user")
        other_headers = {"Authorization": f"Bearer {other_token}"}

        listed = self.client.get("/api/cases", headers=other_headers)
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.get_json()["cases"], [])
        self.assertEqual(self.client.get(f"/api/cases/{case_id}", headers=other_headers).status_code, 404)
        self.assertEqual(self.client.get(f"/api/cases/{case_id}/documents", headers=other_headers).status_code, 404)
        self.assertEqual(self.client.get(f"/api/cases/{case_id}/timeline", headers=other_headers).status_code, 404)
        self.assertEqual(self.client.post(f"/api/cases/{case_id}/documents", json={"title": "Intrusion"}, headers=other_headers).status_code, 404)
        self.assertEqual(self.client.get("/api/approvals", headers=other_headers).get_json()["approvals"], [])
        self.assertEqual(self.client.get(f"/api/approvals?case_id={case_id}", headers=other_headers).status_code, 404)
        self.assertEqual(self.client.patch(f"/api/approvals/{approval_id}", json={"status": "approved"}, headers=other_headers).status_code, 404)
        self.assertEqual(self.client.get("/api/audit", headers=other_headers).get_json()["audit_events"], [])
        self.assertEqual(self.client.get(f"/api/audit?case_id={case_id}", headers=other_headers).status_code, 404)
        self.assertEqual(self.client.post("/api/outreach/targets/match", json={
            "case_id": case_id,
            "target_type": "media",
        }, headers=other_headers).status_code, 404)
        self.assertEqual(self.client.post("/api/outreach/start", json={
            "case_id": case_id,
            "legal_field": "ADMINISTRATIVE_LAW",
        }, headers=other_headers).status_code, 404)
        self.assertEqual(self.client.get(f"/api/cases/{case_id}", headers=self.headers).status_code, 200)

    def test_generated_lawyer_brief_persists_source_links_without_external_action(self):
        created = self.client.post("/api/cases", json={
            "title": "Generated lawyer briefing",
            "desired_outcome": "Review the administrative decision.",
        }, headers=self.headers)
        case_id = created.get_json()["case_id"]
        document = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "Decision source",
            "extracted_text": "The authority issued the decision on 2024-05-01.",
        }, headers=self.headers).get_json()

        generated = self.client.post(
            f"/api/cases/{case_id}/drafts/generate",
            json={"draft_type": "lawyer_summary"},
            headers=self.headers,
        )
        self.assertEqual(generated.status_code, 201)
        payload = generated.get_json()
        draft = payload["draft"]
        self.assertTrue(payload["source_preserved"])
        self.assertFalse(payload["external_action_taken"])
        self.assertEqual(draft["draft_type"], "lawyer_summary")
        self.assertEqual(draft["status"], "draft")
        self.assertEqual(draft["generation_method"], "source_linked_case_dossier_v1")
        self.assertEqual(draft["source_document_ids"], [document["document_id"]])
        self.assertIn(f"doc {document['document_id']}: Decision source", draft["body"])
        self.assertIn("Internal factual preparation only", draft["body"])

        evidence = self.client.get(f"/api/cases/{case_id}/evidence", headers=self.headers).get_json()["evidence_links"]
        source_link = next(item for item in evidence if item["target_type"] == "draft" and item["target_id"] == draft["id"])
        self.assertEqual(source_link["document_id"], document["document_id"])
        self.assertEqual(source_link["relationship"], "cited_in_generated_draft")
        self.assertTrue(source_link["user_confirmed"])

        graph = self.client.get(f"/api/cases/{case_id}/papertrail", headers=self.headers).get_json()
        self.assertTrue(any(
            edge["from"] == f"document:{document['document_id']}"
            and edge["to"] == f"draft:{draft['id']}"
            and edge["type"] == "cited_in_generated_draft"
            for edge in graph["edges"]
        ))

        export_draft = self.client.post(
            f"/api/cases/{case_id}/drafts/generate",
            json={"draft_type": "case_bundle_export"},
            headers=self.headers,
        ).get_json()["draft"]
        self.assertEqual(export_draft["status"], "waiting_approval")
        self.assertEqual(export_draft["risk_level"], "high")
        self.assertIsNotNone(export_draft["approval_id"])

    def test_case_wide_review_item_requires_explicit_conversion_and_preserves_citations(self):
        created = self.client.post("/api/cases", json={
            "title": "Cited analysis conversion",
            "legal_domain": "administrative_law",
        }, headers=self.headers)
        case_id = created.get_json()["case_id"]
        first = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "First amount",
            "extracted_text": "Decision A records a payment amount of EUR 125.",
        }, headers=self.headers).get_json()
        second = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "Second amount",
            "extracted_text": "Notice B records a payment amount of EUR 250.",
        }, headers=self.headers).get_json()

        def fixture_analysis(documents, case_context):
            return {
                "status": "completed",
                "provider": "ollama",
                "model": "fixture-local-model",
                "findings": [{
                    "category": "cross_document_conflict",
                    "observation": "The source documents state different payment amounts.",
                    "sources": [
                        {"document_id": str(first["document_id"]), "source_quote": "Decision A records a payment amount of EUR 125."},
                        {"document_id": str(second["document_id"]), "source_quote": "Notice B records a payment amount of EUR 250."},
                    ],
                    "review_status": "needs_review",
                }],
                "review_questions": [],
                "source_documents": [],
                "limitations": [],
            }

        with mock.patch.object(self.app_module.document_intelligence.semantic_provider, "analyze_case", side_effect=fixture_analysis):
            analysis = self.client.post(f"/api/cases/{case_id}/case-analysis", headers=self.headers)
        self.assertEqual(analysis.status_code, 201)
        run = analysis.get_json()["run"]
        self.assertEqual(len(run["review_items"]), 1)
        review_item = run["review_items"][0]
        self.assertEqual(review_item["status"], "needs_review")
        self.assertEqual(self.client.get(f"/api/cases/{case_id}/contradictions", headers=self.headers).get_json()["contradictions"], [])

        summary = self.client.get(f"/api/cases/{case_id}/summary", headers=self.headers)
        self.assertEqual(summary.status_code, 200)
        self.assertEqual(len(summary.get_json()["risk_review"]["case_analysis"]), 1)
        self.assertEqual(summary.get_json()["risk_review"]["case_analysis"][0]["status"], "needs_review")
        dossier = self.client.get(f"/api/cases/{case_id}/comprehension", headers=self.headers)
        self.assertEqual(dossier.status_code, 200)
        self.assertTrue(any(item["type"] == "case_analysis" for item in dossier.get_json()["review"]["open_items"]))
        graph = self.client.get(f"/api/cases/{case_id}/papertrail", headers=self.headers)
        self.assertEqual(graph.status_code, 200)
        review_node_id = f"case_analysis_review:{review_item['id']}"
        self.assertTrue(any(node["id"] == review_node_id for node in graph.get_json()["nodes"]))
        self.assertEqual(
            len([edge for edge in graph.get_json()["edges"] if edge["to"] == review_node_id and edge["type"] == "cites"]),
            2,
        )

        converted = self.client.patch(
            f"/api/cases/{case_id}/case-analysis/review-items/{review_item['id']}",
            json={"action": "contradiction"},
            headers=self.headers,
        )
        self.assertEqual(converted.status_code, 200)
        converted_item = converted.get_json()["review_item"]
        self.assertEqual(converted_item["status"], "converted")
        self.assertEqual(converted_item["target_type"], "contradiction")

        converted_graph = self.client.get(f"/api/cases/{case_id}/papertrail", headers=self.headers).get_json()
        self.assertTrue(any(
            edge["from"] == review_node_id
            and edge["to"] == f"contradiction:{converted_item['target_id']}"
            and edge["type"] == "prepared_as"
            for edge in converted_graph["edges"]
        ))

        contradictions = self.client.get(f"/api/cases/{case_id}/contradictions", headers=self.headers).get_json()["contradictions"]
        self.assertEqual(len(contradictions), 1)
        self.assertEqual(contradictions[0]["status"], "needs_review")
        self.assertEqual(len(contradictions[0]["source_refs"]), 2)
        evidence = self.client.get(f"/api/cases/{case_id}/evidence", headers=self.headers).get_json()["evidence_links"]
        self.assertEqual(len(evidence), 2)
        self.assertTrue(all(link["relationship"] == "needs_review" for link in evidence))
        self.assertTrue(all(not link["user_confirmed"] for link in evidence))

        audit = self.client.get(f"/api/audit?case_id={case_id}", headers=self.headers).get_json()["audit_events"]
        conversion_audit = next(item for item in audit if item["entity_type"] == "CaseAnalysisReviewItem" and item["action"] == "converted_to_contradiction")
        self.assertEqual(conversion_audit["after_state"]["target_type"], "contradiction")
        self.assertNotIn("EUR 125", str(conversion_audit["after_state"]))

    def test_document_file_route_blocks_paths_outside_upload_store(self):
        created = self.client.post("/api/cases", json={
            "title": "Unsafe document path case",
            "description": "Path boundary check.",
            "legal_domain": "privacy",
        }, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        case_id = created.get_json()["case_id"]

        document = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "Outside file",
            "source_type": "manual",
            "local_path": __file__,
            "extracted_text": "This metadata should not make the source file downloadable.",
        }, headers=self.headers)
        self.assertEqual(document.status_code, 201)
        document_id = document.get_json()["document_id"]

        document_detail = self.client.get(f"/api/cases/{case_id}/documents/{document_id}", headers=self.headers)
        self.assertEqual(document_detail.status_code, 200)
        self.assertFalse(document_detail.get_json()["can_open_file"])

        document_file = self.client.get(f"/api/cases/{case_id}/documents/{document_id}/file", headers=self.headers)
        self.assertEqual(document_file.status_code, 403)

    def test_analyzed_source_persists_who_did_what_timeline_facts(self):
        created = self.client.post("/api/cases", json={
            "title": "CAK source chronology",
            "description": "Who did what and when must stay attached to the source.",
        }, headers=self.headers)
        case_id = created.get_json()["case_id"]
        source_text = "On 2026-07-10, CAK stated Robert must provide the bank statement by 2026-08-14."

        document = self.client.post(f"/api/cases/{case_id}/documents", json={
            "title": "CAK evidence request",
            "sender": "CAK",
            "recipient": "Robert",
            "content": source_text,
            "analyze": True,
        }, headers=self.headers)
        self.assertEqual(document.status_code, 201)
        document_payload = document.get_json()
        event = next(item for item in document_payload["timeline_suggestions"] if item["event_date"] == "2026-07-10")

        self.assertEqual(event["actor"], "CAK")
        self.assertEqual(event["action"], "stated")
        self.assertEqual(event["affected_party"], "Robert")
        self.assertEqual(event["event_kind"], "communication")
        self.assertFalse(event["user_confirmed"])

        graph = self.client.get(f"/api/cases/{case_id}/papertrail", headers=self.headers).get_json()
        event_node = next(item for item in graph["nodes"] if item["id"] == f"event:{event['id']}")
        self.assertEqual(event_node["actor"], "CAK")
        self.assertEqual(event_node["action"], "stated")

        updated = self.client.patch(f"/api/cases/{case_id}/timeline/{event['id']}", json={
            "action": "update",
            "actor": "CAK appeals team",
            "event_action": "requested",
            "affected_party": "Robert",
            "event_kind": "communication",
        }, headers=self.headers)
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.get_json()["actor"], "CAK appeals team")
        self.assertEqual(updated.get_json()["action"], "requested")


if __name__ == "__main__":
    unittest.main()


