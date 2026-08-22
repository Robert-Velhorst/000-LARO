import { load } from "cheerio";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { readBoundedResponseText, withBoundedHttpResponse } from "./boundedHttpResponse";
import { getDb } from "./db";
import {
  caseOutreachTargetMatches,
  cases,
  outreachDirectoryTargets,
} from "./schema";

export type OutreachTargetType = "media" | "organization";
export type OutreachTargetReviewStatus = "pending" | "approved" | "rejected";
export type OutreachTargetMatchStatus = "suggested" | "shortlisted" | "contacted" | "dismissed";

export const PUBLIC_DISCOVERY_PROVIDER = "DuckDuckGo public web search";
const PUBLIC_DISCOVERY_URL = "https://html.duckduckgo.com/html/";
const DISCOVERY_TIMEOUT_MS = 12_000;
const DISCOVERY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DISCOVERY_QUERIES = 6;
const MAX_DISCOVERY_RESULTS = 60;

const LEGAL_AREA_NL: Record<string, string> = {
  "Corporate Law": "ondernemingsrecht",
  "Employment Law": "arbeidsrecht",
  "Labor Law": "arbeidsrecht vakbond",
  "Intellectual Property": "intellectueel eigendomsrecht",
  "Real Estate": "huurrecht vastgoedrecht",
  "Family Law": "personen- en familierecht",
  "Criminal Law": "strafrecht",
  "Tax Law": "belastingrecht",
  "Immigration Law": "vreemdelingenrecht asielrecht",
  "Contract Law": "verbintenissenrecht contract",
  Litigation: "burgerlijk procesrecht",
  Bankruptcy: "insolventierecht",
  "Administrative Law": "bestuursrecht",
  "Environmental Law": "omgevingsrecht milieurecht",
  "Healthcare Law": "gezondheidsrecht",
  "Mergers & Acquisitions": "ondernemingsrecht fusies overnames",
  "Securities Law": "financieel recht",
  "Trusts & Estates": "erfrecht",
};

const DISCOVERY_PILLARS: Record<OutreachTargetType, Array<{ id: string; terms: string }>> = {
  media: [
    { id: "newsroom", terms: "journalist redactie" },
    { id: "investigative", terms: "onderzoeksjournalist programma podcast" },
    { id: "current_affairs", terms: "nieuws actualiteiten dossier" },
    { id: "public_interest", terms: "consumentenprogramma omroep reportage" },
  ],
  organization: [
    { id: "advocacy", terms: "belangenorganisatie vereniging" },
    { id: "support", terms: "stichting hulp advies" },
    { id: "representation", terms: "belangenbehartiging lobby" },
    { id: "ombuds_support", terms: "meldpunt ombudsman ondersteuning" },
  ],
};

export interface OutreachDiscoveryCandidate {
  targetType: OutreachTargetType;
  name: string;
  subtype: string;
  description: string;
  topics: string[];
  legalAreas: string[];
  audience: string[];
  channels: string[];
  region: string;
  url: string;
  contactUrl: string;
  sourceUrl: string;
  sourceLabel: typeof PUBLIC_DISCOVERY_PROVIDER;
  sourceRetrievedAt: Date;
  confidence: "discovery_candidate";
}

export interface OutreachDiscoveryReport {
  provider: typeof PUBLIC_DISCOVERY_PROVIDER;
  targetType: OutreachTargetType;
  rawCaseTextShared: false;
  plannedQueries: Array<{ query: string; pillar: string; legalArea: string }>;
  completedQueries: number;
  failedQueries: number;
  discoveredCandidates: number;
  newCandidates: number;
  existingCandidates: number;
  errors: string[];
  status: "complete" | "partial" | "unavailable";
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).map((item) => item.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function tokenize(value: string): string[] {
  const stopWords = new Set([
    "and", "the", "een", "het", "de", "van", "voor", "met", "law", "recht",
    "naar", "bij", "uit", "dat", "dit", "zijn", "haar", "hun", "case", "zaak",
  ]);
  return unique(
    String(value || "")
      .toLocaleLowerCase("nl-NL")
      .replace(/[^a-z0-9\u00c0-\u024f]+/gi, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !stopWords.has(word)),
  );
}

function normalizePublicUrl(rawUrl: string): string | null {
  try {
    let url = new URL(rawUrl, PUBLIC_DISCOVERY_URL);
    if (url.hostname.endsWith("duckduckgo.com")) {
      const redirect = url.searchParams.get("uddg");
      if (redirect) url = new URL(decodeURIComponent(redirect));
    }
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function classifySubtype(targetType: OutreachTargetType, text: string): string {
  const normalized = text.toLocaleLowerCase("nl-NL");
  if (targetType === "media") {
    if (/journalist|verslaggever|redacteur/.test(normalized)) return "journalist";
    if (/podcast|radio/.test(normalized)) return "radio or podcast";
    if (/televisie|tv|programma|omroep/.test(normalized)) return "broadcast program";
    if (/onderzoek|investigat/.test(normalized)) return "investigative media";
    return "newsroom or publication";
  }
  if (/ombudsman|meldpunt|loket/.test(normalized)) return "ombuds or support service";
  if (/belangen|lobby|advocacy/.test(normalized)) return "advocacy group";
  if (/vereniging|association/.test(normalized)) return "association";
  if (/stichting|foundation/.test(normalized)) return "foundation";
  return "civil-society organization";
}

function parseSearchResults(
  html: string,
  targetType: OutreachTargetType,
  legalArea: string,
  pillar: string,
  retrievedAt: Date,
  limit: number,
): OutreachDiscoveryCandidate[] {
  const $ = load(html || "");
  const candidates: OutreachDiscoveryCandidate[] = [];
  const seen = new Set<string>();
  $("a.result__a, a[data-testid='result-title-a']").each((_, node) => {
    if (candidates.length >= limit) return false;
    const link = $(node);
    const url = normalizePublicUrl(String(link.attr("href") || ""));
    const name = link.text().replace(/\s+/g, " ").trim();
    if (!url || !name || seen.has(url)) return;
    seen.add(url);
    const container = link.closest(".result, article");
    const description = container.find(".result__snippet, [data-result='snippet'], [data-testid='result-snippet']")
      .first().text().replace(/\s+/g, " ").trim().slice(0, 2_000);
    candidates.push({
      targetType,
      name: name.slice(0, 255),
      subtype: classifySubtype(targetType, `${name} ${description}`),
      description,
      topics: [pillar],
      legalAreas: [legalArea],
      audience: [],
      channels: ["web"],
      region: "Netherlands",
      url,
      contactUrl: url,
      sourceUrl: url,
      sourceLabel: PUBLIC_DISCOVERY_PROVIDER,
      sourceRetrievedAt: retrievedAt,
      confidence: "discovery_candidate",
    });
  });
  return candidates;
}

async function fetchPublicSearch(query: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const url = new URL(PUBLIC_DISCOVERY_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("kl", "nl-nl");
    const { html, status } = await withBoundedHttpResponse(
      () => fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "LARO/1.3 local outreach discovery",
        },
      }),
      async (response) => {
        if (!response.ok) throw new Error(`Public search returned HTTP ${response.status}`);
        const html = await readBoundedResponseText(response, {
          maxBytes: DISCOVERY_MAX_RESPONSE_BYTES,
          label: "Public outreach discovery response",
        });
        return { html, status: response.status };
      },
    );
    const lower = html.toLocaleLowerCase("en-US");
    if (
      status === 202 ||
      lower.includes('id="challenge-form"') ||
      lower.includes("confirm this search was made by a human")
    ) {
      throw new Error("Public search requested human verification");
    }
    return html;
  } finally {
    clearTimeout(timeout);
  }
}

function buildQueryPlan(
  targetType: OutreachTargetType,
  legalAreas: string[],
  maxQueries: number,
): Array<{ query: string; pillar: string; legalArea: string }> {
  const areas = unique(legalAreas).filter((area) => Boolean(LEGAL_AREA_NL[area])).slice(0, 4);
  const plan: Array<{ query: string; pillar: string; legalArea: string }> = [];
  for (const pillar of DISCOVERY_PILLARS[targetType]) {
    for (const area of areas) {
      const publicArea = LEGAL_AREA_NL[area];
      plan.push({
        query: `Nederland ${publicArea} ${pillar.terms}`.slice(0, 240),
        pillar: pillar.id,
        legalArea: area,
      });
      if (plan.length >= maxQueries) return plan;
    }
  }
  return plan;
}

async function persistCandidates(
  userId: string,
  candidates: OutreachDiscoveryCandidate[],
): Promise<{ created: number; existing: number }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  let created = 0;
  let existing = 0;
  for (const candidate of candidates) {
    const rows = await db.select({
      id: outreachDirectoryTargets.id,
      topics: outreachDirectoryTargets.topics,
      legalAreas: outreachDirectoryTargets.legalAreas,
    })
      .from(outreachDirectoryTargets)
      .where(and(
        eq(outreachDirectoryTargets.userId, userId),
        eq(outreachDirectoryTargets.targetType, candidate.targetType),
        eq(outreachDirectoryTargets.url, candidate.url),
      ))
      .limit(1);
    const now = new Date();
    if (rows[0]) {
      existing += 1;
      await db.update(outreachDirectoryTargets).set({
        name: candidate.name,
        subtype: candidate.subtype,
        description: candidate.description,
        topics: JSON.stringify(unique([...parseStringArray(rows[0].topics), ...candidate.topics])),
        legalAreas: JSON.stringify(unique([...parseStringArray(rows[0].legalAreas), ...candidate.legalAreas])),
        sourceUrl: candidate.sourceUrl,
        sourceLabel: candidate.sourceLabel,
        sourceRetrievedAt: candidate.sourceRetrievedAt,
        updatedAt: now,
      }).where(eq(outreachDirectoryTargets.id, rows[0].id));
      continue;
    }
    await db.insert(outreachDirectoryTargets).values({
      id: `TARGET-${nanoid(16)}`,
      userId,
      targetType: candidate.targetType,
      name: candidate.name,
      subtype: candidate.subtype,
      description: candidate.description,
      topics: JSON.stringify(candidate.topics),
      legalAreas: JSON.stringify(candidate.legalAreas),
      audience: JSON.stringify(candidate.audience),
      channels: JSON.stringify(candidate.channels),
      region: candidate.region,
      url: candidate.url,
      contactUrl: candidate.contactUrl,
      sourceUrl: candidate.sourceUrl,
      sourceLabel: candidate.sourceLabel,
      sourceRetrievedAt: candidate.sourceRetrievedAt,
      status: "pending",
      confidence: candidate.confidence,
      createdAt: now,
      updatedAt: now,
    });
    created += 1;
  }
  return { created, existing };
}

export async function discoverOutreachTargetsForCase(options: {
  userId: string;
  caseId: string;
  targetType: OutreachTargetType;
  maxQueries?: number;
  maxResults?: number;
}): Promise<OutreachDiscoveryReport> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const caseRows = await db.select().from(cases).where(and(
    eq(cases.id, options.caseId),
    eq(cases.userId, options.userId),
  )).limit(1);
  const caseData = caseRows[0];
  if (!caseData) throw new Error("Case not found");
  const legalAreas = parseStringArray(caseData.legalAreas);
  if (legalAreas.filter((area) => area !== "Other").length === 0) {
    throw new Error("Analyze or classify the case before discovering outreach targets");
  }
  const maxQueries = Math.max(1, Math.min(MAX_DISCOVERY_QUERIES, Math.round(options.maxQueries || 4)));
  const maxResults = Math.max(1, Math.min(MAX_DISCOVERY_RESULTS, Math.round(options.maxResults || 30)));
  const plan = buildQueryPlan(options.targetType, legalAreas, maxQueries);
  if (plan.length === 0) {
    throw new Error("Classify the case with a supported legal area before public discovery");
  }
  const retrievedAt = new Date();
  const settled = await Promise.allSettled(plan.map(async (item) => ({
    item,
    html: await fetchPublicSearch(item.query),
  })));
  const errors: string[] = [];
  const byUrl = new Map<string, OutreachDiscoveryCandidate>();
  let completedQueries = 0;
  for (const [index, result] of settled.entries()) {
    if (result.status === "rejected") {
      errors.push(`${plan[index].pillar}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      continue;
    }
    completedQueries += 1;
    const candidates = parseSearchResults(
      result.value.html,
      options.targetType,
      result.value.item.legalArea,
      result.value.item.pillar,
      retrievedAt,
      Math.max(5, Math.ceil(maxResults / plan.length)),
    );
    for (const candidate of candidates) {
      const existing = byUrl.get(candidate.url);
      if (!existing) {
        byUrl.set(candidate.url, candidate);
      } else {
        existing.topics = unique([...existing.topics, ...candidate.topics]);
        existing.legalAreas = unique([...existing.legalAreas, ...candidate.legalAreas]);
      }
    }
  }
  const candidates = [...byUrl.values()].slice(0, maxResults);
  const persisted = await persistCandidates(options.userId, candidates);
  return {
    provider: PUBLIC_DISCOVERY_PROVIDER,
    targetType: options.targetType,
    rawCaseTextShared: false,
    plannedQueries: plan,
    completedQueries,
    failedQueries: errors.length,
    discoveredCandidates: candidates.length,
    newCandidates: persisted.created,
    existingCandidates: persisted.existing,
    errors,
    status: completedQueries === 0 ? "unavailable" : errors.length > 0 ? "partial" : "complete",
  };
}

export async function createManualOutreachTarget(input: {
  userId: string;
  targetType: OutreachTargetType;
  name: string;
  url: string;
  description?: string;
  subtype?: string;
  contactUrl?: string;
  legalAreas?: string[];
}): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const normalizedUrl = normalizePublicUrl(input.url);
  const normalizedContactUrl = normalizePublicUrl(input.contactUrl || input.url);
  if (!normalizedUrl || !normalizedContactUrl) throw new Error("Use a valid public http(s) URL");
  const existing = await db.select({ id: outreachDirectoryTargets.id }).from(outreachDirectoryTargets).where(and(
    eq(outreachDirectoryTargets.userId, input.userId),
    eq(outreachDirectoryTargets.targetType, input.targetType),
    eq(outreachDirectoryTargets.url, normalizedUrl),
  )).limit(1);
  if (existing[0]) return existing[0].id;
  const id = `TARGET-${nanoid(16)}`;
  const now = new Date();
  await db.insert(outreachDirectoryTargets).values({
    id,
    userId: input.userId,
    targetType: input.targetType,
    name: input.name.trim(),
    subtype: input.subtype?.trim() || "manual directory record",
    description: input.description?.trim() || null,
    topics: JSON.stringify([]),
    legalAreas: JSON.stringify(unique(input.legalAreas || [])),
    audience: JSON.stringify([]),
    channels: JSON.stringify(["web"]),
    region: "Netherlands",
    url: normalizedUrl,
    contactUrl: normalizedContactUrl,
    sourceUrl: normalizedUrl,
    sourceLabel: "Manual public source",
    sourceRetrievedAt: now,
    status: "pending",
    confidence: "manual_candidate",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

function serializeTarget(target: typeof outreachDirectoryTargets.$inferSelect) {
  return {
    ...target,
    topics: parseStringArray(target.topics),
    legalAreas: parseStringArray(target.legalAreas),
    audience: parseStringArray(target.audience),
    channels: parseStringArray(target.channels),
  };
}

export async function listOutreachTargets(options: {
  userId: string;
  targetType: OutreachTargetType;
  status?: OutreachTargetReviewStatus;
  limit?: number;
}) {
  const db = await getDb();
  if (!db) return [];
  const conditions = [
    eq(outreachDirectoryTargets.userId, options.userId),
    eq(outreachDirectoryTargets.targetType, options.targetType),
  ];
  if (options.status) conditions.push(eq(outreachDirectoryTargets.status, options.status));
  const rows = await db.select().from(outreachDirectoryTargets)
    .where(and(...conditions))
    .orderBy(desc(outreachDirectoryTargets.updatedAt))
    .limit(Math.max(1, Math.min(200, options.limit || 100)));
  return rows.map(serializeTarget);
}

export async function reviewOutreachTarget(options: {
  userId: string;
  id: string;
  targetType: OutreachTargetType;
  status: OutreachTargetReviewStatus;
  reviewNotes?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const now = new Date();
  const result = await db.update(outreachDirectoryTargets).set({
    status: options.status,
    reviewNotes: options.reviewNotes?.trim() || null,
    reviewedAt: now,
    updatedAt: now,
  }).where(and(
    eq(outreachDirectoryTargets.id, options.id),
    eq(outreachDirectoryTargets.userId, options.userId),
    eq(outreachDirectoryTargets.targetType, options.targetType),
  ));
  if (!result.changes) throw new Error("Outreach target not found");
  if (options.status !== "approved") {
    await db.delete(caseOutreachTargetMatches).where(and(
      eq(caseOutreachTargetMatches.userId, options.userId),
      eq(caseOutreachTargetMatches.targetId, options.id),
    ));
  }
  return { success: true as const, targetType: options.targetType };
}

export async function reviewOutreachTargetsBatch(options: {
  userId: string;
  ids: string[];
  targetType: OutreachTargetType;
  status: "approved" | "rejected";
  reviewNotes: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const ids = [...new Set(options.ids)];
  if (ids.length !== options.ids.length) throw new Error("Duplicate outreach target IDs are not allowed");
  return db.transaction((tx) => {
    const rows = tx.select({ id: outreachDirectoryTargets.id })
      .from(outreachDirectoryTargets)
      .where(and(
        eq(outreachDirectoryTargets.userId, options.userId),
        eq(outreachDirectoryTargets.targetType, options.targetType),
        inArray(outreachDirectoryTargets.id, ids),
      ))
      .all();
    if (rows.length !== ids.length) throw new Error("One or more outreach targets were not found");
    const now = new Date();
    tx.update(outreachDirectoryTargets).set({
      status: options.status,
      reviewNotes: options.reviewNotes.trim() || null,
      reviewedAt: now,
      updatedAt: now,
    }).where(and(
      eq(outreachDirectoryTargets.userId, options.userId),
      eq(outreachDirectoryTargets.targetType, options.targetType),
      inArray(outreachDirectoryTargets.id, ids),
    )).run();
    if (options.status !== "approved") {
      tx.delete(caseOutreachTargetMatches).where(and(
        eq(caseOutreachTargetMatches.userId, options.userId),
        inArray(caseOutreachTargetMatches.targetId, ids),
      )).run();
    }
    return { success: true as const, reviewed: ids.length };
  });
}

function scoreTarget(
  target: typeof outreachDirectoryTargets.$inferSelect,
  caseData: typeof cases.$inferSelect,
): { score: number; breakdown: Record<string, number>; reasons: string[] } | null {
  const caseAreas = parseStringArray(caseData.legalAreas);
  const targetAreas = parseStringArray(target.legalAreas);
  const areaOverlap = caseAreas.filter((area) => targetAreas.includes(area));
  const caseTerms = new Set(tokenize(`${caseData.caseSummary || ""} ${caseData.caseType || ""} ${caseAreas.join(" ")}`));
  const targetTerms = new Set(tokenize([
    target.name,
    target.description || "",
    target.subtype || "",
    ...parseStringArray(target.topics),
    ...targetAreas,
    ...parseStringArray(target.audience),
  ].join(" ")));
  const topicHits = [...caseTerms].filter((term) => targetTerms.has(term));
  const breakdown = {
    legalArea: areaOverlap.length > 0 ? 35 : 0,
    caseTopics: Math.min(25, topicHits.length * 5),
    directRoute: target.contactUrl ? 15 : 0,
    reviewedSource: target.status === "approved" ? 10 : 0,
    region: /netherlands|nederland/i.test(target.region || "") ? 10 : 0,
    targetFit: target.targetType === "media" || target.targetType === "organization" ? 5 : 0,
  };
  const score = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  if (score < 25 || (areaOverlap.length === 0 && topicHits.length === 0)) return null;
  const reasons = [
    ...(areaOverlap.length ? [`Legal-area fit: ${areaOverlap.join(", ")}`] : []),
    ...(topicHits.length ? [`Case-topic fit: ${topicHits.slice(0, 5).join(", ")}`] : []),
    ...(target.contactUrl ? ["Direct public contact/source route available"] : []),
    "Approved directory record",
  ];
  return { score, breakdown, reasons };
}

export async function matchApprovedTargetsForCase(options: {
  userId: string;
  caseId: string;
  targetType: OutreachTargetType;
  limit?: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const caseRows = await db.select().from(cases).where(and(
    eq(cases.id, options.caseId),
    eq(cases.userId, options.userId),
  )).limit(1);
  const caseData = caseRows[0];
  if (!caseData) throw new Error("Case not found");
  const targets = await db.select().from(outreachDirectoryTargets).where(and(
    eq(outreachDirectoryTargets.userId, options.userId),
    eq(outreachDirectoryTargets.targetType, options.targetType),
    eq(outreachDirectoryTargets.status, "approved"),
  ));
  const ranked = targets.flatMap((target) => {
    const scored = scoreTarget(target, caseData);
    return scored ? [{ target, ...scored }] : [];
  }).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(100, options.limit || 30)));
  const now = new Date();
  for (const item of ranked) {
    await db.insert(caseOutreachTargetMatches).values({
      id: `MATCH-${nanoid(16)}`,
      userId: options.userId,
      caseId: options.caseId,
      targetId: item.target.id,
      targetType: options.targetType,
      matchScore: item.score,
      scoreBreakdown: JSON.stringify(item.breakdown),
      matchReasons: JSON.stringify(item.reasons),
      status: "suggested",
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [caseOutreachTargetMatches.caseId, caseOutreachTargetMatches.targetId],
      set: {
        matchScore: item.score,
        scoreBreakdown: JSON.stringify(item.breakdown),
        matchReasons: JSON.stringify(item.reasons),
        updatedAt: now,
      },
    });
  }
  return getCaseTargetMatches(options);
}

export async function getCaseTargetMatches(options: {
  userId: string;
  caseId: string;
  targetType: OutreachTargetType;
}) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({
    match: caseOutreachTargetMatches,
    target: outreachDirectoryTargets,
  }).from(caseOutreachTargetMatches)
    .innerJoin(outreachDirectoryTargets, eq(caseOutreachTargetMatches.targetId, outreachDirectoryTargets.id))
    .where(and(
      eq(caseOutreachTargetMatches.userId, options.userId),
      eq(caseOutreachTargetMatches.caseId, options.caseId),
      eq(caseOutreachTargetMatches.targetType, options.targetType),
      eq(outreachDirectoryTargets.targetType, options.targetType),
      eq(outreachDirectoryTargets.status, "approved"),
    ))
    .orderBy(desc(caseOutreachTargetMatches.matchScore));
  return rows.map(({ match, target }) => ({
    ...match,
    scoreBreakdown: JSON.parse(match.scoreBreakdown),
    matchReasons: parseStringArray(match.matchReasons),
    target: serializeTarget(target),
  }));
}

export async function updateCaseTargetMatchStatus(options: {
  userId: string;
  id: string;
  status: OutreachTargetMatchStatus;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.update(caseOutreachTargetMatches).set({
    status: options.status,
    updatedAt: new Date(),
  }).where(and(
    eq(caseOutreachTargetMatches.id, options.id),
    eq(caseOutreachTargetMatches.userId, options.userId),
  ));
  if (!result.changes) throw new Error("Case target match not found");
  return { success: true as const };
}

export async function getOutreachDirectorySummary(userId: string) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({
    targetType: outreachDirectoryTargets.targetType,
    status: outreachDirectoryTargets.status,
    count: sql<number>`count(*)`,
  }).from(outreachDirectoryTargets)
    .where(eq(outreachDirectoryTargets.userId, userId))
    .groupBy(outreachDirectoryTargets.targetType, outreachDirectoryTargets.status);
  return rows.map((row) => ({ ...row, count: Number(row.count) }));
}
