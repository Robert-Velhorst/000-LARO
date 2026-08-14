import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { notifications } from "../schema";
import { and, desc, eq, sql } from "drizzle-orm";

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
      // Shape rows for the renderer — it expects both `read` and `isRead`
      // (legacy alias) plus an optional `actionUrl` for click-through.
      return rows.map((n) => ({
        id: n.id,
        userId: n.userId,
        type: "system_announcement" as const,
        title: n.title || "Notification",
        message: n.body || "",
        read: !!n.read,
        isRead: !!n.read,
        actionUrl: null as string | null,
        createdAt: n.createdAt || new Date(),
      }));
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
