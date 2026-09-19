import crypto from "crypto";
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  HAI_ANALYSIS_FIELD_CATEGORIES,
  HAI_FIELD_CATEGORIES,
  type HaiFieldCategory,
  type HaiGrantReview,
} from "../shared/haiGrant";
import { writeAuditLogOrThrow } from "./audit";
import { getDb } from "./db";
import { cases, documentAnalyses, evidence, haiAccessGrants, integrationAccessTokens } from "./schema";

export const HAI_INTEGRATION_SCOPE = "hai:read";
export const HAI_FEED_PATH = "/api/integrations/hai/feed";
export const HAI_HEALTH_PATH = "/api/integrations/hai/health";
export const HAI_FEED_DEFAULT_LIMIT = 50;
export const HAI_FEED_MAX_LIMIT = 100;
const HAI_TOKEN_MAX_ACTIVE = 10;
const HAI_TOKEN_PREFIX = "laro_hai_";
const HAI_FEED_MAX_CONTENT_CHARS = 6_000;
const HAI_GRANT_MAX_CASES = 100;

type FeedKind = "analysis" | "case";
type GrantRow = typeof haiAccessGrants.$inferSelect;
type TokenRow = typeof integrationAccessTokens.$inferSelect;

type FeedCursor = {
  v: 2;
  grantId: string;
  grantRevision: number;
  updatedAt: number;
  key: string;
};

export type HaiGrantSnapshot = {
  id: string;
  caseIds: string[];
  fieldCategories: HaiFieldCategory[];
  includeFutureCases: boolean;
  includeFutureAnalyses: boolean;
  revision: number;
  reviewedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
};

export type HaiGrantAuthorization = {
  tokenId: string;
  userId: string;
  tokenPrefix: string;
  expiresAt: Date;
  grant: HaiGrantSnapshot;
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

function parsedStringArray(value: string): string[] | null {
  const parsed = safeJson(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return null;
  return parsed;
}

function grantSnapshot(row: GrantRow): HaiGrantSnapshot | null {
  const caseIds = parsedStringArray(row.caseIds);
  const fields = parsedStringArray(row.fieldCategories);
  if (
    !caseIds || caseIds.length < 1 || caseIds.length > HAI_GRANT_MAX_CASES || new Set(caseIds).size !== caseIds.length ||
    !fields || fields.length < 1 || new Set(fields).size !== fields.length ||
    fields.some((field) => !HAI_FIELD_CATEGORIES.includes(field as HaiFieldCategory)) ||
    !Number.isSafeInteger(row.revision) || row.revision < 1
  ) return null;
  return {
    id: row.id,
    caseIds,
    fieldCategories: fields as HaiFieldCategory[],
    includeFutureCases: row.includeFutureCases,
    includeFutureAnalyses: row.includeFutureAnalyses,
    revision: row.revision,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revokedAt: row.revokedAt,
  };
}

function normalizeGrantReview(review: HaiGrantReview): Omit<HaiGrantReview, "acknowledgeCaseScope" | "acknowledgeFieldScope" | "acknowledgeFutureRecords"> {
  if (
    review?.acknowledgeCaseScope !== true ||
    review?.acknowledgeFieldScope !== true ||
    review?.acknowledgeFutureRecords !== true
  ) {
    throw new HaiIntegrationError("The case, field, and future-record scope must be explicitly reviewed", 400);
  }
  if (typeof review.includeFutureCases !== "boolean" || typeof review.includeFutureAnalyses !== "boolean") {
    throw new HaiIntegrationError("Future-record scope must be explicit", 400);
  }
  const caseIds = [...new Set((review.caseIds || []).map((id) => compact(id, 120)).filter(Boolean))];
  if (caseIds.length < 1 || caseIds.length > HAI_GRANT_MAX_CASES || caseIds.some((id) => id.length > 100)) {
    throw new HaiIntegrationError(`Select between 1 and ${HAI_GRANT_MAX_CASES} cases`, 400);
  }
  const fieldCategories = [...new Set(review.fieldCategories || [])];
  if (
    fieldCategories.length < 1 ||
    fieldCategories.some((field) => !HAI_FIELD_CATEGORIES.includes(field as HaiFieldCategory))
  ) {
    throw new HaiIntegrationError("Select at least one supported HAI field category", 400);
  }
  return {
    caseIds,
    fieldCategories: fieldCategories as HaiFieldCategory[],
    includeFutureCases: review.includeFutureCases,
    includeFutureAnalyses: review.includeFutureAnalyses,
  };
}

function assertOwnedCases(db: any, userId: string, caseIds: string[]) {
  const owned = db.select({ id: cases.id }).from(cases).where(and(
    eq(cases.userId, userId),
    inArray(cases.id, caseIds),
  )).all() as Array<{ id: string }>;
  if (owned.length !== caseIds.length) {
    throw new HaiIntegrationError("One or more selected cases do not exist or are not owned by this account", 403);
  }
}

function grantView(row: GrantRow | undefined) {
  if (!row) return null;
  const grant = grantSnapshot(row);
  if (!grant) return null;
  return { ...grant, caseCount: grant.caseIds.length };
}

function tokenView(row: TokenRow, grantRow?: GrantRow) {
  const now = Date.now();
  const grant = grantView(grantRow);
  const status = row.status === "active" && row.expiresAt.getTime() <= now
    ? "expired"
    : row.status === "active" && (!grant || grant.revokedAt)
      ? "revoked"
      : row.status;
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
    grant,
  };
}

function auditGrantDetails(grant: Pick<HaiGrantSnapshot, "id" | "caseIds" | "fieldCategories" | "includeFutureCases" | "includeFutureAnalyses" | "revision">) {
  return {
    grantId: grant.id,
    grantRevision: grant.revision,
    caseCount: grant.caseIds.length,
    fieldCategories: grant.fieldCategories,
    includeFutureCases: grant.includeFutureCases,
    includeFutureAnalyses: grant.includeFutureAnalyses,
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

export async function listHaiEligibleCases(userId: string) {
  const db = await getDb();
  if (!db) throw new HaiIntegrationError("Database not available", 503);
  const rows = await db.select({
    id: cases.id,
    caseType: cases.caseType,
    status: cases.status,
    createdAt: cases.createdAt,
  }).from(cases)
    .where(eq(cases.userId, userId))
    .orderBy(asc(cases.createdAt), asc(cases.id))
    .limit(HAI_GRANT_MAX_CASES + 1);
  return {
    cases: rows.slice(0, HAI_GRANT_MAX_CASES),
    truncated: rows.length > HAI_GRANT_MAX_CASES,
    maximumSelectable: HAI_GRANT_MAX_CASES,
  };
}

export async function listHaiTokens(userId: string) {
  const db = await getDb();
  if (!db) throw new HaiIntegrationError("Database not available", 503);
  const [tokens, grants] = await Promise.all([
    db.select().from(integrationAccessTokens)
      .where(eq(integrationAccessTokens.userId, userId))
      .orderBy(asc(integrationAccessTokens.createdAt)),
    db.select().from(haiAccessGrants).where(eq(haiAccessGrants.userId, userId)),
  ]);
  const grantsById = new Map(grants.map((grant) => [grant.id, grant]));
  return tokens.map((token) => tokenView(token, token.grantId ? grantsById.get(token.grantId) : undefined));
}

export async function createHaiToken(
  userId: string,
  name: string,
  expiresInDays: number,
  review: HaiGrantReview,
) {
  const db = await getDb();
  if (!db) throw new HaiIntegrationError("Database not available", 503);
  const normalizedName = compact(name, 80);
  if (normalizedName.length < 2) throw new HaiIntegrationError("Credential name is too short", 400);
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
    throw new HaiIntegrationError("Credential expiry must be between 1 and 365 days", 400);
  }
  const normalizedGrant = normalizeGrantReview(review);
  const token = HAI_TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const grantRow: GrantRow = {
    id: nanoid(),
    userId,
    caseIds: JSON.stringify(normalizedGrant.caseIds),
    fieldCategories: JSON.stringify(normalizedGrant.fieldCategories),
    includeFutureCases: normalizedGrant.includeFutureCases,
    includeFutureAnalyses: normalizedGrant.includeFutureAnalyses,
    revision: 1,
    reviewedAt: now,
    createdAt: now,
    updatedAt: now,
    revokedAt: null,
  };
  const row: TokenRow = {
    id: nanoid(),
    userId,
    name: normalizedName,
    tokenPrefix: token.slice(0, HAI_TOKEN_PREFIX.length + 8),
    tokenHash: hashToken(token),
    grantId: grantRow.id,
    scope: HAI_INTEGRATION_SCOPE,
    status: "active",
    expiresAt: new Date(now.getTime() + expiresInDays * 86_400_000),
    lastUsedAt: null,
    createdAt: now,
    revokedAt: null,
  };
  db.transaction((tx) => {
    assertOwnedCases(tx, userId, normalizedGrant.caseIds);
    const active = tx.select({ id: integrationAccessTokens.id }).from(integrationAccessTokens).where(and(
      eq(integrationAccessTokens.userId, userId),
      eq(integrationAccessTokens.status, "active"),
      gt(integrationAccessTokens.expiresAt, now),
    )).all();
    if (active.length >= HAI_TOKEN_MAX_ACTIVE) {
      throw new HaiIntegrationError(`At most ${HAI_TOKEN_MAX_ACTIVE} active integration tokens are allowed`, 409);
    }
    tx.insert(haiAccessGrants).values(grantRow).run();
    tx.insert(integrationAccessTokens).values(row).run();
    const grant = grantSnapshot(grantRow)!;
    writeAuditLogOrThrow(tx, {
      userId,
      action: "integration.hai_token_created",
      entityType: "integration_token",
      entityId: row.id,
      details: {
        scope: row.scope,
        tokenPrefix: row.tokenPrefix,
        expiresAt: row.expiresAt.toISOString(),
        ...auditGrantDetails(grant),
      },
    });
  });
  return { token, credential: tokenView(row, grantRow) };
}

export async function updateHaiGrant(
  userId: string,
  tokenId: string,
  expectedRevision: number,
  review: HaiGrantReview,
) {
  const db = await getDb();
  if (!db) throw new HaiIntegrationError("Database not available", 503);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new HaiIntegrationError("Grant revision is invalid", 400);
  }
  const normalizedGrant = normalizeGrantReview(review);
  const now = new Date();
  return db.transaction((tx) => {
    const token = tx.select().from(integrationAccessTokens).where(and(
      eq(integrationAccessTokens.id, tokenId),
      eq(integrationAccessTokens.userId, userId),
    )).get() as TokenRow | undefined;
    if (!token || !token.grantId) throw new HaiIntegrationError("Integration token not found", 404);
    if (token.status !== "active" || token.expiresAt.getTime() <= now.getTime()) {
      throw new HaiIntegrationError("Only an active credential can have its grant changed", 409);
    }
    const current = tx.select().from(haiAccessGrants).where(and(
      eq(haiAccessGrants.id, token.grantId),
      eq(haiAccessGrants.userId, userId),
      isNull(haiAccessGrants.revokedAt),
    )).get() as GrantRow | undefined;
    if (!current) throw new HaiIntegrationError("The credential has no active reviewed grant", 409);
    if (current.revision !== expectedRevision) {
      throw new HaiIntegrationError("The HAI grant changed while it was being reviewed", 409);
    }
    assertOwnedCases(tx, userId, normalizedGrant.caseIds);
    const updated: GrantRow = {
      ...current,
      caseIds: JSON.stringify(normalizedGrant.caseIds),
      fieldCategories: JSON.stringify(normalizedGrant.fieldCategories),
      includeFutureCases: normalizedGrant.includeFutureCases,
      includeFutureAnalyses: normalizedGrant.includeFutureAnalyses,
      revision: current.revision + 1,
      reviewedAt: now,
      updatedAt: now,
    };
    const result = tx.update(haiAccessGrants).set({
      caseIds: updated.caseIds,
      fieldCategories: updated.fieldCategories,
      includeFutureCases: updated.includeFutureCases,
      includeFutureAnalyses: updated.includeFutureAnalyses,
      revision: updated.revision,
      reviewedAt: updated.reviewedAt,
      updatedAt: updated.updatedAt,
    }).where(and(
      eq(haiAccessGrants.id, current.id),
      eq(haiAccessGrants.userId, userId),
      eq(haiAccessGrants.revision, expectedRevision),
      isNull(haiAccessGrants.revokedAt),
    )).run();
    if (Number(result.changes || 0) !== 1) {
      throw new HaiIntegrationError("The HAI grant changed while it was being reviewed", 409);
    }
    const grant = grantSnapshot(updated)!;
    writeAuditLogOrThrow(tx, {
      userId,
      action: "integration.hai_grant_updated",
      entityType: "hai_access_grant",
      entityId: current.id,
      details: { previousRevision: current.revision, ...auditGrantDetails(grant) },
    });
    return tokenView(token, updated);
  });
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
    db.transaction((tx) => {
      const now = new Date();
      const result = tx.update(integrationAccessTokens)
        .set({ status: "revoked", revokedAt: now })
        .where(and(
          eq(integrationAccessTokens.id, row.id),
          eq(integrationAccessTokens.userId, userId),
          eq(integrationAccessTokens.status, row.status),
        )).run();
      if (Number(result.changes || 0) !== 1) {
        throw new HaiIntegrationError("Integration token changed before it could be revoked", 409);
      }
      if (row.grantId) {
        tx.update(haiAccessGrants).set({ revokedAt: now, updatedAt: now }).where(and(
          eq(haiAccessGrants.id, row.grantId),
          eq(haiAccessGrants.userId, userId),
          isNull(haiAccessGrants.revokedAt),
        )).run();
      }
      writeAuditLogOrThrow(tx, {
        userId,
        action: "integration.hai_token_revoked",
        entityType: "integration_token",
        entityId: row.id,
        details: { scope: row.scope, tokenPrefix: row.tokenPrefix, grantId: row.grantId },
      });
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

export async function authenticateHaiToken(rawToken: string | undefined): Promise<HaiGrantAuthorization> {
  if (!rawToken || !rawToken.startsWith(HAI_TOKEN_PREFIX) || rawToken.length > 128) {
    throw new HaiIntegrationError("A valid LARO HAI bearer token is required", 401);
  }
  const db = await getDb();
  if (!db) throw new HaiIntegrationError("Database not available", 503);
  const [row] = await db.select().from(integrationAccessTokens)
    .where(eq(integrationAccessTokens.tokenHash, hashToken(rawToken)))
    .limit(1);
  if (!row || row.scope !== HAI_INTEGRATION_SCOPE || row.status !== "active" || !row.grantId) {
    throw new HaiIntegrationError("Integration token is invalid or revoked", 401);
  }
  const now = new Date();
  if (row.expiresAt.getTime() <= now.getTime()) {
    await db.update(integrationAccessTokens).set({ status: "expired" }).where(and(
      eq(integrationAccessTokens.id, row.id),
      eq(integrationAccessTokens.status, "active"),
    ));
    throw new HaiIntegrationError("Integration token has expired", 401);
  }
  const [grantRow] = await db.select().from(haiAccessGrants).where(and(
    eq(haiAccessGrants.id, row.grantId),
    eq(haiAccessGrants.userId, row.userId),
    isNull(haiAccessGrants.revokedAt),
  )).limit(1);
  const grant = grantRow ? grantSnapshot(grantRow) : null;
  if (!grant) throw new HaiIntegrationError("Integration token has no valid reviewed grant", 401);
  enforceFeedRateLimit(row.id, now.getTime());
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= 60_000) {
    await db.update(integrationAccessTokens).set({ lastUsedAt: now }).where(and(
      eq(integrationAccessTokens.id, row.id),
      eq(integrationAccessTokens.status, "active"),
    ));
  }
  return {
    tokenId: row.id,
    userId: row.userId,
    tokenPrefix: row.tokenPrefix,
    expiresAt: row.expiresAt,
    grant,
  };
}

async function assertAuthorizationCurrent(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, auth: HaiGrantAuthorization) {
  const [token] = await db.select({
    status: integrationAccessTokens.status,
    expiresAt: integrationAccessTokens.expiresAt,
    grantId: integrationAccessTokens.grantId,
  }).from(integrationAccessTokens).where(and(
    eq(integrationAccessTokens.id, auth.tokenId),
    eq(integrationAccessTokens.userId, auth.userId),
  )).limit(1);
  if (
    !token || token.status !== "active" || token.expiresAt.getTime() <= Date.now() ||
    token.grantId !== auth.grant.id
  ) throw new HaiIntegrationError("Integration token is invalid, expired, or revoked", 401);
  const [grant] = await db.select({
    revision: haiAccessGrants.revision,
    revokedAt: haiAccessGrants.revokedAt,
  }).from(haiAccessGrants).where(and(
    eq(haiAccessGrants.id, auth.grant.id),
    eq(haiAccessGrants.userId, auth.userId),
  )).limit(1);
  if (!grant || grant.revokedAt) throw new HaiIntegrationError("Integration token grant is revoked", 401);
  if (grant.revision !== auth.grant.revision) {
    throw new HaiIntegrationError("HAI grant scope changed; authenticate again and restart synchronization", 409);
  }
}

function encodeCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function emptyCursor(auth: HaiGrantAuthorization): FeedCursor {
  return {
    v: 2,
    grantId: auth.grant.id,
    grantRevision: auth.grant.revision,
    updatedAt: 0,
    key: "",
  };
}

function decodeCursor(value: string | undefined, auth: HaiGrantAuthorization): FeedCursor {
  if (!value) return emptyCursor(auth);
  if (value.length > 1_024) throw new HaiIntegrationError("Cursor is too long", 400);
  let parsed: Partial<FeedCursor>;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<FeedCursor>;
  } catch {
    throw new HaiIntegrationError("Cursor is invalid", 400);
  }
  if (
    parsed.v !== 2 || typeof parsed.grantId !== "string" || !Number.isSafeInteger(parsed.grantRevision) ||
    !Number.isSafeInteger(parsed.updatedAt) || Number(parsed.updatedAt) < 0 ||
    typeof parsed.key !== "string" || parsed.key.length > 300 ||
    (parsed.key !== "" && !/^(analysis|case):.{1,220}$/.test(parsed.key))
  ) throw new HaiIntegrationError("Cursor is invalid", 400);
  if (parsed.grantId !== auth.grant.id || parsed.grantRevision !== auth.grant.revision) {
    throw new HaiIntegrationError("HAI grant scope changed; restart synchronization without a cursor", 409);
  }
  return parsed as FeedCursor;
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

function caseScopeCondition(idColumn: any, createdAtColumn: any, grant: HaiGrantSnapshot) {
  const selected = inArray(idColumn, grant.caseIds);
  return grant.includeFutureCases
    ? or(selected, gt(createdAtColumn, grant.reviewedAt))
    : selected;
}

export async function buildHaiFeed(
  auth: HaiGrantAuthorization,
  cursorValue: string | undefined,
  requestedLimit: number,
) {
  const db = await getDb();
  if (!db) throw new HaiIntegrationError("Database not available", 503);
  await assertAuthorizationCurrent(db, auth);
  const cursor = decodeCursor(cursorValue, auth);
  const limit = Math.max(1, Math.min(HAI_FEED_MAX_LIMIT, Math.floor(requestedLimit || HAI_FEED_DEFAULT_LIMIT)));
  const fields = new Set(auth.grant.fieldCategories);
  const includeCaseOverview = fields.has("case_overview");
  const includeAnalyses = HAI_ANALYSIS_FIELD_CATEGORIES.some((field) => fields.has(field));
  const caseCondition = cursorCondition("case", cases.updatedAt, cases.id, cursor);
  const analysisCondition = cursorCondition("analysis", documentAnalyses.updatedAt, documentAnalyses.id, cursor);

  const caseQuery = includeCaseOverview
    ? db.select({
      id: cases.id,
      caseType: cases.caseType,
      caseSummary: cases.caseSummary,
      urgency: cases.urgency,
      status: cases.status,
      legalAreas: cases.legalAreas,
      createdAt: cases.createdAt,
      updatedAt: cases.updatedAt,
    }).from(cases).where(and(
      eq(cases.userId, auth.userId),
      caseScopeCondition(cases.id, cases.createdAt, auth.grant),
      caseCondition,
    )).orderBy(asc(cases.updatedAt), asc(cases.id)).limit(limit + 1)
    : Promise.resolve([]);

  const analysisQuery = includeAnalyses
    ? db.select({
      id: documentAnalyses.id,
      evidenceId: documentAnalyses.evidenceId,
      caseId: documentAnalyses.caseId,
      analysisVersion: documentAnalyses.analysisVersion,
      providerStatus: documentAnalyses.providerStatus,
      documentType: documentAnalyses.documentType,
      confidence: documentAnalyses.confidence,
      summary: documentAnalyses.summary,
      claimsJson: sql<string>`CASE WHEN json_valid(${documentAnalyses.result}) THEN COALESCE(json_extract(${documentAnalyses.result}, '$.claims'), '[]') ELSE '[]' END`,
      obligationsJson: sql<string>`CASE WHEN json_valid(${documentAnalyses.result}) THEN COALESCE(json_extract(${documentAnalyses.result}, '$.obligations'), '[]') ELSE '[]' END`,
      legalIssuesJson: sql<string>`CASE WHEN json_valid(${documentAnalyses.result}) THEN COALESCE(json_extract(${documentAnalyses.result}, '$.legalIssues'), '[]') ELSE '[]' END`,
      timelineEventsJson: sql<string>`CASE WHEN json_valid(${documentAnalyses.result}) THEN COALESCE(json_extract(${documentAnalyses.result}, '$.timelineEvents'), '[]') ELSE '[]' END`,
      createdAt: documentAnalyses.createdAt,
      updatedAt: documentAnalyses.updatedAt,
      evidenceTitle: evidence.title,
    }).from(documentAnalyses)
      .innerJoin(evidence, and(eq(documentAnalyses.evidenceId, evidence.id), eq(evidence.userId, auth.userId)))
      .innerJoin(cases, and(eq(documentAnalyses.caseId, cases.id), eq(cases.userId, auth.userId)))
      .where(and(
        eq(documentAnalyses.userId, auth.userId),
        eq(documentAnalyses.status, "complete"),
        caseScopeCondition(cases.id, cases.createdAt, auth.grant),
        auth.grant.includeFutureAnalyses ? undefined : lte(documentAnalyses.createdAt, auth.grant.reviewedAt),
        analysisCondition,
      ))
      .orderBy(asc(documentAnalyses.updatedAt), asc(documentAnalyses.id)).limit(limit + 1)
    : Promise.resolve([]);

  const [caseRows, analysisRows] = await Promise.all([caseQuery, analysisQuery]);
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
        metadata: `source=laro;read_only=true;sensitive=true;review_required=true;grant_id=${auth.grant.id};grant_revision=${auth.grant.revision};case_id=${row.id};updated_at=${new Date(updatedAt).toISOString()}`,
      },
    });
  }
  for (const row of analysisRows) {
    const lines: string[] = [];
    if (fields.has("analysis_summary")) lines.push(`Summary: ${compact(row.summary, 2_000)}`);
    if (fields.has("analysis_claims")) appendSection(lines, "Claims", findingLines(safeJson(row.claimsJson), 10));
    if (fields.has("analysis_obligations")) appendSection(lines, "Obligations and deadlines", findingLines(safeJson(row.obligationsJson), 10));
    if (fields.has("analysis_legal_issues")) appendSection(lines, "Legal issues", findingLines(safeJson(row.legalIssuesJson), 10));
    if (fields.has("analysis_timeline")) appendSection(lines, "Dated events", timelineLines(safeJson(row.timelineEventsJson)));
    lines.push("Source quotations and document bytes remain in LARO and are not copied into this feed.");
    const updatedAt = row.updatedAt.getTime();
    const summaryMetadata = fields.has("analysis_summary")
      ? `;analysis_version=${compact(row.analysisVersion, 80)};provider_status=${compact(row.providerStatus, 80)};confidence=${row.confidence}`
      : "";
    entries.push({
      key: `analysis:${row.id}`,
      updatedAt,
      item: {
        externalId: `laro-analysis:${row.id}`,
        title: fields.has("analysis_summary") ? compact(`${row.documentType}: ${row.evidenceTitle}`, 220) : "LARO legal analysis",
        content: lines.join("\n").slice(0, HAI_FEED_MAX_CONTENT_CHARS),
        sourceUri: `laro://cases/${encodeURIComponent(row.caseId)}/evidence/${encodeURIComponent(row.evidenceId)}`,
        itemType: "laro_legal_analysis",
        projectKey: `laro:${row.caseId}`,
        metadata: `source=laro;read_only=true;sensitive=true;review_required=true;grant_id=${auth.grant.id};grant_revision=${auth.grant.revision};case_id=${row.caseId};evidence_id=${row.evidenceId}${summaryMetadata};updated_at=${row.updatedAt.toISOString()}`,
      },
    });
  }

  entries.sort((a, b) => a.updatedAt - b.updatedAt || a.key.localeCompare(b.key));
  const page = entries.slice(0, limit);
  const last = page.at(-1);
  await assertAuthorizationCurrent(db, auth);
  return {
    items: page.map((entry) => entry.item),
    nextCursor: last ? encodeCursor({
      v: 2,
      grantId: auth.grant.id,
      grantRevision: auth.grant.revision,
      updatedAt: last.updatedAt,
      key: last.key,
    }) : cursorValue || "",
  };
}
