import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBwbSruResponse, searchOfficialLegislation } from "../../server/wettenOverheid";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<searchRetrieveResponse xmlns="http://docs.oasis-open.org/ns/search-ws/sruResponse">
  <numberOfRecords>1</numberOfRecords>
  <records><record><recordData>
    <gzd xmlns="http://standaarden.overheid.nl/sru" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:overheid="http://standaarden.overheid.nl/owms/terms/" xmlns:overheidbwb="http://standaarden.overheid.nl/bwb/terms/">
      <originalData><overheidbwb:meta><owmskern>
        <dcterms:identifier>BWBR0005537</dcterms:identifier>
        <dcterms:title>Algemene wet bestuursrecht</dcterms:title>
        <dcterms:type>wet</dcterms:type>
        <overheid:authority>Veiligheid en Justitie</overheid:authority>
        <dcterms:modified>2026-08-01</dcterms:modified>
      </owmskern><bwbipm>
        <overheidbwb:toestand>http://wetten.overheid.nl/id/BWBR0005537/2026-08-01/0</overheidbwb:toestand>
        <overheidbwb:rechtsgebied>Bestuursrecht</overheidbwb:rechtsgebied>
        <overheidbwb:geldigheidsperiode_startdatum>2026-08-01</overheidbwb:geldigheidsperiode_startdatum>
        <overheidbwb:geldigheidsperiode_einddatum>9999-12-31</overheidbwb:geldigheidsperiode_einddatum>
      </bwbipm></overheidbwb:meta></originalData>
    </gzd>
  </recordData></record></records>
</searchRetrieveResponse>`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("KOOP Basiswettenbestand integration", () => {
  it("preserves official identifiers, validity, areas, and source URLs", () => {
    expect(parseBwbSruResponse(XML, 10)).toEqual([{
      identifier: "BWBR0005537",
      title: "Algemene wet bestuursrecht",
      type: "wet",
      authority: "Veiligheid en Justitie",
      legalAreas: ["Bestuursrecht"],
      effectiveFrom: "2026-08-01",
      effectiveUntil: "9999-12-31",
      modifiedAt: "2026-08-01",
      sourceUrl: "https://wetten.overheid.nl/BWBR0005537/",
      versionUrl: "https://wetten.overheid.nl/id/BWBR0005537/2026-08-01/0",
    }]);
  });

  it("sends a bounded title and effective-date query only to the official HTTPS endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(XML, { status: 200, headers: { "content-type": "application/xml" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await searchOfficialLegislation({ query: "Algemene wet bestuursrecht", asOfDate: "2026-08-14", limit: 5 });
    expect(result.results).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.origin).toBe("https://zoekservice.overheid.nl");
    expect(url.searchParams.get("x-connection")).toBe("BWB");
    expect(url.searchParams.get("query")).toContain("overheidbwb.geldigheidsdatum=2026-08-14");
    expect(init.redirect).toBe("error");
  });

  it("fails closed on invalid validity dates and SRU diagnostics", async () => {
    await expect(searchOfficialLegislation({ query: "bestuursrecht", asOfDate: "14-08-2026" })).rejects.toThrow("YYYY-MM-DD");
    expect(() => parseBwbSruResponse("<diagnostics><diagnostic><message>Bad query</message></diagnostic></diagnostics>", 10))
      .toThrow("Bad query");
  });

  it("rejects oversized official responses before XML parsing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(XML, {
      status: 200,
      headers: { "content-length": String(5 * 1024 * 1024 + 1) },
    })));

    await expect(searchOfficialLegislation({ query: "bestuursrecht" }))
      .rejects.toThrow("5 MB response limit");
  });
});
