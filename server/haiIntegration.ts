import crypto from "crypto";
import { and, asc, eq, gt, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createAuditLog } from "./audit";
import { getDb } from "./db";
import { cases, documentAnalyses, evidence, integrationAccessTokens } from "./schema";

export const HAI_INTEGRATION_SCOPE = "hai:read";
export const HAI_FEED_PATH = "/api/integrations/hai/feed";
export const HAI_HEALTH_PATH = "/api/integrations/hai/health";
export const HAI_FEED_DEFAULT_LIMIT = 50;
export const HAI_FEED_MAX_LIMIT = 100;
const HAI_TOKEN_MAX_ACTIVE = 10;
const HAI_TOKEN_PREFIX = "laro_hai_";
const HAI_FEED_MAX_CONTENT_CHARS = 6_000;

type FeedKind = "analysis" | "case";

type FeedCursor = {
  v: 1;
  updatedAt: number;
  key: string;
};

export type HaiFeedItem = {
  externalId: string;
  title: string;
  content: string;
  sourceUri: string;
  itemType: "laro_case" | "laro_legal_analysis";
  projectKey: string;
  metadata: string;
};

export class HaiIntegrationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HaiIntegrationError";
  }
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function compact(value: unknown, max = HAI_FEED_MAX_CONTENT_CHARS): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringList(value: string | null): string[] {
  const parsed = safeJson(value);
  if (Array.isArray(parsed)) return parsed.map((item) => compact(item, 180)).filter(Boolean).slice(0, 20);
  return compact(value, 1_000).split(",").map((item) => item.trim()).filter(Boolean).slice(0, 20);
}

function findingLines(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).map((item) => {
    if (typeof item === "string") return compact(item, 500);
    if (!item || typeof item !== "object") return "";
    const record = item as Record<string, unknown>;
    return compact(record.text ?? record.description ?? record.title, 500);
  }).filter(Boolean);
}

function timelineLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((item) => {
    if (!item || typeof item !== "object") return "";
    const record = item as Record<string, unknown>;
    const date = compact(record.date, 40);
    const actor = compact(record.actor, 160);
    const action = compact(record.title ?? record.description ?? record.text, 500);
    return [date, actor, action].filter(Boolean).join(" | ");
  }).filter(Boolean);
}

function appendSection(lines: string[], label: string, values: string[]) {
  if (values.length > 0) lines.push(`${label}:`, ...values.map((value) => `- ${value}`));
}

function encodeCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): FeedCursor {
  if (!value) return { v: 1, updatedAt: 0, key: "" };
  if (value.length > 1_024) throw new HaiIntegrationError("Cursor is too long", 400);
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<FeedCursor>;
    if (
      parsed.v !== 1 ||
      !Number.isSafeInteger(parsed.updatedAt) ||
      Number(parsed.updatedAt) < 0 ||
      typeof parsed.key !== "string" ||
      parsed.key.length > 300 ||
      (parsed.key !== "" && !/^(analysis|case):[^:]+$/.test(parsed.key))
    ) {
      throw new Error("invalid cursor payload");
    }
    return parsed as FeedCursor;
  } catch {
    throw new HaiIntegrationError("Cursor is invalid", 400);
  }
}

function cursorCondition(kind: FeedKind, updatedAt: any, id: any, cursor: FeedCursor) {
  if (cursor.updatedAt === 0) return undefined;
  const cursorDate = new Date(cursor.updatedAt);
  const [cursorKind, ...cursorIdParts] = cursor.key.split(":");
  const cursorId = cursorIdParts.join(":");
  if (kind > cursorKind) return or(gt(updatedAt, cursorDate), eq(updatedAt, cursorDate));
  if (kind === cursorKind) return or(
    gt(updatedAt, cursorDate),
    and(eq(updatedAt, cursorDate), gt(id, cursorId)),
  );
  return gt(updatedAt, cursorDate);
}

function tokenView(row: typeof integrationAccessTokens.$inferSelect) {
  const now = Date.now();
  const status = row.status === "active" && row.expiresAt.getTime() <= now ? "expired" : row.status;
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scope: row.scope,
    status,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

export function haiPublicBaseUrl(): string {
  const configured = String(
    process.env.LARO_PUBLIC_BASE_URL ||
    process.env.OAUTH_REDIRECT_BASE_URL ||
    `http://127.0.0.1:${process.env.PORT || "3000"}`
  ).trim();
  try {
    const parsed = new URL(configured);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("unsafe URL");
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return `http://127.0.0.1:${process.env.PORT || "3000"}`;
  }
}

export async function listHaiTokens(userId: string) {
  const db = await getDb();
  if (!db) throw new HaiIntegrationError("Database not available", 503);
  const rows = await db.select().from(integrationAccessTokens)
    .where(eq(integrationAccessTokens.userId, userId))
    .orderBy(asc(integrationAccessTokens.createdAt));
  return rows.map(tokenView);
}

export async function createHaiToken(userId: string, name: string, expiresInDays: number) {
  const db = await getDb();
  if (!db) throw new HaiIntegrationError("Database not available", 503);
  const normalizedName = compact(name, 80);
  if (normalizedName.length < 2) throw new HaiIntegrationError("Credential name is too short", 400);
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
    throw new HaiIntegrationError("Credential expiry must be between 1 and 365 days", 400);
  }
  const active = await db.select({ id: integrationAccessTokens.id }).from(integrationAccessTokens).where(and(
    eq(integrationAccessTokens.userId, userId),
    eq(integrationAccessTokens.status, "active"),
    gt(integrationAccessTokens.expiresAt, new Date()),
  ));
  if (active.length >= HAI_TOKEN_MAX_ACTIVE) {
    throw new HaiIntegrationError(`At most ${HAI_TOKEN_MAX_ACTIVE} active integration tokens are allowed`, 409);
  }
  const token = HAI_TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const row = {
    id: nanoid(),
    userId,
    name: normalizedName,
    tokenPrefix: token.slice(0, HAI_TOKEN_PREFIX.length + 8),
    tokenHash: hashToken(token),
    scope: HAI_INTEGRATION_SCOPE,
    status: "active",
    expiresAt: new Date(now.getTime() + expiresInDays * 86_400_000),
    createdAt: now,
  };
  await db.insert(integrationAccessTokens).values(row);
  await createAuditLog({
    userId,
    action: "integration.hai_token_created",
    entityType: "integration_token",
    entityId: row.id,
    details: { scope: row.scope, tokenPrefix: row.tokenPrefix, expiresAt: row.expiresAt.toISOString() },
  });
  return { token, credential: tokenView({ ...row, lastUsedAt: null, revokedAt: null }) };
}

export async function revokeHaiToken(userId: string, tokenId: string) {
  const db = await getDb();
  if (!db) throw new HaiIntegrationError("Database not available", 503);
  const [row] = await db.select().from(integrationAccessTokens).where(and(
    eq(integrationAccessTokens.id, tokenId),
    eq(integrationAccessTokens.userId, userId),
  )).limit(1);
  if (!row) throw new HaiIntegrationError("Integration token not found", 404);
  if (row.status !== "revoked") {
    const revokedAt = new Date();
    await db.update(integrationAccessTokens).set({ status: "revoked", revokedAt }).where(eq(integrationAccessTokens.id, row.id));
    await createAuditLog({
      userId,
      action: "integration.hai_token_revoked",
      entityType: "integration_token",
      entityId: row.id,
      details: { scope: row.scope, tokenPrefix: row.tokenPrefix },
    });
  }
  return { success: true as const };
}

const tokenWindows = new Map<string, { startedAt: number; count: number }>();

function enforceFeedRateLimit(tokenId: string, now: number) {
  const current = tokenWindows.get(tokenId);
  if (!current || now - current.startedAt >= 60_000) {
    tokenWindows.set(tokenId, { startedAt: now, count: 1 });
  } else {
    current.count += 1;
    if (current.count > 30) throw new HaiIntegrationError("Feed rate limit exceeded", 429);
  }
  if (tokenWindows.size > 1_000) {
    for (const [id, window] of tokenWindows) {
      if (now - window.startedAt >= 120_000) tokenWindows.delete(id);
    }
  }
}

export async function authenticateHaiToken(rawToken: string | undefined) {
  if (!rawToken || !rawToken.startsWith(HAI_TOKEN_PREFIX) || rawToken.length > 128) {
    throw new HaiIntegrationError("A valid LARO HAI bearer token is required", 401);
  }
  const db = await getDb();
  if (!db) throw new HaiIntegrationError("Database not available", 503);
  const [row] = await db.select().from(integrationAccessTokens)
    .where(eq(integrationAccessTokens.tokenHash, hashToken(rawToken)))
    .limit(1);
  if (!row || row.scope !== HAI_INTEGRATION_SCOPE || row.status !== "active") {
    throw new HaiIntegrationError("Integration token is invalid or revoked", 401);
  }
  const now = new Date();
  if (row.expiresAt.getTime() <= now.getTime()) {
    await db.update(integrationAccessTokens).set({ status: "expired" }).where(eq(integrationAccessTokens.id, row.id));
    throw new HaiIntegrationError("Integration token has expired", 401);
  }
  enforceFeedRateLimit(row.id, now.getTime());
  await db.update(integrationAccessTokens).set({ lastUsedAt: now }).where(eq(integrationAccessTokens.id, row.id));
  return { tokenId: row.id, userId: row.userId, tokenPrefix: row.tokenPrefix };
}

export async function buildHaiFeed(userId: string, cursorValue: string | undefined, requestedLimit: number) {
  const db = await getDb();
  if (!db) throw new HaiIntegrationError("Database not available", 503);
  const cursor = decodeCursor(cursorValue);
  const limit = Math.max(1, Math.min(HAI_FEED_MAX_LIMIT, Math.floor(requestedLimit || HAI_FEED_DEFAULT_LIMIT)));
  const caseCondition = cursorCondition("case", cases.updatedAt, cases.id, cursor);
  const analysisCondition = cursorCondition("analysis", documentAnalyses.updatedAt, documentAnalyses.id, cursor);

  const [caseRows, analysisRows] = await Promise.all([
    db.select({
      id: cases.id,
      caseType: cases.caseType,
      caseSummary: cases.caseSummary,
      urgency: cases.urgency,
      status: cases.status,
      legalAreas: cases.legalAreas,
      createdAt: cases.createdAt,
      updatedAt: cases.updatedAt,
    }).from(cases).where(and(eq(cases.userId, userId), caseCondition)).orderBy(asc(cases.updatedAt), asc(cases.id)).limit(limit + 1),
    db.select({
      id: documentAnalyses.id,
      evidenceId: documentAnalyses.evidenceId,
      caseId: documentAnalyses.caseId,
      analysisVersion: documentAnalyses.analysisVersion,
      providerStatus: documentAnalyses.providerStatus,
      documentType: documentAnalyses.documentType,
      confidence: documentAnalyses.confidence,
      summary: documentAnalyses.summary,
      result: documentAnalyses.result,
      updatedAt: documentAnalyses.updatedAt,
      evidenceTitle: evidence.title,
    }).from(documentAnalyses)
      .innerJoin(evidence, and(eq(documentAnalyses.evidenceId, evidence.id), eq(evidence.userId, userId)))
      .where(and(eq(documentAnalyses.userId, userId), eq(documentAnalyses.status, "complete"), analysisCondition))
      .orderBy(asc(documentAnalyses.updatedAt), asc(documentAnalyses.id)).limit(limit + 1),
  ]);

  const entries: Array<{ key: string; updatedAt: number; item: HaiFeedItem }> = [];
  for (const row of caseRows) {
    const updatedAt = (row.updatedAt ?? row.createdAt ?? new Date(0)).getTime();
    const areas = stringList(row.legalAreas);
    const content = [
      `Case status: ${compact(row.status || "unknown", 80)}`,
      `Urgency: ${compact(row.urgency || "not set", 80)}`,
      areas.length ? `Legal areas: ${areas.join(", ")}` : "",
      row.caseSummary ? `Summary: ${compact(row.caseSummary, 4_000)}` : "",
      "This synchronized record excludes client contact details and source-document bytes.",
    ].filter(Boolean).join("\n");
    entries.push({
      key: `case:${row.id}`,
      updatedAt,
      item: {
        externalId: `laro-case:${row.id}`,
        title: compact(row.caseType || `LARO case ${row.id}`, 220),
        content,
        sourceUri: `laro://cases/${encodeURIComponent(row.id)}`,
        itemType: "laro_case",
        projectKey: `laro:${row.id}`,
        metadata: `source=laro;read_only=true;sensitive=true;review_required=true;case_id=${row.id};updated_at=${new Date(updatedAt).toISOString()}`,
      },
    });
  }
  for (const row of analysisRows) {
    const result = safeJson(row.result) as Record<string, unknown> | null;
    const lines = [`Summary: ${compact(row.summary, 2_000)}`];
    appendSection(lines, "Claims", findingLines(result?.claims, 10));
    appendSection(lines, "Obligations and deadlines", findingLines(result?.obligations, 10));
    appendSection(lines, "Legal issues", findingLines(result?.legalIssues, 10));
    appendSection(lines, "Dated events", timelineLines(result?.timelineEvents));
    lines.push("Source quotations and document bytes remain in LARO and are not copied into this feed.");
    const updatedAt = row.updatedAt.getTime();
    entries.push({
      key: `analysis:${row.id}`,
      updatedAt,
      item: {
        externalId: `laro-analysis:${row.id}`,
        title: compact(`${row.documentType}: ${row.evidenceTitle}`, 220),
        content: lines.join("\n").slice(0, HAI_FEED_MAX_CONTENT_CHARS),
        sourceUri: `laro://cases/${encodeURIComponent(row.caseId)}/evidence/${encodeURIComponent(row.evidenceId)}`,
        itemType: "laro_legal_analysis",
        projectKey: `laro:${row.caseId}`,
        metadata: `source=laro;read_only=true;sensitive=true;review_required=true;case_id=${row.caseId};evidence_id=${row.evidenceId};analysis_version=${compact(row.analysisVersion, 80)};provider_status=${compact(row.providerStatus, 80)};confidence=${row.confidence};updated_at=${row.updatedAt.toISOString()}`,
      },
    });
  }

  entries.sort((a, b) => a.updatedAt - b.updatedAt || a.key.localeCompare(b.key));
  const page = entries.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((entry) => entry.item),
    nextCursor: last ? encodeCursor({ v: 1, updatedAt: last.updatedAt, key: last.key }) : cursorValue || "",
  };
}
