import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { messages } from "../schema";
import { assertCaseOwnership } from "../_core/authz";
import { emitRealtimeDataChange } from "../realtime";

export const messagesRouter = router({
  list: protectedProcedure
    .input(z.object({ caseId: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const conditions = [eq(messages.userId, ctx.user.id)];
      if (input?.caseId) conditions.push(eq(messages.caseId, input.caseId));
      return db
        .select()
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.createdAt))
        .limit(100);
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const [message] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.id, input.id), eq(messages.userId, ctx.user.id)))
        .limit(1);
      return message ?? null;
    }),

  send: protectedProcedure
    .input(z.object({
      caseId: z.string().trim().min(1).max(128).optional(),
      threadId: z.string().trim().min(1).max(128).optional(),
      body: z.string().trim().min(1).max(50_000),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      if (input.caseId) await assertCaseOwnership(input.caseId, ctx.user.id);
      const id = nanoid();
      await db.insert(messages).values({
        id,
        userId: ctx.user.id,
        caseId: input.caseId ?? null,
        threadId: input.threadId ?? null,
        content: input.body,
      } as any);
      emitRealtimeDataChange(ctx.user.id, { scope: "message", caseId: input.caseId });
      return { id, success: true, deliveryStatus: "saved-locally" as const };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const result = await db
        .delete(messages)
        .where(and(eq(messages.id, input.id), eq(messages.userId, ctx.user.id)));
      if (!Number((result as any)?.changes ?? 0)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Message not found" });
      }
      emitRealtimeDataChange(ctx.user.id, { scope: "message" });
      return { success: true };
    }),
});
