import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NOVA_BASE_URL,
  parseNovaProfile,
  parseNovaSearchResults,
  searchNovaDirectory,
  type NovaLawyerCandidate,
} from "../../server/novaDirectory";

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

const SEARCH_HTML = `
  <div class="result advocaten">
    <div class="heading">
      <a href="/advocaten/12345">Mr. Ada Voorbeeld</a>
      <strong>Voorbeeld Advocaten</strong>
      <strong>UTRECHT</strong>
      <span class="align-right">12,4 km</span>
    </div>
    <a href="/kantoren/987">Voorbeeld Advocaten</a>
    <div class="jurisdictions">
      <span class="label">Arbeidsrecht</span>
      <span class="label">Pensioenrecht</span>
    </div>
    <ul class="specialisations"><li>Vereniging Arbeidsrecht Advocaten Nederland</li></ul>
  </div>`;

describe("NOvA public directory adapter", () => {
  it("parses official search cards with source provenance and canonical legal areas", () => {
    const candidates = parseNovaSearchResults(
      SEARCH_HTML,
      ["Employment Law"],
      `${NOVA_BASE_URL}/zoeken?type=advocaten`,
      "2026-07-16T12:00:00.000Z",
      null,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      novaId: "12345",
      name: "Mr. Ada Voorbeeld",
      firmName: "Voorbeeld Advocaten",
      city: "Utrecht",
      canonicalLegalAreas: ["Employment Law"],
      officialLegalAreas: ["Arbeidsrecht", "Pensioenrecht"],
      distanceKm: 12.4,
      profileUrl: `${NOVA_BASE_URL}/advocaten/12345`,
    });
  });

  it("drops profile links that leave the official NOvA origin", () => {
    const maliciousHtml = SEARCH_HTML.replace(
      'href="/advocaten/12345"',
      'href="https://attacker.example/advocaten/12345"',
    );

    expect(parseNovaSearchResults(
      maliciousHtml,
      ["Employment Law"],
      `${NOVA_BASE_URL}/zoeken?type=advocaten`,
      "2026-07-16T12:00:00.000Z",
      null,
    )).toEqual([]);
  });

  it("enriches a candidate from an official profile without inventing unavailable fields", () => {
    const candidate: NovaLawyerCandidate = {
      novaId: "12345",
      name: "Ada Voorbeeld",
      firmName: null,
      city: "Utrecht",
      officialLegalAreas: ["Arbeidsrecht"],
      canonicalLegalAreas: ["Employment Law"],
      specializationAssociations: [],
      profileUrl: `${NOVA_BASE_URL}/advocaten/12345`,
      searchUrl: `${NOVA_BASE_URL}/zoeken?type=advocaten`,
      distanceKm: null,
      email: null,
      phone: null,
      website: null,
      address: null,
      admissionDate: null,
      district: null,
      financedLegalAid: null,
      retrievedAt: "2026-07-16T12:00:00.000Z",
      searchLocation: null,
    };
    const profileHtml = `
      <div class="lawyer-card">
        <div class="title">
          <h3>Mr. Ada Voorbeeld</h3>
          <a href="/kantoren/987">Voorbeeld Advocaten</a>
          <div class="icon-places"><span>UTRECHT</span></div>
        </div>
        <div class="label-group"><span class="label">Arbeidsrecht</span></div>
        <div class="row"><span class="meta-label">Beedigingsdatum</span><span class="columns">01-02-2010</span></div>
        <div class="row"><span class="meta-label">Arrondissement</span><span class="columns">Midden-Nederland</span></div>
        <div class="row"><span class="meta-label">Specialisatievereniging</span><div class="columns"><ul><li>VAAN</li></ul></div></div>
      </div>
      <div class="lawyer-info">
        <div class="row"><span class="meta-label">Bezoekadres</span><p>Maliebaan 1, 3581 AB Utrecht</p></div>
        <a href="mailto:ada@example.nl">Email</a>
        <a href="tel:+31301234567">Phone</a>
        <div class="row"><span class="meta-label">Website</span><a href="https://example.nl">Website</a></div>
      </div>`;

    expect(parseNovaProfile(profileHtml, candidate)).toMatchObject({
      name: "Mr. Ada Voorbeeld",
      firmName: "Voorbeeld Advocaten",
      city: "Utrecht",
      email: "ada@example.nl",
      phone: "+31301234567",
      website: "https://example.nl/",
      address: "Maliebaan 1, 3581 AB Utrecht",
      admissionDate: "01-02-2010",
      district: "Midden-Nederland",
      specializationAssociations: ["VAAN"],
    });
  });

  it("applies supported official filters without sending case narrative", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toContain(`${NOVA_BASE_URL}/zoeken/fetch?`);
      return new Response(JSON.stringify({ html: SEARCH_HTML, count: 2662 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchNovaDirectory({
      legalAreas: ["Employment Law"],
      requiresFinancedLegalAid: true,
      maxResults: 1,
      enrichProfiles: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requestedUrl.searchParams.get("filters[rechtsgebieden]")).toBe("[14]");
    expect(requestedUrl.searchParams.get("filters[toevoegingen]")).toBe("1");
    expect(requestedUrl.searchParams.get("type")).toBe("advocaten");
    expect(requestedUrl.toString()).not.toContain("case");
    expect(result.report).toMatchObject({
      status: "partial",
      reportedTotal: 2662,
      fetchedCandidates: 1,
      partialResults: true,
      filtersApplied: { legalAreas: true, financedLegalAid: true },
    });
    expect(result.candidates[0].financedLegalAid).toBe(true);
  });

  it("does not query NOvA when the official hostname resolves privately", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchNovaDirectory({
      legalAreas: ["Employment Law"],
      maxResults: 1,
      enrichProfiles: false,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.report.status).toBe("unavailable");
  });
});
