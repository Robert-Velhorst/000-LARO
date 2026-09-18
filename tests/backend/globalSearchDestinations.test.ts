import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildCase, buildEvidence, buildLawyer, buildUser } from "../factories";
import {
  SEARCH_RESULT_TYPES,
  getSearchDestination,
  isRegisteredSearchDestination,
  type SearchResultType,
} from "../../shared/globalSearch";

const suite = sqliteAvailable ? describe : describe.skip;

suite("global-search destinations", () => {
  let app: TestApp;
  const owner = { id: "SEARCH_OWNER", email: "search-owner@example.test", name: "Search Owner", role: "user" };
  const other = { id: "SEARCH_OTHER", email: "search-other@example.test", name: "Search Other", role: "user" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser(owner),
      buildUser(other),
    ]);
    await app.db.insert(app.schema.cases).values([
      buildCase({ id: "SEARCH_CASE_OWNER", userId: owner.id, clientName: "DeepLink Owner", caseType: "DeepLink Case" }),
      buildCase({ id: "SEARCH_CASE_OTHER", userId: other.id, clientName: "DeepLink Foreign Secret", caseType: "DeepLink Case" }),
    ]);
    await app.db.insert(app.schema.lawyers).values(
      buildLawyer({ id: "SEARCH_LAWYER", name: "DeepLink Lawyer" }),
    );
    await app.db.insert(app.schema.evidence).values([
      buildEvidence({ id: "SEARCH_EVIDENCE_OWNER", userId: owner.id, caseId: "SEARCH_CASE_OWNER", title: "DeepLink Evidence" }),
      buildEvidence({ id: "SEARCH_EVIDENCE_OTHER", userId: other.id, caseId: "SEARCH_CASE_OTHER", title: "DeepLink Foreign Evidence Secret" }),
    ]);
    await app.db.insert(app.schema.documents).values([
      { id: "SEARCH_DOCUMENT_OWNER", userId: owner.id, caseId: "SEARCH_CASE_OWNER", name: "DeepLink Document", type: "letter", content: "Owned document detail" },
      { id: "SEARCH_DOCUMENT_OTHER", userId: other.id, caseId: "SEARCH_CASE_OTHER", name: "DeepLink Foreign Document Secret", type: "letter", content: "Foreign secret detail" },
    ]);
    await app.db.insert(app.schema.communications).values([
      { id: "SEARCH_COMM_OWNER", userId: owner.id, caseId: "SEARCH_CASE_OWNER", subject: "DeepLink Communication", content: "Owned communication detail", type: "note", channel: "internal" },
      { id: "SEARCH_COMM_OTHER", userId: other.id, caseId: "SEARCH_CASE_OTHER", subject: "DeepLink Foreign Communication Secret", content: "Foreign secret detail", type: "note", channel: "internal" },
    ]);
  });

  afterAll(() => app?.cleanup());

  it("maps every maintained result type to a registered, stable route", () => {
    const expected: Record<SearchResultType, string> = {
      case: "/cases?case=id%2Fwith%20spaces",
      lawyer: "/lawyers/id%2Fwith%20spaces",
      evidence: "/evidence?view=items&evidence=id%2Fwith%20spaces",
      document: "/evidence?view=items&document=id%2Fwith%20spaces",
      communication: "/messages?communication=id%2Fwith%20spaces",
    };

    for (const type of SEARCH_RESULT_TYPES) {
      const destination = getSearchDestination({ type, id: "id/with spaces" });
      expect(destination).toBe(expected[type]);
      expect(isRegisteredSearchDestination(destination!)).toBe(true);
    }
    expect(getSearchDestination({ type: "case", id: "   " })).toBeNull();
    expect(isRegisteredSearchDestination("/cases/legacy-unregistered-route")).toBe(false);
  });

  it("searches and resolves all five result types without crossing owner boundaries", async () => {
    const caller = app.makeCaller(owner);
    const search = await caller.search.global({ query: "DeepLink", limit: 20 });
    const ids = search.results.map((result: { id: string }) => result.id);

    expect(ids).toEqual(expect.arrayContaining([
      "SEARCH_CASE_OWNER",
      "SEARCH_LAWYER",
      "SEARCH_EVIDENCE_OWNER",
      "SEARCH_DOCUMENT_OWNER",
      "SEARCH_COMM_OWNER",
    ]));
    expect(ids).not.toEqual(expect.arrayContaining([
      "SEARCH_CASE_OTHER",
      "SEARCH_EVIDENCE_OTHER",
      "SEARCH_DOCUMENT_OTHER",
      "SEARCH_COMM_OTHER",
    ]));

    const resolved = await Promise.all([
      caller.search.resolve({ type: "case", id: "SEARCH_CASE_OWNER" }),
      caller.search.resolve({ type: "lawyer", id: "SEARCH_LAWYER" }),
      caller.search.resolve({ type: "evidence", id: "SEARCH_EVIDENCE_OWNER" }),
      caller.search.resolve({ type: "document", id: "SEARCH_DOCUMENT_OWNER" }),
      caller.search.resolve({ type: "communication", id: "SEARCH_COMM_OWNER" }),
    ]);
    expect(resolved.map((result: { type: SearchResultType }) => result.type)).toEqual(SEARCH_RESULT_TYPES);
    expect(resolved.slice(2).every((result: { caseId: string | null }) => result.caseId === "SEARCH_CASE_OWNER")).toBe(true);
  });

  it("uses the same neutral not-found response for foreign, missing, and deleted records", async () => {
    const caller = app.makeCaller(owner);
    for (const input of [
      { type: "case" as const, id: "SEARCH_CASE_OTHER" },
      { type: "evidence" as const, id: "SEARCH_EVIDENCE_OTHER" },
      { type: "document" as const, id: "SEARCH_DOCUMENT_OTHER" },
      { type: "communication" as const, id: "SEARCH_COMM_OTHER" },
      { type: "document" as const, id: "SEARCH_MISSING" },
    ]) {
      expect(await caller.search.resolve(input)).toBeNull();
    }

    await app.db.delete(app.schema.documents).where(eq(app.schema.documents.id, "SEARCH_DOCUMENT_OWNER"));
    expect(await caller.search.resolve({ type: "document", id: "SEARCH_DOCUMENT_OWNER" })).toBeNull();
  });
});
