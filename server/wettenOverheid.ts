import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

const BWB_SRU_URL = "https://zoekservice.overheid.nl/sru/Search";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export type LegislationResult = {
  identifier: string;
  title: string;
  type: string | null;
  authority: string | null;
  legalAreas: string[];
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  modifiedAt: string | null;
  sourceUrl: string;
  versionUrl: string | null;
};

export type LegislationSearchResult = {
  success: true;
  query: string;
  asOfDate: string;
  retrievedAt: string;
  results: LegislationResult[];
  source: "KOOP Basiswettenbestand SRU 2.0";
  coverageNotice: string;
};

function cqlPhrase(value: string): string {
  return `"${value.replace(/[\\"]/g, (match) => `\\${match}`)}"`;
}

function text($record: cheerio.Cheerio<AnyNode>, selector: string): string | null {
  return $record.find(selector).first().text().trim() || null;
}

export function parseBwbSruResponse(xml: string, limit: number): LegislationResult[] {
  if (Buffer.byteLength(xml, "utf8") > MAX_RESPONSE_BYTES) throw new Error("KOOP legislation response exceeded the 5 MB safety limit");
  const $ = cheerio.load(xml, { xmlMode: true });
  const diagnostic = $("diagnostic message").first().text().trim();
  if (diagnostic) throw new Error(`KOOP legislation search rejected the query: ${diagnostic}`);
  const seen = new Set<string>();
  const results: LegislationResult[] = [];
  $("record").each((_, node) => {
    const record = $(node);
    const identifier = text(record, "dcterms\\:identifier");
    const title = text(record, "dcterms\\:title");
    if (!identifier || !title || seen.has(identifier) || results.length >= limit) return;
    seen.add(identifier);
    const versionUrl = text(record, "overheidbwb\\:toestand");
    results.push({
      identifier,
      title,
      type: text(record, "dcterms\\:type"),
      authority: text(record, "overheid\\:authority"),
      legalAreas: record.find("overheidbwb\\:rechtsgebied").toArray().map((item) => $(item).text().trim()).filter(Boolean),
      effectiveFrom: text(record, "overheidbwb\\:geldigheidsperiode_startdatum"),
      effectiveUntil: text(record, "overheidbwb\\:geldigheidsperiode_einddatum"),
      modifiedAt: text(record, "dcterms\\:modified"),
      sourceUrl: `https://wetten.overheid.nl/${encodeURIComponent(identifier)}/`,
      versionUrl: versionUrl?.replace(/^http:/, "https:") || null,
    });
  });
  return results;
}

export async function searchOfficialLegislation(options: {
  query: string;
  asOfDate?: string;
  limit?: number;
}): Promise<LegislationSearchResult> {
  const query = options.query.trim().replace(/\s+/g, " ");
  if (query.length < 3 || query.length > 200) throw new Error("Legislation search must contain 3 to 200 characters");
  const asOfDate = options.asOfDate || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate) || Number.isNaN(Date.parse(`${asOfDate}T00:00:00Z`))) {
    throw new Error("Legislation validity date must use YYYY-MM-DD");
  }
  const limit = Math.max(1, Math.min(25, options.limit ?? 10));
  const url = new URL(BWB_SRU_URL);
  url.searchParams.set("x-connection", "BWB");
  url.searchParams.set("operation", "searchRetrieve");
  url.searchParams.set("version", "2.0");
  url.searchParams.set("maximumRecords", String(Math.min(100, limit * 4)));
  url.searchParams.set("query", `(overheidbwb.titel any ${cqlPhrase(query)}) AND overheidbwb.geldigheidsdatum=${asOfDate}`);

  const response = await fetch(url, {
    headers: { accept: "application/xml", "user-agent": "LARO/1.3 official-legislation-client" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`KOOP legislation search returned HTTP ${response.status}`);
  const xml = await response.text();
  return {
    success: true,
    query,
    asOfDate,
    retrievedAt: new Date().toISOString(),
    results: parseBwbSruResponse(xml, limit),
    source: "KOOP Basiswettenbestand SRU 2.0",
    coverageNotice: "Results are official consolidated Dutch legislation valid on the selected date. Relevance and applicability still require legal review.",
  };
}
