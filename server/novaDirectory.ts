import { load } from "cheerio";
import { fetchTrustedRemote } from "./trustedRemoteFetch";
import { getDb } from "./db";
import { lawyers } from "./schema";

export const NOVA_BASE_URL = "https://zoekeenadvocaat.advocatenorde.nl";
export const NOVA_SOURCE_NAME = "NOvA public lawyer finder";

const REQUEST_TIMEOUT_MS = 15_000;
const SEARCH_PAGE_SIZE = 10;
const MAX_DIRECTORY_RESULTS = 50;

const CANONICAL_TO_NOVA_IDS: Record<string, number[]> = {
  "corporate law": [35],
  "employment law": [14],
  "intellectual property": [198],
  "real estate": [24, 232],
  "family law": [2],
  "criminal law": [56],
  "tax law": [48],
  "immigration law": [68, 69],
  "contract law": [197],
  litigation: [200],
  bankruptcy: [51],
  "administrative law": [227],
  "environmental law": [70],
  "healthcare law": [72],
  "labor law": [14, 22],
  "mergers & acquisitions": [35],
  "securities law": [44],
  "trusts & estates": [9],
};

const OFFICIAL_TO_CANONICAL: Array<[RegExp, string]> = [
  [/arbeidsrecht|ambtenarenrecht|pensioen/i, "Employment Law"],
  [/personen- en familierecht|familierecht|jeugdbescherming/i, "Family Law"],
  [/strafrecht|slachtofferrecht|tbs|penitentiair/i, "Criminal Law"],
  [/belastingrecht|fiscaal/i, "Tax Law"],
  [/vreemdelingenrecht|asiel- en vluchtelingenrecht/i, "Immigration Law"],
  [/verbintenissenrecht|contract/i, "Contract Law"],
  [/burgerlijk procesrecht|litigation|arbitrage|beslag- en executie/i, "Litigation"],
  [/insolventierecht|faillissement|wsnp|surseance/i, "Bankruptcy"],
  [/bestuursrecht|ambtenarenrecht|subsidierecht|handhavingsrecht/i, "Administrative Law"],
  [/omgevingsrecht|milieurecht|natuurbescherming|waterrecht/i, "Environmental Law"],
  [/gezondheidsrecht|medisch/i, "Healthcare Law"],
  [/intellectueel eigendomsrecht|auteursrecht|merkenrecht|octrooi/i, "Intellectual Property"],
  [/huurrecht|vastgoedrecht|bouwrecht|burenrecht|erfpacht/i, "Real Estate"],
  [/ondernemingsrecht|vennootschap|fusies en overnames|bestuurdersaansprakelijkheid/i, "Corporate Law"],
  [/financieel recht|bankrecht|effecten/i, "Securities Law"],
  [/erfrecht/i, "Trusts & Estates"],
];

export interface NovaSearchCriteria {
  legalAreas: string[];
  lawyerName?: string;
  location?: string;
  radiusKm?: number;
  requireSpecializationAssociation?: boolean;
  requiresFinancedLegalAid?: boolean;
  maxResults?: number;
  enrichProfiles?: boolean;
}

export interface NovaLawyerCandidate {
  novaId: string;
  name: string;
  firmName: string | null;
  city: string | null;
  officialLegalAreas: string[];
  canonicalLegalAreas: string[];
  specializationAssociations: string[];
  profileUrl: string;
  searchUrl: string;
  distanceKm: number | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  admissionDate: string | null;
  district: string | null;
  financedLegalAid: boolean | null;
  retrievedAt: string;
  searchLocation: string | null;
}

export interface NovaDirectoryReport {
  status: "complete" | "partial" | "unavailable" | "not_applicable";
  source: typeof NOVA_SOURCE_NAME;
  sourceHomeUrl: string;
  retrievedAt: string;
  requestedLegalAreas: string[];
  officialSubjectIds: number[];
  locationRequested: string | null;
  resolvedLocation: string | null;
  locationApplied: boolean;
  radiusKm: number | null;
  filtersApplied: {
    legalAreas: boolean;
    lawyerName: boolean;
    location: boolean;
    specializationAssociation: boolean;
    financedLegalAid: boolean;
  };
  reportedTotal: number | null;
  fetchedCandidates: number;
  persistedCandidates: number;
  partialResults: boolean;
  searchUrls: string[];
  errors: string[];
  reason?: string;
}

interface ResolvedLocation {
  title: string;
  lat: string;
  lng: string;
  hash: string;
}

function cleanText(value: string | null | undefined): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function boundedRadius(value: number | undefined): number {
  if (!Number.isFinite(value)) return 50;
  if (Number(value) >= 56) return 56;
  return Math.max(5, Math.min(50, Math.round(Number(value))));
}

function boundedResults(value: number | undefined): number {
  if (!Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(MAX_DIRECTORY_RESULTS, Math.round(Number(value))));
}

function canonicalAreasForOfficialLabels(labels: string[], requestedAreas: string[]): string[] {
  const mapped = labels.flatMap((label) =>
    OFFICIAL_TO_CANONICAL.filter(([pattern]) => pattern.test(label)).map(([, area]) => area),
  );
  return unique(mapped.length > 0 ? mapped : requestedAreas).filter((area) => area !== "Other");
}

function subjectIdsForLegalAreas(legalAreas: string[]): number[] {
  return unique(legalAreas.flatMap((area) => CANONICAL_TO_NOVA_IDS[area.trim().toLowerCase()] || []));
}

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  const response = await fetchTrustedRemote(url, {
    allowedHosts: [new URL(NOVA_BASE_URL).hostname],
    timeoutMs: REQUEST_TIMEOUT_MS,
    init: { headers },
  });
  if (!response.ok) throw new Error(`NOvA returned HTTP ${response.status}`);
  return response;
}

function officialHeaders(jsonResponse = false): Record<string, string> {
  return {
    Accept: jsonResponse ? "application/json, text/javascript, */*; q=0.01" : "application/json",
    ...(jsonResponse ? { "X-Requested-With": "XMLHttpRequest" } : {}),
    "User-Agent": "LARO/1.3 legal-case-workspace",
    Referer: `${NOVA_BASE_URL}/zoeken`,
  };
}

async function resolveLocation(query: string): Promise<ResolvedLocation | null> {
  const url = new URL(`${NOVA_BASE_URL}/api/autocomplete/cities`);
  url.searchParams.set("filter", query);
  const response = await fetchWithTimeout(url.toString(), officialHeaders());
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) return null;
  const exact = payload.find((item) =>
    item && typeof item === "object" && cleanText(String((item as Record<string, unknown>).title)).toLowerCase() === query.trim().toLowerCase(),
  );
  const selected = (exact || payload[0]) as Record<string, unknown> | undefined;
  if (!selected || !selected.title || !selected.lat || !selected.lng || !selected.hash) return null;
  return {
    title: String(selected.title),
    lat: String(selected.lat),
    lng: String(selected.lng),
    hash: String(selected.hash),
  };
}

async function resolveSpecializationIds(subjectIds: number[]): Promise<number[]> {
  if (subjectIds.length === 0) return [];
  const url = new URL(`${NOVA_BASE_URL}/api/search/specialisations`);
  url.searchParams.set("rechtsgebieden", JSON.stringify(subjectIds));
  const response = await fetchWithTimeout(url.toString(), officialHeaders());
  const payload = await response.json() as unknown;
  const values = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { value?: unknown }).value)
      ? (payload as { value: unknown[] }).value
      : [];
  return unique(values.map(Number).filter(Number.isInteger));
}

function buildOfficialParams(
  criteria: NovaSearchCriteria,
  subjectIds: number[],
  location: ResolvedLocation | null,
  specializationIds: number[],
): URLSearchParams {
  const params = new URLSearchParams({ type: "advocaten" });
  if (subjectIds.length > 0) params.set("filters[rechtsgebieden]", JSON.stringify(subjectIds));
  if (criteria.lawyerName?.trim()) params.set("q", criteria.lawyerName.trim());
  if (location) {
    params.set("locatie[adres]", location.title);
    params.set("locatie[geo][lat]", location.lat);
    params.set("locatie[geo][lng]", location.lng);
    params.set("locatie[hash]", location.hash);
    params.set("locatie[straal]", String(boundedRadius(criteria.radiusKm)));
    params.set("sortering", "afstand");
  }
  if (criteria.requireSpecializationAssociation && specializationIds.length > 0) {
    params.set("filters[specialisatieverenigingen]", JSON.stringify(specializationIds));
  }
  if (criteria.requiresFinancedLegalAid) params.set("filters[toevoegingen]", "1");
  return params;
}

function absoluteNovaUrl(pathOrUrl: string): string {
  try {
    return new URL(pathOrUrl, NOVA_BASE_URL).toString();
  } catch {
    return NOVA_BASE_URL;
  }
}

function officialNovaUrl(pathOrUrl: string): string | null {
  try {
    const url = new URL(pathOrUrl, NOVA_BASE_URL);
    return url.protocol === "https:" && url.origin === new URL(NOVA_BASE_URL).origin
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function parseNovaSearchResults(
  html: string,
  requestedAreas: string[],
  searchUrl: string,
  retrievedAt: string,
  financedLegalAid: boolean | null,
): NovaLawyerCandidate[] {
  const $ = load(html || "");
  return $("div.result.advocaten").toArray().flatMap((element) => {
    const result = $(element);
    const profile = result.find('a[href*="/advocaten/"]').first();
    const profilePath = String(profile.attr("href") || "");
    if (!profilePath) return [];
    const office = result.find('a[href*="/kantoren/"]').first();
    const strongText = result.find(".heading strong").toArray().map((node) => cleanText($(node).text()));
    const officialLegalAreas = unique(result.find(".jurisdictions .label").toArray().map((node) => cleanText($(node).text())).filter(Boolean));
    const specializationAssociations = unique(result.find(".specialisations li").toArray().map((node) => cleanText($(node).text())).filter((value) => value && value.toLowerCase() !== "geen"));
    const distanceText = cleanText(result.find(".heading .align-right").first().text()).replace(",", ".");
    const distanceMatch = distanceText.match(/([0-9]+(?:\.[0-9]+)?)\s*km/i);
    const profileUrl = officialNovaUrl(profilePath);
    const novaId = profileUrl ? new URL(profileUrl).pathname.split("/").filter(Boolean).pop() : null;
    if (!novaId || !profileUrl) return [];
    return [{
      novaId,
      name: cleanText(profile.text()),
      firmName: cleanText(office.text()) || null,
      city: strongText.at(-1)?.toLocaleLowerCase("nl-NL").replace(/(^|\s)\S/g, (letter) => letter.toUpperCase()) || null,
      officialLegalAreas,
      canonicalLegalAreas: canonicalAreasForOfficialLabels(officialLegalAreas, requestedAreas),
      specializationAssociations,
      profileUrl,
      searchUrl,
      distanceKm: distanceMatch ? Number(distanceMatch[1]) : null,
      email: null,
      phone: null,
      website: null,
      address: null,
      admissionDate: null,
      district: null,
      financedLegalAid,
      retrievedAt,
      searchLocation: null,
    }];
  });
}

function rowValue($: ReturnType<typeof load>, label: string): string | null {
  const labelNode = $(".meta-label").filter((_, node) => cleanText($(node).text()).toLowerCase() === label.toLowerCase()).first();
  if (!labelNode.length) return null;
  const row = labelNode.closest(".row");
  const normalizedLabel = cleanText(labelNode.text()).toLowerCase();
  const values = row.find(".columns, .column").toArray()
    .map((node) => cleanText($(node).text()))
    .filter((value) => value && value.toLowerCase() !== normalizedLabel);
  if (values.length === 0) {
    values.push(...labelNode.nextAll().toArray().map((node) => cleanText($(node).text())).filter(Boolean));
  }
  return values.join(" ") || null;
}

export function parseNovaProfile(html: string, candidate: NovaLawyerCandidate): NovaLawyerCandidate {
  const $ = load(html || "");
  const profileCard = $(".lawyer-card").first();
  const officialLegalAreas = unique(profileCard.find(".label-group .label").toArray().map((node) => cleanText($(node).text())).filter(Boolean));
  const specializationAssociations = unique(
    profileCard.find(".meta-label").filter((_, node) => /specialisatievereniging/i.test(cleanText($(node).text())))
      .closest(".row").find("li").toArray().map((node) => cleanText($(node).text())).filter(Boolean),
  );
  const addressLabel = $(".lawyer-info .meta-label").filter((_, node) => /bezoekadres/i.test(cleanText($(node).text()))).first();
  const address = cleanText(addressLabel.nextAll("p").first().text()) || null;
  const emailHref = $('a[href^="mailto:"]').first().attr("href");
  const phoneHref = $('a[href^="tel:"]').first().attr("href");
  const websiteLink = $(".lawyer-info .meta-label").filter((_, node) => /website/i.test(cleanText($(node).text())))
    .closest(".row").find('a[href^="http"]').first().attr("href");
  const admissionDate = rowValue($, "Beedigingsdatum") || rowValue($, "Beedigingdatum") ||
    $(".meta-label").filter((_, node) => /be(?:e|\u00eb)digingsdatum/i.test(cleanText($(node).text())))
      .closest(".row").find(".columns").last().find("span").first().text().trim() || null;
  const firmName = cleanText(profileCard.find('.title a[href*="/kantoren/"]').first().text()) || candidate.firmName;
  const city = cleanText(profileCard.find(".title .icon-places span").first().text()) || candidate.city;

  return {
    ...candidate,
    name: cleanText(profileCard.find(".title h3").first().text()) || candidate.name,
    firmName,
    city: city ? city.toLocaleLowerCase("nl-NL").replace(/(^|\s)\S/g, (letter) => letter.toUpperCase()) : null,
    officialLegalAreas: officialLegalAreas.length > 0 ? officialLegalAreas : candidate.officialLegalAreas,
    canonicalLegalAreas: canonicalAreasForOfficialLabels(
      officialLegalAreas.length > 0 ? officialLegalAreas : candidate.officialLegalAreas,
      candidate.canonicalLegalAreas,
    ),
    specializationAssociations: specializationAssociations.length > 0 ? specializationAssociations : candidate.specializationAssociations,
    email: emailHref ? decodeURIComponent(emailHref.replace(/^mailto:/i, "")).trim() : candidate.email,
    phone: phoneHref ? decodeURIComponent(phoneHref.replace(/^tel:/i, "")).trim() : candidate.phone,
    website: websiteLink ? absoluteNovaUrl(websiteLink) : candidate.website,
    address: address || candidate.address,
    admissionDate: cleanText(admissionDate) || candidate.admissionDate,
    district: rowValue($, "Arrondissement") || candidate.district,
  };
}

async function enrichCandidate(candidate: NovaLawyerCandidate): Promise<NovaLawyerCandidate> {
  const response = await fetchWithTimeout(candidate.profileUrl, {
    Accept: "text/html,application/xhtml+xml",
    "User-Agent": officialHeaders()["User-Agent"],
    Referer: candidate.searchUrl,
  });
  return parseNovaProfile(await response.text(), candidate);
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await mapper(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function yearsFromAdmissionDate(value: string | null): string | null {
  const match = value?.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!match) return null;
  const admitted = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  if (Number.isNaN(admitted.getTime()) || admitted > new Date()) return null;
  const years = Math.floor((Date.now() - admitted.getTime()) / (365.2425 * 24 * 60 * 60 * 1000));
  return String(Math.max(0, years));
}

export async function searchNovaDirectory(criteria: NovaSearchCriteria): Promise<{ candidates: NovaLawyerCandidate[]; report: NovaDirectoryReport }> {
  const retrievedAt = new Date().toISOString();
  const subjectIds = subjectIdsForLegalAreas(criteria.legalAreas);
  const maxResults = boundedResults(criteria.maxResults);
  const errors: string[] = [];
  let location: ResolvedLocation | null = null;
  if (criteria.location?.trim()) {
    try {
      location = await resolveLocation(criteria.location.trim());
      if (!location) errors.push(`The official location service did not recognize "${criteria.location.trim()}".`);
    } catch (error) {
      errors.push(`Official location lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let specializationIds: number[] = [];
  if (criteria.requireSpecializationAssociation) {
    try {
      specializationIds = await resolveSpecializationIds(subjectIds);
      if (specializationIds.length === 0) errors.push("No official specialization-association filter could be resolved.");
    } catch (error) {
      errors.push(`Official specialization lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const baseReport: NovaDirectoryReport = {
    status: "not_applicable",
    source: NOVA_SOURCE_NAME,
    sourceHomeUrl: NOVA_BASE_URL,
    retrievedAt,
    requestedLegalAreas: criteria.legalAreas,
    officialSubjectIds: subjectIds,
    locationRequested: criteria.location?.trim() || null,
    resolvedLocation: location?.title || null,
    locationApplied: Boolean(location),
    radiusKm: location ? boundedRadius(criteria.radiusKm) : null,
    filtersApplied: {
      legalAreas: subjectIds.length > 0,
      lawyerName: Boolean(criteria.lawyerName?.trim()),
      location: Boolean(location),
      specializationAssociation: Boolean(criteria.requireSpecializationAssociation && specializationIds.length > 0),
      financedLegalAid: Boolean(criteria.requiresFinancedLegalAid),
    },
    reportedTotal: null,
    fetchedCandidates: 0,
    persistedCandidates: 0,
    partialResults: false,
    searchUrls: [],
    errors,
  };
  if (subjectIds.length === 0 && !criteria.lawyerName?.trim()) {
    return { candidates: [], report: { ...baseReport, reason: "No official NOvA legal-area filter could be resolved for this case." } };
  }

  const queryGroups = subjectIds.length > 1 ? subjectIds.map((id) => [id]) : [subjectIds];
  const candidates = new Map<string, NovaLawyerCandidate>();
  let reportedTotal = 0;
  let reportedTotalKnown = true;
  for (const subjectGroup of queryGroups) {
    const params = buildOfficialParams(criteria, subjectGroup, location, specializationIds);
    params.set("weergave", "lijst");
    const searchUrl = `${NOVA_BASE_URL}/zoeken?${params.toString()}`;
    baseReport.searchUrls.push(searchUrl);
    const targetForGroup = Math.max(SEARCH_PAGE_SIZE, Math.ceil(maxResults / queryGroups.length));
    const maxPages = Math.max(1, Math.ceil(targetForGroup / SEARCH_PAGE_SIZE));
    let groupTotal: number | null = null;

    for (let page = 1; page <= maxPages; page += 1) {
      const fetchParams = new URLSearchParams(params);
      fetchParams.delete("weergave");
      fetchParams.set("limiet", String(SEARCH_PAGE_SIZE));
      fetchParams.set("pagina", String(page));
      const fetchUrl = `${NOVA_BASE_URL}/zoeken/fetch?${fetchParams.toString()}`;
      try {
        const response = await fetchWithTimeout(fetchUrl, officialHeaders(true));
        const payload = await response.json() as { html?: unknown; count?: unknown };
        if (typeof payload.html !== "string") throw new Error("NOvA returned an invalid search payload");
        if (groupTotal === null && Number.isFinite(Number(payload.count))) groupTotal = Number(payload.count);
        const pageCandidates = parseNovaSearchResults(
          payload.html,
          criteria.legalAreas,
          searchUrl,
          retrievedAt,
          criteria.requiresFinancedLegalAid ? true : null,
        );
        for (const candidate of pageCandidates) if (!candidates.has(candidate.novaId)) candidates.set(candidate.novaId, candidate);
        if (pageCandidates.length < SEARCH_PAGE_SIZE || candidates.size >= maxResults) break;
      } catch (error) {
        errors.push(`Official NOvA query failed on page ${page}: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
    if (groupTotal === null) reportedTotalKnown = false;
    else reportedTotal += groupTotal;
    if (candidates.size >= maxResults) break;
  }

  let resolvedCandidates = [...candidates.values()].slice(0, maxResults);
  resolvedCandidates = resolvedCandidates.map((candidate) => ({
    ...candidate,
    searchLocation: location?.title || null,
  }));
  if (criteria.enrichProfiles !== false && resolvedCandidates.length > 0) {
    const enriched = await mapWithConcurrency(resolvedCandidates, 4, enrichCandidate);
    resolvedCandidates = enriched.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      errors.push(`Profile details unavailable for ${resolvedCandidates[index].name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      return resolvedCandidates[index];
    });
  }

  const knownTotal = reportedTotalKnown ? reportedTotal : null;
  const partialResults = errors.length > 0 || (knownTotal !== null && resolvedCandidates.length < knownTotal);
  return {
    candidates: resolvedCandidates,
    report: {
      ...baseReport,
      status: resolvedCandidates.length === 0 && errors.length > 0 ? "unavailable" : partialResults ? "partial" : "complete",
      reportedTotal: knownTotal,
      fetchedCandidates: resolvedCandidates.length,
      partialResults,
      reason: resolvedCandidates.length === 0 && errors.length > 0
        ? "The official directory could not provide candidates; no fallback records were fabricated."
        : undefined,
    },
  };
}

export async function persistNovaCandidates(candidates: NovaLawyerCandidate[]): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  let persisted = 0;
  for (const candidate of candidates) {
    const id = `NOVA-${candidate.novaId}`;
    const values = {
      id,
      novaId: candidate.novaId,
      name: candidate.name,
      city: candidate.city,
      firm: candidate.firmName,
      firmName: candidate.firmName,
      legalAreas: JSON.stringify(candidate.canonicalLegalAreas),
      officialLegalAreas: JSON.stringify(candidate.officialLegalAreas),
      specializationAssociations: JSON.stringify(candidate.specializationAssociations),
      email: candidate.email,
      phone: candidate.phone,
      website: candidate.website,
      address: candidate.address,
      experienceYears: yearsFromAdmissionDate(candidate.admissionDate),
      admissionDate: candidate.admissionDate,
      district: candidate.district,
      financedLegalAid: candidate.financedLegalAid === null ? "Unknown" : candidate.financedLegalAid ? "Yes" : "No",
      barAssociationStatus: "Registered in NOvA public directory",
      currentlyAccepting: "Unknown",
      caseStop: "Unknown",
      caseLoad: null,
      capacityPercentage: null,
      officialProfileUrl: candidate.profileUrl,
      directorySource: NOVA_SOURCE_NAME,
      directoryRetrievedAt: new Date(candidate.retrievedAt),
      directoryDistanceKm: candidate.distanceKm === null ? null : String(candidate.distanceKm),
      directorySearchLocation: candidate.searchLocation,
      updatedAt: new Date(),
    };
    await db.insert(lawyers).values({ ...values, createdAt: new Date() }).onConflictDoUpdate({
      target: lawyers.id,
      set: values,
    });
    persisted += 1;
  }
  return persisted;
}

export async function syncNovaLawyersForCase(
  caseData: { legalAreas: string | null },
  criteria: Omit<NovaSearchCriteria, "legalAreas"> = {},
): Promise<NovaDirectoryReport> {
  let legalAreas: string[] = [];
  try {
    const parsed = JSON.parse(caseData.legalAreas || "[]");
    if (Array.isArray(parsed)) legalAreas = parsed.map((area) => typeof area === "string" ? area : String(area?.area || area?.name || "")).filter(Boolean);
  } catch {
    legalAreas = [];
  }
  const result = await searchNovaDirectory({
    ...criteria,
    legalAreas,
    location: criteria.location?.trim() || undefined,
  });
  result.report.persistedCandidates = await persistNovaCandidates(result.candidates);
  return result.report;
}
