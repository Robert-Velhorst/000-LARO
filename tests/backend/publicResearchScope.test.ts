import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildCase, buildUser } from "../factories";

const suite = sqliteAvailable ? describe : describe.skip;
const EMPTY_RSS = `<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>`;
const LEGISLATION_XML = `<?xml version="1.0"?>
<searchRetrieveResponse xmlns="http://docs.oasis-open.org/ns/search-ws/sruResponse">
  <numberOfRecords>1</numberOfRecords>
  <records><record><recordData>
    <gzd xmlns="http://standaarden.overheid.nl/sru" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:overheidbwb="http://standaarden.overheid.nl/bwb/terms/">
      <originalData><overheidbwb:meta><owmskern>
        <dcterms:identifier>BWBR0005537</dcterms:identifier>
        <dcterms:title>Algemene wet bestuursrecht</dcterms:title>
      </owmskern><bwbipm><overheidbwb:geldigheidsperiode_einddatum>9999-12-31</overheidbwb:geldigheidsperiode_einddatum></bwbipm></overheidbwb:meta></originalData>
    </gzd>
  </recordData></record></records>
</searchRetrieveResponse>`;

suite("case-scoped public research", () => {
  let app: TestApp;
  const owner = { id: "PUBLIC_RESEARCH_OWNER", email: "research-owner@example.test", role: "user" };
  const other = { id: "PUBLIC_RESEARCH_OTHER", email: "research-other@example.test", role: "user" };
  const caseId = "CASE_PUBLIC_RESEARCH";

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser(owner),
      buildUser(other),
    ]);
    await app.db.insert(app.schema.cases).values(buildCase({ id: caseId, userId: owner.id }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  afterAll(() => app?.cleanup());

  it("rejects KvK, Rechtspraak, and legislation research for another user's case before provider contact", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const caller = app.makeCaller(other);

    await expect(caller.gapAnalysis.lookupCompany({ caseId, kvkNumber: "59581883" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.gapAnalysis.searchCourtRecords({
      caseId, companyName: "Example Company BV", searchType: "company_history",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.gapAnalysis.getOpponentHistory({ caseId, companyName: "Example Company BV" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.gapAnalysis.searchLegislation({ caseId, query: "bestuursrecht" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records provider unavailability with null counts instead of a zero-history claim", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));

    const result = await app.makeCaller(owner).gapAnalysis.searchCourtRecords({
      caseId,
      companyName: "  Example   Company BV  ",
      searchType: "company_history",
    });

    expect(result).toMatchObject({
      success: false,
      outcome: "unavailable",
      totalResults: null,
      decisions: [],
      opponentHistory: {
        success: false,
        totalCases: null,
        wonCases: null,
        lostCases: null,
      },
      research: {
        contractVersion: "case-public-research-v1",
        caseId,
        source: "rechtspraak_rss",
        normalizedQuery: "example company bv",
        resultCount: null,
        completeness: "unavailable",
        empty: false,
      },
    });

    const [audit] = await app.db.select().from(app.schema.auditLogs).where(and(
      eq(app.schema.auditLogs.id, result.research.recordId),
      eq(app.schema.auditLogs.entityId, caseId),
    ));
    expect(JSON.parse(audit.details)).toMatchObject({
      source: "rechtspraak_rss",
      normalizedQuery: "example company bv",
      resultCount: null,
      completeness: "unavailable",
      empty: false,
    });
  });

  it("represents an exact KvK no-match as a complete zero without inferring company status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));

    const result = await app.makeCaller(owner).gapAnalysis.lookupCompany({
      caseId,
      kvkNumber: "33333333",
    });

    expect(result).toMatchObject({
      success: false,
      outcome: "empty",
      research: {
        resultCount: 0,
        completeness: "complete",
        empty: true,
      },
    });
  });

  it("keeps a zero-result Rechtspraak RSS response partial and explicitly inconclusive", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(EMPTY_RSS, { status: 200 })));

    const result = await app.makeCaller(owner).gapAnalysis.searchCourtRecords({
      caseId,
      companyName: "No Published Match BV",
      searchType: "company_history",
    });

    expect(result).toMatchObject({
      success: true,
      outcome: "partial",
      totalResults: 0,
      opponentHistory: { success: true, totalCases: 0 },
      research: {
        resultCount: 0,
        completeness: "partial",
        empty: false,
      },
    });
    expect(result.legalSignificance).toContain("does not prove that no litigation exists");
  });

  it("records successful KvK and legislation research without copying provider result content into history", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        datumAanvang: "20100101",
        actief: "N",
        insolventieCode: "FAIL",
        rechtsvormCode: "BV",
        postcodeRegio: "10",
        activiteiten: [],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(LEGISLATION_XML, { status: 200, headers: { "content-type": "application/xml" } }));
    vi.stubGlobal("fetch", fetchMock);
    const caller = app.makeCaller(owner);

    const kvk = await caller.gapAnalysis.lookupCompany({ caseId, kvkNumber: "44444444" });
    const legislation = await caller.gapAnalysis.searchLegislation({
      caseId,
      query: "  Algemene   Wet Bestuursrecht  ",
      asOfDate: "2026-09-19",
      limit: 10,
    });

    expect(kvk).toMatchObject({
      success: true,
      outcome: "complete",
      research: { completeness: "complete", resultCount: 1, empty: false },
    });
    expect(kvk.data?.insolvencyStatus?.code).toBe("FAIL");
    expect(legislation).toMatchObject({
      success: true,
      completeness: "complete",
      totalAvailable: 1,
      research: {
        source: "koop_bwb_sru",
        normalizedQuery: "algemene wet bestuursrecht",
        completeness: "complete",
        resultCount: 1,
      },
    });

    const audits = await app.db.select().from(app.schema.auditLogs).where(and(
      eq(app.schema.auditLogs.userId, owner.id),
      eq(app.schema.auditLogs.action, "legal_source.public_research_recorded"),
    ));
    const details = audits
      .filter((row: any) => [kvk.research.recordId, legislation.research.recordId].includes(row.id))
      .map((row: any) => row.details);
    expect(details).toHaveLength(2);
    expect(details.join(" ")).not.toContain("BWBR0005537");
    expect(details.join(" ")).not.toContain("FAIL");
  });
});
