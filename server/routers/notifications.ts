import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { cases, evidence, lawyers, notifications, outreachStatus } from "../schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  buildNotificationDestination,
  isNotificationKind,
  isRegisteredNotificationDestination,
  type NotificationKind,
} from "../../shared/notifications";

function parseMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function requiredContextExists(kind: NotificationKind, row: {
  caseId: string | null;
  lawyerId: string | null;
  evidenceFileId: string | null;
}): boolean {
  switch (kind) {
    case "lawyer_response":
    case "new_match":
      return Boolean(row.caseId && row.lawyerId);
    case "case_status_change":
    case "deadline_reminder":
      return Boolean(row.caseId);
    case "evidence_uploaded":
      return Boolean(row.caseId && row.evidenceFileId);
    case "system_announcement":
      return !row.caseId && !row.lawyerId && !row.evidenceFileId;
  }
}

/**
 * Notifications router — minimal implementation backed by the
 * `notifications` table. Surfaces the bell-icon list, unread count, and
 * mark-as-read actions used by `NotificationCenter.tsx`. Notifications
 * themselves are written by the rest of the server (auto-collection,
 * reminders, outreach updates, etc.) as persisted in-app records.
 */
export const notificationsRouter = router({
  // Phase 027 — run the reminder sweep for the caller: creates notifications for
  // items needing timely attention (approval-pending, urgent-no-evidence),
  // idempotent per case/kind/day so repeated runs don't duplicate.
  runReminders: protectedProcedure.mutation(async ({ ctx }) => {
    const { runRemindersForUser } = await import("../reminders");
    return runRemindersForUser(ctx.user.id);
  }),

  list: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(200).optional().default(50) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, ctx.user.id))
        .orderBy(desc(notifications.createdAt))
        .limit(input.limit);

      const caseIds = [...new Set(rows.flatMap((row) => row.caseId ? [row.caseId] : []))];
      const evidenceIds = [...new Set(rows.flatMap((row) => row.evidenceFileId ? [row.evidenceFileId] : []))];
      const lawyerIds = [...new Set(rows.flatMap((row) => row.lawyerId ? [row.lawyerId] : []))];
      const [ownedCaseRows, ownedEvidenceRows, lawyerRows, caseLawyerRows] = await Promise.all([
        caseIds.length
          ? db.select({ id: cases.id }).from(cases).where(and(eq(cases.userId, ctx.user.id), inArray(cases.id, caseIds)))
          : Promise.resolve([]),
        evidenceIds.length
          ? db.select({ id: evidence.id, caseId: evidence.caseId }).from(evidence).where(and(eq(evidence.userId, ctx.user.id), inArray(evidence.id, evidenceIds)))
          : Promise.resolve([]),
        lawyerIds.length
          ? db.select({ id: lawyers.id }).from(lawyers).where(inArray(lawyers.id, lawyerIds))
          : Promise.resolve([]),
        caseIds.length && lawyerIds.length
          ? db.select({ caseId: outreachStatus.caseId, lawyerId: outreachStatus.lawyerId }).from(outreachStatus).where(and(
            inArray(outreachStatus.caseId, caseIds),
            inArray(outreachStatus.lawyerId, lawyerIds),
          ))
          : Promise.resolve([]),
      ]);
      const ownedCaseIds = new Set(ownedCaseRows.map((row) => row.id));
      const ownedEvidence = new Map(ownedEvidenceRows.map((row) => [row.id, row.caseId]));
      const existingLawyerIds = new Set(lawyerRows.map((row) => row.id));
      const caseLawyerPairs = new Set(caseLawyerRows.map((row) => `${row.caseId}\u0000${row.lawyerId}`));

      return rows.map((n) => {
        const kind: NotificationKind = isNotificationKind(n.kind) ? n.kind : "system_announcement";
        const referencesAreOwned = requiredContextExists(kind, n)
          && (!n.caseId || ownedCaseIds.has(n.caseId))
          && (!n.evidenceFileId || ownedEvidence.get(n.evidenceFileId) === n.caseId)
          && (!n.lawyerId || (
            existingLawyerIds.has(n.lawyerId)
            && Boolean(n.caseId)
            && caseLawyerPairs.has(`${n.caseId}\u0000${n.lawyerId}`)
          ));
        const context = referencesAreOwned
          ? { caseId: n.caseId, lawyerId: n.lawyerId, evidenceFileId: n.evidenceFileId }
          : { caseId: null, lawyerId: null, evidenceFileId: null };
        const expectedDestination = referencesAreOwned ? buildNotificationDestination(kind, context) : null;
        const destinationAvailable = expectedDestination !== null
          && isRegisteredNotificationDestination(n.actionUrl, kind, context);
        const destinationStatus = kind === "system_announcement" && referencesAreOwned
          ? "not_applicable" as const
          : destinationAvailable
            ? "available" as const
            : "unavailable" as const;

        return {
          id: n.id,
          userId: n.userId,
          type: kind,
          title: n.title || "Notification",
          message: n.body || "",
          read: !!n.read,
          isRead: !!n.read,
          actionUrl: destinationAvailable ? expectedDestination : null,
          destinationStatus,
          metadata: referencesAreOwned ? parseMetadata(n.metadata) : null,
          caseId: context.caseId,
          lawyerId: context.lawyerId,
          evidenceFileId: context.evidenceFileId,
          createdAt: n.createdAt || new Date(),
        };
      });
    }),

  unreadCount: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return 0;
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(and(eq(notifications.userId, ctx.user.id), eq(notifications.read, false)));
    return Number(result[0]?.count || 0);
  }),

  markAsRead: protectedProcedure
    .input(z.object({ notificationId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const result = await db
        .update(notifications)
        .set({ read: true })
        .where(
          and(
            eq(notifications.id, input.notificationId),
            eq(notifications.userId, ctx.user.id),
          ),
        );
      return { success: Number((result as any)?.changes ?? 0) > 0 };
    }),

  markAllAsRead: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const result = await db
      .update(notifications)
      .set({ read: true })
      .where(eq(notifications.userId, ctx.user.id));
    return { success: true, updated: Number((result as any)?.changes ?? 0) };
  }),
});
