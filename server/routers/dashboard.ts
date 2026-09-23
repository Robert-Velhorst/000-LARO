import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getSearchDestination } from "../../shared/globalSearch";
import { protectedProcedure, router } from "../_core/trpc";
import { getPendingClarifications } from "../clarifications";
import { getDb } from "../db";
import { cases as casesTable, emailActivity, evidence, outreachStatus } from "../schema";

type DashboardDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Priority = "high" | "medium" | "low";
type NextAction = { caseId: string; caseTitle: string; action: string; reason: string; priority: Priority };
type DashboardException = { caseId: string; caseTitle: string; kind: string; detail: string; severity: "high" | "medium" };
type DashboardActivity = {
  id: string;
  type: "case_created" | "outreach_sent" | "outreach_response";
  title: string;
  detail: string | null;
  caseId: string;
  caseTitle: string;
  status: string | null;
  timestamp: Date;
  destination: string;
};

const SENT_OUTREACH_STATES = ["Sent", "Interested", "Declined", "NoResponse"] as const;
const RESPONSE_OUTREACH_STATES = ["Interested", "Declined"] as const;
const DASHBOARD_DEFINITIONS = {
  activeCases: "Owned cases whose current status is neither Closed nor Resolved.",
  evidenceCollected: "Evidence records owned by the signed-in account.",
  outreachSuggested: "Current persisted outreach candidates across every state; this is not a sent count.",
  outreachDrafted: "Outreach in PendingApproval.",
  outreachApproved: "Approved or Dispatching outreach that is not yet confirmed sent.",
  outreachSent: "Outreach in Sent, Interested, Declined, or NoResponse.",
  outreachResponded: "Outreach in Interested or Declined.",
  outreachInterested: "Outreach currently marked Interested.",
} as const;

function countFor(counts: Map<string, number>, ...states: string[]): number {
  return states.reduce((total, state) => total + (counts.get(state) ?? 0), 0);
}

async function loadStats(db: DashboardDb, userId: string) {
  const [activeCases, evidenceCount, outreachRows] = await Promise.all([
    db.select({ count: sql<number>`count(*)` })
      .from(casesTable)
      .where(and(eq(casesTable.userId, userId), sql`status NOT IN ('Closed', 'Resolved')`)),
    db.select({ count: sql<number>`count(*)` })
      .from(evidence)
      .where(eq(evidence.userId, userId)),
    db.select({ status: outreachStatus.status, count: sql<number>`count(*)` })
      .from(outreachStatus)
      .innerJoin(casesTable, eq(outreachStatus.caseId, casesTable.id))
      .where(eq(casesTable.userId, userId))
      .groupBy(outreachStatus.status),
  ]);
  const counts = new Map(outreachRows.map(row => [String(row.status ?? "Unknown"), Number(row.count || 0)]));
  const suggested = [...counts.values()].reduce((total, value) => total + value, 0);
  const sent = countFor(counts, ...SENT_OUTREACH_STATES);
  return {
    availability: "available" as const,
    activeCases: Number(activeCases[0]?.count || 0),
    evidenceCollected: Number(evidenceCount[0]?.count || 0),
    // Compatibility alias: unlike the old implementation, this now means a
    // confirmed send/current post-send state, never every outreach row.
    matchesMade: sent,
    pendingRequests: 0,
    outreach: {
      suggested,
      drafted: countFor(counts, "PendingApproval"),
      approved: countFor(counts, "Approved", "Dispatching"),
      sent,
      responded: countFor(counts, ...RESPONSE_OUTREACH_STATES),
      interested: countFor(counts, "Interested"),
      rejected: countFor(counts, "Rejected"),
      failed: countFor(counts, "Failed"),
    },
    definitions: DASHBOARD_DEFINITIONS,
  };
}

function eventDate(value: Date | null | undefined): Date {
  return value instanceof Date ? value : value ? new Date(value) : new Date(0);
}

async function loadActivity(db: DashboardDb, userId: string, limit: number): Promise<DashboardActivity[]> {
  const [caseRows, sentRows, responseRows] = await Promise.all([
    db.select({ id: casesTable.id, clientName: casesTable.clientName, createdAt: casesTable.createdAt })
      .from(casesTable)
      .where(eq(casesTable.userId, userId))
      .orderBy(desc(casesTable.createdAt))
      .limit(limit),
    db.select({
      id: emailActivity.id,
      caseId: casesTable.id,
      caseTitle: casesTable.clientName,
      subject: emailActivity.subject,
      sentAt: emailActivity.sentAt,
      createdAt: emailActivity.createdAt,
    })
      .from(emailActivity)
      .innerJoin(casesTable, eq(emailActivity.caseId, casesTable.id))
      .where(eq(casesTable.userId, userId))
      .orderBy(desc(emailActivity.sentAt))
      .limit(limit),
    db.select({
      id: outreachStatus.id,
      caseId: casesTable.id,
      caseTitle: casesTable.clientName,
      status: outreachStatus.status,
      updatedAt: outreachStatus.updatedAt,
    })
      .from(outreachStatus)
      .innerJoin(casesTable, eq(outreachStatus.caseId, casesTable.id))
      .where(and(
        eq(casesTable.userId, userId),
        inArray(outreachStatus.status, [...RESPONSE_OUTREACH_STATES]),
      ))
      .orderBy(desc(outreachStatus.updatedAt))
      .limit(limit),
  ]);

  const feed: DashboardActivity[] = caseRows.map(row => ({
    id: `case-${row.id}`,
    type: "case_created",
    title: `Case created for ${row.clientName || "client"}`,
    detail: null,
    caseId: row.id,
    caseTitle: row.clientName || row.id,
    status: null,
    timestamp: eventDate(row.createdAt),
    destination: getSearchDestination({ type: "case", id: row.id })!,
  }));
  for (const row of sentRows) {
    feed.push({
      id: `outreach-${row.id}`,
      type: "outreach_sent",
      title: row.subject ? `Outreach: ${row.subject}` : "Outreach recorded",
      detail: row.subject || null,
      caseId: row.caseId,
      caseTitle: row.caseTitle || row.caseId,
      status: "Sent",
      timestamp: eventDate(row.sentAt ?? row.createdAt),
      destination: getSearchDestination({ type: "case", id: row.caseId })!,
    });
  }
  for (const row of responseRows) {
    feed.push({
      id: `response-${row.id}-${row.status}`,
      type: "outreach_response",
      title: "Outreach response recorded",
      detail: null,
      caseId: row.caseId,
      caseTitle: row.caseTitle || row.caseId,
      status: row.status,
      timestamp: eventDate(row.updatedAt),
      destination: getSearchDestination({ type: "case", id: row.caseId })!,
    });
  }
  feed.sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime() || left.id.localeCompare(right.id));
  return feed.slice(0, limit);
}

async function loadNextActions(db: DashboardDb, userId: string): Promise<NextAction[]> {
  const userCases = await db.select({
    id: casesTable.id,
    clientName: casesTable.clientName,
    status: casesTable.status,
    urgency: casesTable.urgency,
    createdAt: casesTable.createdAt,
    evidenceCount: sql<number>`count(${evidence.id})`,
  })
    .from(casesTable)
    .leftJoin(evidence, and(eq(evidence.caseId, casesTable.id), eq(evidence.userId, userId)))
    .where(eq(casesTable.userId, userId))
    .groupBy(casesTable.id, casesTable.clientName, casesTable.status, casesTable.urgency, casesTable.createdAt)
    .orderBy(desc(casesTable.createdAt))
    .limit(25);

  const actions: NextAction[] = [];
  for (const row of userCases) {
    const caseTitle = row.clientName || row.id;
    const high = (row.urgency || "").toLowerCase() === "high";
    if (Number(row.evidenceCount || 0) === 0) {
      actions.push({
        caseId: row.id,
        caseTitle,
        action: "Add evidence",
        reason: "This case has no evidence yet. Add documents so it can be assessed.",
        priority: high ? "high" : "medium",
      });
    } else if (row.status === "Matching") {
      actions.push({
        caseId: row.id,
        caseTitle,
        action: "Review lawyer matches",
        reason: "The case is ready for matching. Review suggested lawyers.",
        priority: high ? "high" : "medium",
      });
    } else if (row.status === "Outreach") {
      actions.push({
        caseId: row.id,
        caseTitle,
        action: "Review outreach",
        reason: "Outreach is in progress. Check status and any responses.",
        priority: high ? "high" : "low",
      });
    }
  }
  const rank = { high: 0, medium: 1, low: 2 } as const;
  actions.sort((left, right) => rank[left.priority] - rank[right.priority]);
  return actions;
}

async function loadExceptions(db: DashboardDb, userId: string) {
  const userCases = await db.select({
    id: casesTable.id,
    clientName: casesTable.clientName,
    clientEmail: casesTable.clientEmail,
    status: casesTable.status,
    urgency: casesTable.urgency,
    legalAreas: casesTable.legalAreas,
    createdAt: casesTable.createdAt,
    evidenceCount: sql<number>`count(distinct ${evidence.id})`,
    pendingOutreachCount: sql<number>`count(distinct ${outreachStatus.id})`,
  })
    .from(casesTable)
    .leftJoin(evidence, and(eq(evidence.caseId, casesTable.id), eq(evidence.userId, userId)))
    .leftJoin(outreachStatus, and(eq(outreachStatus.caseId, casesTable.id), eq(outreachStatus.status, "PendingApproval")))
    .where(eq(casesTable.userId, userId))
    .groupBy(
      casesTable.id,
      casesTable.clientName,
      casesTable.clientEmail,
      casesTable.status,
      casesTable.urgency,
      casesTable.legalAreas,
      casesTable.createdAt,
    )
    .orderBy(desc(casesTable.createdAt))
    .limit(100);

  const exceptions: DashboardException[] = [];
  for (const row of userCases) {
    const caseTitle = row.clientName || row.id;
    const severity = (row.urgency || "").toLowerCase() === "high" ? "high" : "medium";
    if (!row.clientEmail) {
      exceptions.push({ caseId: row.id, caseTitle, kind: "missing-contact", detail: "No client email — outreach cannot be prepared.", severity });
    }
    let areas: string[] = [];
    try { areas = JSON.parse(row.legalAreas || "[]"); } catch { areas = []; }
    if (areas.length === 0) {
      exceptions.push({ caseId: row.id, caseTitle, kind: "unclassified", detail: "Case has no legal area — classification needed before matching.", severity });
    }
    if (Number(row.evidenceCount || 0) === 0) {
      exceptions.push({ caseId: row.id, caseTitle, kind: "no-evidence", detail: "No evidence uploaded — the case cannot be assessed.", severity });
    }
    if (Number(row.pendingOutreachCount || 0) > 0) {
      exceptions.push({ caseId: row.id, caseTitle, kind: "awaiting-approval", detail: `${row.pendingOutreachCount} outreach draft(s) awaiting your approval.`, severity });
    }
  }
  exceptions.sort((left, right) => left.severity === right.severity ? 0 : left.severity === "high" ? -1 : 1);
  return { count: exceptions.length, exceptions };
}

function unavailableSummary() {
  return {
    availability: "unavailable" as const,
    metrics: null,
    actionCounts: { total: 0, nextAction: 0, exception: 0, clarification: 0 },
    actions: [],
    activity: [],
    definitions: DASHBOARD_DEFINITIONS,
  };
}

export const dashboardRouter = router({
  stats: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { availability: "unavailable" as const, activeCases: 0, evidenceCollected: 0, matchesMade: 0, pendingRequests: 0, outreach: null, definitions: DASHBOARD_DEFINITIONS };
    return loadStats(db, ctx.user.id);
  }),

  summary: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return unavailableSummary();
    const userId = ctx.user.id;
    const [metrics, nextActions, exceptionResult, clarifications, activity] = await Promise.all([
      loadStats(db, userId),
      loadNextActions(db, userId),
      loadExceptions(db, userId),
      getPendingClarifications(userId),
      loadActivity(db, userId, 10),
    ]);
    const caseTitles = new Map<string, string>();
    for (const item of [...exceptionResult.exceptions, ...nextActions]) {
      caseTitles.set(item.caseId, item.caseTitle);
    }
    const actions = [
      ...exceptionResult.exceptions.map(item => ({
        id: `exception:${item.caseId}:${item.kind}`,
        type: "exception" as const,
        caseId: item.caseId,
        caseTitle: item.caseTitle,
        title: item.kind,
        detail: item.detail,
        priority: item.severity,
        destination: getSearchDestination({ type: "case", id: item.caseId })!,
      })),
      ...nextActions.map(item => ({
        id: `next:${item.caseId}:${item.action}`,
        type: "next_action" as const,
        caseId: item.caseId,
        caseTitle: item.caseTitle,
        title: item.action,
        detail: item.reason,
        priority: item.priority,
        destination: getSearchDestination({ type: "case", id: item.caseId })!,
      })),
      ...clarifications.map(item => ({
        id: `clarification:${item.id}`,
        type: "clarification" as const,
        caseId: item.caseId,
        caseTitle: caseTitles.get(item.caseId) ?? item.caseId,
        title: item.question,
        detail: item.context || "Answer this clarification before relying on derived workflow results.",
        priority: "medium" as const,
        destination: getSearchDestination({ type: "case", id: item.caseId })!,
      })),
    ];
    const rank = { high: 0, medium: 1, low: 2 } as const;
    actions.sort((left, right) => rank[left.priority] - rank[right.priority] || left.id.localeCompare(right.id));
    return {
      availability: "available" as const,
      metrics,
      actionCounts: {
        total: actions.length,
        nextAction: nextActions.length,
        exception: exceptionResult.count,
        clarification: clarifications.length,
      },
      actions,
      activity,
      definitions: DASHBOARD_DEFINITIONS,
    };
  }),

  enhancedStats: protectedProcedure.query(async ({ ctx }) => {
    const empty = {
      caseVolume: { current: 0, change: 0 },
      responseRate: { current: 0, change: 0 },
      averageMatchingScore: { current: 0, change: 0 },
      outreachEfficiency: { current: 0, change: 0 },
    };
    const db = await getDb();
    if (!db) return empty;
    const [caseVolume, totalOutreach, responded] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(casesTable).where(eq(casesTable.userId, ctx.user.id)),
      db.select({ count: sql<number>`count(*)` }).from(outreachStatus)
        .innerJoin(casesTable, eq(outreachStatus.caseId, casesTable.id)).where(eq(casesTable.userId, ctx.user.id)),
      db.select({ count: sql<number>`count(*)` }).from(outreachStatus)
        .innerJoin(casesTable, eq(outreachStatus.caseId, casesTable.id))
        .where(and(eq(casesTable.userId, ctx.user.id), inArray(outreachStatus.status, [...RESPONSE_OUTREACH_STATES]))),
    ]);
    const total = Number(totalOutreach[0]?.count || 0);
    const responseCount = Number(responded[0]?.count || 0);
    const responseRate = total > 0 ? Math.round((responseCount / total) * 100) : 0;
    return {
      caseVolume: { current: Number(caseVolume[0]?.count || 0), change: 0 },
      responseRate: { current: responseRate, change: 0 },
      averageMatchingScore: { current: 0, change: 0 },
      outreachEfficiency: { current: responseRate, change: 0 },
    };
  }),

  recentCases: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(casesTable).where(eq(casesTable.userId, ctx.user.id)).orderBy(desc(casesTable.createdAt)).limit(5);
  }),

  activityFeed: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).optional().default(10) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      return db ? loadActivity(db, ctx.user.id, input.limit) : [];
    }),

  interestedMatches: protectedProcedure.query(async ({ ctx }) => {
    const { getInterestedMatches } = await import("../db");
    return getInterestedMatches(10, ctx.user.id);
  }),

  nextActions: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    return db ? loadNextActions(db, ctx.user.id) : [];
  }),

  exceptions: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    return db ? loadExceptions(db, ctx.user.id) : { count: 0, exceptions: [] as DashboardException[] };
  }),
});
