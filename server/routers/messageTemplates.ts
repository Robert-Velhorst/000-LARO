import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { messageTemplates } from "../schema";
import { and, desc, eq, isNull, or } from "drizzle-orm";

/**
 * Message templates router.
 *
 * Phase 024 — templates, presets, reusable user defaults. `list` returns the
 * user's own templates plus any global (userId IS NULL) ones. Previously this
 * router was read-only; it now supports real per-user CRUD (create/update/
 * delete), all owner-scoped so a user can only mutate their own templates.
 */
export const messageTemplatesRouter = router({
  list: publicProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];

    const userId = ctx.user?.id;
    const where = userId
      ? or(eq(messageTemplates.userId, userId), isNull(messageTemplates.userId))
      : isNull(messageTemplates.userId);

    return db
      .select()
      .from(messageTemplates)
      .where(and(where))
      .orderBy(desc(messageTemplates.createdAt));
  }),

  create: protectedProcedure
    .input(z.object({ name: z.string().min(1).max(120), body: z.string().min(1).max(20000) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const id = nanoid();
      await db.insert(messageTemplates).values({
        id,
        userId: ctx.user.id,
        name: input.name,
        body: input.body,
        createdAt: new Date(),
      } as any);
      return { id, success: true };
    }),

  update: protectedProcedure
    .input(z.object({ id: z.string(), name: z.string().min(1).max(120).optional(), body: z.string().min(1).max(20000).optional() })
      .refine((value) => value.name !== undefined || value.body !== undefined, "Provide a name or body to update"))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const set: any = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.body !== undefined) set.body = input.body;
      // Owner-scoped: only the user's own (non-global) template can be updated.
      const result = await db
        .update(messageTemplates)
        .set(set)
        .where(and(eq(messageTemplates.id, input.id), eq(messageTemplates.userId, ctx.user.id)));
      if (!Number((result as any)?.changes ?? 0)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Message template not found" });
      }
      return { success: true };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const result = await db
        .delete(messageTemplates)
        .where(and(eq(messageTemplates.id, input.id), eq(messageTemplates.userId, ctx.user.id)));
      if (!Number((result as any)?.changes ?? 0)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Message template not found" });
      }
      return { success: true };
    }),
});
