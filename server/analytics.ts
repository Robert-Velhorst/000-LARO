/**
 * Phase 055 — product analytics, local-first.
 *
 * All metrics are computed from the LOCAL database and scoped to the requesting
 * user. There is NO third-party analytics/telemetry — nothing leaves the device.
 * This replaces the analytics.* endpoints that previously returned {} / [].
 */
import { getDb } from "./db";
import { cases as casesTable, outreachStatus, evidence, lawyers } from "./schema";
import { and, eq, inArray, sql } from "drizzle-orm";

const SENT_OUTREACH_STATES = new Set(["Sent", "Interested", "Declined", "NoResponse"]);

function hasResponse(row: typeof outreachStatus.$inferSelect): boolean {
  return ["Interested", "Declined"].includes(String(row.status)) ||
    String(row.responseReceived).toLowerCase() === "yes";
}

async function getOwnedOutreach(userId: string) {
  const db = await getDb();
  if (!db) return [] as Array<typeof outreachStatus.$inferSelect>;
  const caseIds = (await db
    .select({ id: casesTable.id })
    .from(casesTable)
    .where(eq(casesTable.userId, userId)))
    .map((row) => row.id);
  if (!caseIds.length) return [] as Array<typeof outreachStatus.$inferSelect>;
  return db.select().from(outreachStatus).where(inArray(outreachStatus.caseId, caseIds));
}

export async function overallStats(userId: string) {
  const db = await getDb();
  const empty = { totalCases: 0, activeCases: 0, closedCases: 0, totalEvidence: 0, totalOutreach: 0, responseRate: 0 };
  if (!db) return empty;

  const count = async (q: any) => Number((await q)[0]?.count || 0);

  const totalCases = await count(db.select({ count: sql<number>`count(*)` }).from(casesTable).where(eq(casesTable.userId, userId)));
  const activeCases = await count(db.select({ count: sql<number>`count(*)` }).from(casesTable).where(and(eq(casesTable.userId, userId), sql`status NOT IN ('Closed')`)));
  const closedCases = totalCases - activeCases;
  const totalEvidence = await count(db.select({ count: sql<number>`count(*)` }).from(evidence).where(eq(evidence.userId, userId)));

  const totalOutreach = await count(
    db.select({ count: sql<number>`count(*)` }).from(outreachStatus).innerJoin(casesTable, eq(outreachStatus.caseId, casesTable.id)).where(eq(casesTable.userId, userId))
  );
  const responded = await count(
    db.select({ count: sql<number>`count(*)` }).from(outreachStatus).innerJoin(casesTable, eq(outreachStatus.caseId, casesTable.id)).where(and(eq(casesTable.userId, userId), sql`outreach_status.status IN ('Interested','Declined')`))
  );
  const responseRate = totalOutreach > 0 ? Math.round((responded / totalOutreach) * 100) : 0;

  return { totalCases, activeCases, closedCases, totalEvidence, totalOutreach, responseRate };
}

export async function legalAreaDistribution(userId: string): Promise<Array<{ area: string; count: number }>> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({ legalAreas: casesTable.legalAreas }).from(casesTable).where(eq(casesTable.userId, userId));
  const tally = new Map<string, number>();
  for (const r of rows) {
    let areas: string[] = [];
    try { areas = JSON.parse(r.legalAreas || "[]"); } catch { areas = []; }
    for (const a of areas) tally.set(a, (tally.get(a) || 0) + 1);
  }
  return [...tally.entries()].map(([area, count]) => ({ area, count })).sort((a, b) => b.count - a.count);
}

export async function caseStatusDistribution(userId: string): Promise<Array<{ status: string; count: number }>> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ status: casesTable.status, count: sql<number>`count(*)` })
    .from(casesTable)
    .where(eq(casesTable.userId, userId))
    .groupBy(casesTable.status);
  return rows.map((r) => ({ status: r.status || "Unknown", count: Number(r.count) }));
}

export async function outreachTrends(userId: string): Promise<Array<{ date: string; count: number }>> {
  const grouped = new Map<string, number>();
  for (const row of await getOwnedOutreach(userId)) {
    const timestamp = row.initialContact ?? row.createdAt;
    if (!timestamp) continue;
    const date = timestamp.toISOString().slice(0, 10);
    grouped.set(date, (grouped.get(date) ?? 0) + 1);
  }
  return [...grouped.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function lawyerPerformance(userId: string) {
  const db = await getDb();
  if (!db) return [];
  const outreach = await getOwnedOutreach(userId);
  const lawyerIds = [...new Set(outreach.map((row) => row.lawyerId).filter((id): id is string => Boolean(id)))];
  if (!lawyerIds.length) return [];
  const lawyerRows = await db.select({ id: lawyers.id, name: lawyers.name }).from(lawyers).where(inArray(lawyers.id, lawyerIds));
  const names = new Map(lawyerRows.map((row) => [row.id, row.name || "Unknown lawyer"]));

  return lawyerIds.map((lawyerId) => {
    const sent = outreach.filter((row) => row.lawyerId === lawyerId && SENT_OUTREACH_STATES.has(String(row.status)));
    const responses = sent.filter(hasResponse);
    const accepted = responses.filter((row) => row.status === "Interested").length;
    const responseTimes = responses.map((row) => Number(row.responseTimeHours)).filter(Number.isFinite);
    return {
      lawyerId,
      name: names.get(lawyerId) || "Unknown lawyer",
      sent: sent.length,
      responses: responses.length,
      accepted,
      responseRate: sent.length ? (responses.length / sent.length) * 100 : 0,
      acceptanceRate: responses.length ? (accepted / responses.length) * 100 : 0,
      averageResponseTimeHours: responseTimes.length
        ? responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length
        : null,
    };
  }).sort((a, b) => b.responses - a.responses || b.responseRate - a.responseRate);
}

export async function lawyerCapacity(userId: string) {
  const db = await getDb();
  if (!db) return [];
  const outreach = await getOwnedOutreach(userId);
  const lawyerIds = [...new Set(outreach.map((row) => row.lawyerId).filter((id): id is string => Boolean(id)))];
  if (!lawyerIds.length) return [];
  const rows = await db.select({
    lawyerId: lawyers.id,
    name: lawyers.name,
    caseLoad: lawyers.caseLoad,
    capacityPercentage: lawyers.capacityPercentage,
    currentlyAccepting: lawyers.currentlyAccepting,
    updatedAt: lawyers.updatedAt,
  }).from(lawyers).where(inArray(lawyers.id, lawyerIds));

  return rows.map((row) => ({
    lawyerId: row.lawyerId,
    name: row.name || "Unknown lawyer",
    caseLoad: Number.isFinite(Number(row.caseLoad)) ? Number(row.caseLoad) : null,
    capacityPercentage: Number.isFinite(Number(row.capacityPercentage)) ? Number(row.capacityPercentage) : null,
    currentlyAccepting: row.currentlyAccepting || "Unknown",
    updatedAt: row.updatedAt?.toISOString() ?? null,
  }));
}

export async function workloadMetrics(userId: string) {
  const db = await getDb();
  if (!db) return [];
  const caseRows = await db.select({
    id: casesTable.id,
    clientName: casesTable.clientName,
    status: casesTable.status,
    urgency: casesTable.urgency,
    updatedAt: casesTable.updatedAt,
  }).from(casesTable).where(eq(casesTable.userId, userId));
  const outreach = await getOwnedOutreach(userId);
  const evidenceCounts = await db
    .select({ caseId: evidence.caseId, count: sql<number>`count(*)` })
    .from(evidence)
    .where(eq(evidence.userId, userId))
    .groupBy(evidence.caseId);
  const evidenceByCase = new Map(evidenceCounts.map((row) => [row.caseId, Number(row.count)]));

  return caseRows.map((row) => ({
    caseId: row.id,
    clientName: row.clientName || "Unnamed case",
    status: row.status || "Unknown",
    urgency: row.urgency || "Unknown",
    evidenceCount: evidenceByCase.get(row.id) ?? 0,
    outreachCount: outreach.filter((item) => item.caseId === row.id).length,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  })).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
