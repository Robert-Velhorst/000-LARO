import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { users } from "../schema";
import { eq, inArray } from "drizzle-orm";
import { getTeamMembers, addTeamMember, removeTeamMember } from "../teams";

/**
 * Phase 106 — team management. The caller is the owner of their own team; they can
 * add/remove members by email. Members gain shared access to the owner's cases
 * (enforced in assertCaseOwnership).
 */
export const teamsRouter = router({
  listMembers: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    const ids = await getTeamMembers(ctx.user.id);
    if (!db || ids.length === 0) return [] as Array<{ id: string; email: string; name: string }>;
    const rows = await db.select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(inArray(users.id, ids));
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => {
      const user = byId.get(id);
      return { id, email: user?.email || "", name: user?.name || "" };
    });
  }),
  addMember: protectedProcedure.input(z.object({ email: z.string().email() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const target = (await db.select().from(users).where(eq(users.email, input.email)).limit(1))[0];
    if (!target) {
      const { TRPCError } = await import("@trpc/server");
      throw new TRPCError({ code: "NOT_FOUND", message: "No user with that email." });
    }
    const list = await addTeamMember(ctx.user.id, (target as any).id);
    return { members: list };
  }),
  removeMember: protectedProcedure.input(z.object({ userId: z.string() })).mutation(async ({ ctx, input }) => {
    const list = await removeTeamMember(ctx.user.id, input.userId);
    return { members: list };
  }),
});
