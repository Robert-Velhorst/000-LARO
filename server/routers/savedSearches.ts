import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { savedSearches } from "../schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { TRPCError } from "@trpc/server";

/** Stored in `saved_searches.queryJson` — table has no separate searchType/filters columns. */
type SavedSearchPayload = {
  searchType?: "cases" | "lawyers" | "evidence";
  query?: string;
  filters?: Record<string, unknown>;
};

function parseSavedSearchRow(search: typeof savedSearches.$inferSelect) {
  let searchType: SavedSearchPayload["searchType"] = "cases";
  let query = "";
  let filters: Record<string, unknown> = {};
  if (search.queryJson) {
    try {
      const j = JSON.parse(search.queryJson) as SavedSearchPayload;
      if (j.searchType === "lawyers" || j.searchType === "evidence") {
        searchType = j.searchType;
      }
      if (typeof j.query === "string") query = j.query;
      if (j.filters && typeof j.filters === "object") filters = j.filters as Record<string, unknown>;
    } catch {
      /* legacy plain text */
      query = search.queryJson;
    }
  }
  return {
    id: search.id,
    userId: search.userId,
    name: search.name,
    query,
    filters,
    searchType,
    createdAt: search.createdAt,
    queryJson: search.queryJson,
  };
}

export const savedSearchesRouter = router({
  // List all saved searches for current user
  list: protectedProcedure
    .input(
      z.object({
        searchType: z.enum(["cases", "lawyers", "evidence"]).optional(),
      }).optional()
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];

      const rows = await db
        .select()
        .from(savedSearches)
        .where(eq(savedSearches.userId, ctx.user.id));

      let mapped = rows.map(parseSavedSearchRow);
      if (input?.searchType) {
        mapped = mapped.filter((s) => s.searchType === input.searchType);
      }
      return mapped;
    }),

  // Get single saved search by ID
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return null;

      const [search] = await db
        .select()
        .from(savedSearches)
        .where(
          and(
            eq(savedSearches.id, input.id),
            eq(savedSearches.userId, ctx.user.id)
          )
        )
        .limit(1);

      if (!search) return null;

      return parseSavedSearchRow(search);
    }),

  // Create new saved search
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(256),
        query: z.string().max(512).optional(),
        filters: z.record(z.any()),
        searchType: z.enum(["cases", "lawyers", "evidence"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const id = nanoid();
      const queryJson = JSON.stringify({
        searchType: input.searchType,
        query: input.query ?? "",
        filters: input.filters,
      } satisfies SavedSearchPayload & { filters: Record<string, unknown> });
      await db.insert(savedSearches).values({
        id,
        userId: ctx.user.id,
        name: input.name,
        queryJson,
      } as typeof savedSearches.$inferInsert);

      return { id, success: true };
    }),

  // Update existing saved search
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(256).optional(),
        query: z.string().max(512).optional(),
        filters: z.record(z.any()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const { id, ...updates } = input;

      const [existing] = await db
        .select()
        .from(savedSearches)
        .where(
          and(eq(savedSearches.id, id), eq(savedSearches.userId, ctx.user.id))
        )
        .limit(1);

      if (!existing) {
        throw new Error("Saved search not found");
      }

      const parsed = parseSavedSearchRow(existing);
      const nextPayload: SavedSearchPayload = {
        searchType: parsed.searchType,
        query: parsed.query,
        filters: parsed.filters,
      };
      if (updates.query !== undefined) nextPayload.query = updates.query;
      if (updates.filters !== undefined) nextPayload.filters = updates.filters;

      const updateData: { name?: string; queryJson?: string } = {};
      if (updates.name !== undefined) updateData.name = updates.name;
      if (updates.query !== undefined || updates.filters !== undefined) {
        updateData.queryJson = JSON.stringify({
          searchType: nextPayload.searchType,
          query: nextPayload.query ?? "",
          filters: nextPayload.filters ?? {},
        });
      }

      await db
        .update(savedSearches)
        .set(updateData as typeof savedSearches.$inferInsert)
        .where(
          and(
            eq(savedSearches.id, id),
            eq(savedSearches.userId, ctx.user.id)
          )
        );

      return { success: true };
    }),

  // Delete saved search
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const result = await db
        .delete(savedSearches)
        .where(
          and(
            eq(savedSearches.id, input.id),
            eq(savedSearches.userId, ctx.user.id)
          )
        );

      if (!Number((result as any)?.changes ?? 0)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Saved search not found" });
      }

      return { success: true };
    }),
});

