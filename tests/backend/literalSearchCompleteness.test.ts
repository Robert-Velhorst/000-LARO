import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCase, buildEvidence, buildLawyer, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import {
  LITERAL_SEARCH_CONTRACT_VERSION,
  normalizeLiteralSearchText,
} from "../../server/literalSearch";

const suite = sqliteAvailable ? describe : describe.skip;

suite("literal-safe and completeness-aware search", () => {
  let app: TestApp;
  const owner = {
    id: "LITERAL_SEARCH_OWNER",
    name: "Literal search owner",
    role: "user",
    email: "literal-search@example.test",
  };
  const literal = "%_\\[x](a).*";

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser(owner));
    await app.db.insert(app.schema.cases).values([
      buildCase({
        id: "LITERAL_CASE_A",
        userId: owner.id,
        clientName: `Literal ${literal} Alpha`,
        caseType: "Employment",
      }),
      buildCase({
        id: "LITERAL_CASE_B",
        userId: owner.id,
        clientName: `Literal ${literal} Beta`,
        caseType: "Employment",
      }),
      buildCase({
        id: "LITERAL_CASE_UNICODE",
        userId: owner.id,
        clientName: "Café Dossier",
        caseType: "Contract",
      }),
      buildCase({
        id: "LITERAL_CASE_DECOY",
        userId: owner.id,
        clientName: "Wildcard decoy",
        caseType: "General",
      }),
    ]);
    await app.db.insert(app.schema.evidence).values([
      buildEvidence({ id: "LITERAL_EVIDENCE_A", userId: owner.id, caseId: "LITERAL_CASE_A", title: `Evidence ${literal} A` }),
      buildEvidence({ id: "LITERAL_EVIDENCE_B", userId: owner.id, caseId: "LITERAL_CASE_A", title: `Evidence ${literal} B` }),
      buildEvidence({ id: "LITERAL_EVIDENCE_C", userId: owner.id, caseId: "LITERAL_CASE_A", title: `Evidence ${literal} C` }),
      buildEvidence({ id: "LITERAL_EVIDENCE_DECOY", userId: owner.id, caseId: "LITERAL_CASE_A", title: "Unrelated evidence" }),
    ]);
    await app.db.insert(app.schema.lawyers).values([
      buildLawyer({ id: "LITERAL_LAWYER", name: `Person ${literal}`, city: "Utrecht" }),
      buildLawyer({ id: "LITERAL_SUGGESTION", name: "Per%_son Counsel", city: "Per%_th" }),
      buildLawyer({ id: "LITERAL_LEGACY_BAD", name: "Legacy completeness bad", legalAreas: "{not-json" }),
      buildLawyer({ id: "LITERAL_LEGACY_GOOD", name: "Legacy completeness good", legalAreas: JSON.stringify(["Civil Law"]) }),
    ] as any);
    await app.db.insert(app.schema.documents).values({
      id: "LITERAL_DOCUMENT",
      userId: owner.id,
      caseId: "LITERAL_CASE_A",
      name: `Document ${literal}`,
      type: "letter",
      content: "Literal search document",
    });
    await app.db.insert(app.schema.communications).values({
      id: "LITERAL_COMMUNICATION",
      userId: owner.id,
      caseId: "LITERAL_CASE_A",
      subject: `Communication ${literal}`,
      content: "Literal search communication",
      type: "note",
      channel: "internal",
    });
  });

  afterAll(() => app?.cleanup());

  it("normalizes Unicode/case/spacing while preserving search punctuation", () => {
    expect(normalizeLiteralSearchText("  ＣＡＦÉ   %_\\[x](A).*  "))
      .toBe("café %_\\[x](a).*");
  });

  it("searches LIKE and regex metacharacters literally across every global category", async () => {
    const result = await app.makeCaller(owner).search.global({ query: literal, limit: 30 });
    const ids = result.results.map((item: { id: string }) => item.id);

    expect(ids).toEqual(expect.arrayContaining([
      "LITERAL_CASE_A",
      "LITERAL_CASE_B",
      "LITERAL_LAWYER",
      "LITERAL_EVIDENCE_A",
      "LITERAL_DOCUMENT",
      "LITERAL_COMMUNICATION",
    ]));
    expect(ids).not.toContain("LITERAL_CASE_DECOY");
    expect(ids).not.toContain("LITERAL_EVIDENCE_DECOY");
    expect(result).toMatchObject({
      normalizedQuery: literal.toLowerCase(),
      completeness: {
        contractVersion: LITERAL_SEARCH_CONTRACT_VERSION,
        status: "complete",
        completed: ["case", "lawyer", "evidence", "document", "communication"],
        partial: [],
        failed: [],
      },
    });

    const percent = await app.makeCaller(owner).search.global({ query: "%", types: ["case"] });
    const underscore = await app.makeCaller(owner).search.global({ query: "_", types: ["case"] });
    expect(percent.results.map((item: { id: string }) => item.id).sort())
      .toEqual(["LITERAL_CASE_A", "LITERAL_CASE_B"]);
    expect(underscore.results.map((item: { id: string }) => item.id).sort())
      .toEqual(["LITERAL_CASE_A", "LITERAL_CASE_B"]);

    await expect(app.makeCaller(owner).search.global({ query: "(" }))
      .resolves.toMatchObject({ completeness: { status: "complete" } });
  });

  it("uses the same literal contract for cases, evidence, timeline, lawyers, and saved execution", async () => {
    const caller = app.makeCaller(owner);
    const firstCases = await caller.cases.list({ search: literal, page: 1, limit: 1, sortBy: "clientName", sortDir: "asc" });
    const secondCases = await caller.cases.list({ search: literal, page: 2, limit: 1, sortBy: "clientName", sortDir: "asc" });
    expect(firstCases.pagination).toMatchObject({ total: 2, totalPages: 2 });
    expect(new Set([...firstCases.cases, ...secondCases.cases].map((item) => item.id)))
      .toEqual(new Set(["LITERAL_CASE_A", "LITERAL_CASE_B"]));

    const firstEvidence = await caller.evidenceFiles.search({ query: literal, limit: 2, offset: 0 });
    const secondEvidence = await caller.evidenceFiles.search({ query: literal, limit: 2, offset: 2 });
    expect(new Set([...firstEvidence, ...secondEvidence].map((item) => item.id)))
      .toEqual(new Set(["LITERAL_EVIDENCE_A", "LITERAL_EVIDENCE_B", "LITERAL_EVIDENCE_C"]));
    expect((await caller.evidenceTimeline.getTimeline({ search: literal })).map((item) => item.id).sort())
      .toEqual(["LITERAL_EVIDENCE_A", "LITERAL_EVIDENCE_B", "LITERAL_EVIDENCE_C"]);
    expect((await caller.lawyers.list({ query: literal })).lawyers.map((item) => item.id))
      .toEqual(["LITERAL_LAWYER"]);

    const saved = await caller.savedSearches.create({
      name: "Literal punctuation",
      query: literal,
      filters: {},
      searchType: "cases",
    });
    const loaded = await caller.savedSearches.get({ id: saved.id });
    expect(loaded).toMatchObject({ query: literal, queryContractVersion: LITERAL_SEARCH_CONTRACT_VERSION });
    const replayed = await caller.cases.list({ search: loaded!.query, limit: 10 });
    expect(replayed.pagination.total).toBe(2);
  });

  it("matches compatibility-equivalent Unicode and case consistently", async () => {
    const caller = app.makeCaller(owner);
    const global = await caller.search.global({ query: "ＣＡＦÉ", types: ["case"] });
    expect(global.results.map((item: { id: string }) => item.id)).toEqual(["LITERAL_CASE_UNICODE"]);
    expect((await caller.cases.list({ search: "ＣＡＦÉ" })).cases.map((item) => item.id))
      .toEqual(["LITERAL_CASE_UNICODE"]);
  });

  it("isolates malformed legacy metadata and reports the category as partial", async () => {
    const result = await app.makeCaller(owner).search.global({
      query: "Legacy completeness",
      types: ["case", "lawyer"],
    });
    expect(result.results.map((item: { id: string }) => item.id).sort())
      .toEqual(["LITERAL_LEGACY_BAD", "LITERAL_LEGACY_GOOD"]);
    expect(result.completeness).toMatchObject({
      status: "partial",
      requested: ["case", "lawyer"],
      completed: ["case"],
      partial: ["lawyer"],
      failed: [],
      categories: expect.arrayContaining([
        expect.objectContaining({
          type: "lawyer",
          status: "partial",
          resultCount: 2,
          malformedRows: 1,
          reason: "malformed_row_metadata",
        }),
      ]),
    });
  });

  it("reports one injected category failure without dropping successful categories or raw errors", async () => {
    const sqlite: any = app.db.$client;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    sqlite.prepare = (statement: string, ...args: unknown[]) => {
      if (/from\s+"lawyers"/i.test(statement)) {
        throw new Error("injected private database detail");
      }
      return originalPrepare(statement, ...args);
    };

    let result: Awaited<ReturnType<ReturnType<TestApp["makeCaller"]>["search"]["global"]>>;
    try {
      result = await app.makeCaller(owner).search.global({
        query: literal,
        types: ["case", "lawyer"],
      });
    } finally {
      sqlite.prepare = originalPrepare;
    }

    expect(result.results.map((item: { id: string }) => item.id).sort())
      .toEqual(["LITERAL_CASE_A", "LITERAL_CASE_B"]);
    expect(result.completeness).toMatchObject({
      status: "partial",
      requested: ["case", "lawyer"],
      completed: ["case"],
      partial: [],
      failed: ["lawyer"],
    });
    expect(JSON.stringify(result)).not.toContain("injected private database detail");
  });

  it("keeps literal prefix semantics and completeness for suggestions", async () => {
    const result = await app.makeCaller(owner).search.suggestions({ query: "Per%_", limit: 10 });
    expect(result.suggestions).toEqual(expect.arrayContaining(["Per%_son Counsel", "Per%_th"]));
    expect(result.completeness).toMatchObject({
      contractVersion: LITERAL_SEARCH_CONTRACT_VERSION,
      status: "complete",
      completed: ["case_types", "lawyer_names", "lawyer_cities"],
      failed: [],
    });
  });
});
