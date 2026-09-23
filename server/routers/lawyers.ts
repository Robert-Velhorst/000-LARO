import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { lawyers as lawyersTable } from '../schema';
import { and, asc, eq, or, sql } from "drizzle-orm";
import { createLawyerId, isGeneratedIdCollision } from "../ids";
import { assertCaseAccess } from "../_core/authz";
import { getLawyerComparison } from "../lawyerComparison";
import { literalSearchCondition } from "../literalSearch";

const experienceFilter = z.enum(["0-5", "6-10", "11-20", "20+"]);
const acceptingFilter = z.enum(["Yes", "Limited", "No", "Unknown"]);

function experienceCondition(filter: z.infer<typeof experienceFilter>) {
  if (filter === "0-5") return sql`${lawyersTable.experienceYears} BETWEEN 0 AND 5`;
  if (filter === "6-10") return sql`${lawyersTable.experienceYears} BETWEEN 6 AND 10`;
  if (filter === "11-20") return sql`${lawyersTable.experienceYears} BETWEEN 11 AND 20`;
  return sql`${lawyersTable.experienceYears} > 20`;
}

const officialProfileCondition = sql`TRIM(COALESCE(${lawyersTable.officialProfileUrl}, '')) <> ''`;

export const lawyersRouter = router({
  list: protectedProcedure
    .input(z.object({
      page: z.number().int().min(1).optional().default(1),
      limit: z.number().int().min(1).max(100).optional().default(24),
      query: z.string().trim().max(200).optional(),
      legalArea: z.string().trim().max(120).optional(),
      experience: experienceFilter.optional(),
      accepting: acceptingFilter.optional(),
      officialOnly: z.boolean().optional().default(false),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      const page = input?.page || 1;
      const limit = input?.limit || 24;
      if (!db) {
        return {
          lawyers: [],
          pagination: { total: 0, totalPages: 0, page, limit },
          officialRecordCount: 0,
        };
      }

      const conditions: any[] = [];
      if (input?.query) {
        conditions.push(or(
          literalSearchCondition(lawyersTable.name, input.query),
          literalSearchCondition(lawyersTable.firm, input.query),
          literalSearchCondition(lawyersTable.firmName, input.query),
          literalSearchCondition(lawyersTable.email, input.query),
          literalSearchCondition(lawyersTable.phone, input.query),
          literalSearchCondition(lawyersTable.website, input.query),
          literalSearchCondition(lawyersTable.address, input.query),
          literalSearchCondition(lawyersTable.city, input.query),
          literalSearchCondition(lawyersTable.legalAreas, input.query),
        ));
      }
      if (input?.legalArea) {
        conditions.push(sql`(
          (JSON_VALID(${lawyersTable.legalAreas}) AND EXISTS (
            SELECT 1
            FROM JSON_EACH(${lawyersTable.legalAreas}) AS area
            WHERE ${literalSearchCondition(sql`CAST(area.value AS TEXT)`, input.legalArea)}
          ))
          OR (NOT JSON_VALID(${lawyersTable.legalAreas})
            AND ${literalSearchCondition(lawyersTable.legalAreas, input.legalArea)})
        )`);
      }
      if (input?.experience) conditions.push(experienceCondition(input.experience));
      if (input?.accepting) conditions.push(eq(lawyersTable.currentlyAccepting, input.accepting));
      if (input?.officialOnly) conditions.push(officialProfileCondition);

      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const offset = (page - 1) * limit;
      const results = await db
        .select()
        .from(lawyersTable)
        .where(where)
        .orderBy(
          sql`CASE WHEN ${officialProfileCondition} THEN 0 ELSE 1 END`,
          asc(lawyersTable.name),
          asc(lawyersTable.id),
        )
        .limit(limit)
        .offset(offset);

      const totalRows = await db
        .select({ count: sql<number>`count(*)` })
        .from(lawyersTable)
        .where(where);
      const officialRows = await db
        .select({ count: sql<number>`count(*)` })
        .from(lawyersTable)
        .where(where ? and(where, officialProfileCondition) : officialProfileCondition);
      const total = Number(totalRows[0]?.count || 0);

      return {
        lawyers: results,
        pagination: {
          total,
          totalPages: Math.ceil(total / limit),
          page,
          limit,
        },
        officialRecordCount: Number(officialRows[0]?.count || 0),
      };
    }),

  byId: protectedProcedure
    .input(z.string())
    .query(async ({ input: id }) => {
      const db = await getDb();
      if (!db) return null;
      const { eq } = await import("drizzle-orm");
      const result = await db.select().from(lawyersTable).where(eq(lawyersTable.id, id)).limit(1);
      return result.length > 0 ? result[0] : null;
    }),

  compare: protectedProcedure
    .input(z.object({
      lawyerIds: z.array(z.string().trim().min(1).max(256)).min(2).max(3)
        .refine((ids) => new Set(ids).size === ids.length, "Choose different lawyers to compare"),
      caseId: z.string().trim().min(1).max(256).optional(),
    }))
    .query(async ({ input, ctx }) => {
      if (input.caseId) await assertCaseAccess(input.caseId, ctx.user.id);
      return getLawyerComparison(input);
    }),

  create: adminProcedure
    .input(z.object({
      name: z.string(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      firm: z.string().optional(),
      city: z.string().optional(),
      legalAreas: z.array(z.string()).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      let id = "";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const candidate = createLawyerId();
        try {
          await db.insert(lawyersTable).values({
            id: candidate,
            name: input.name,
            email: input.email || null,
            phone: input.phone || null,
            firm: input.firm || null,
            city: input.city || null,
            legalAreas: JSON.stringify(input.legalAreas || []),
            createdAt: new Date(),
            updatedAt: new Date(),
          } as any);
          id = candidate;
          break;
        } catch (error) {
          if (!isGeneratedIdCollision(error, "lawyers") || attempt === 2) throw error;
        }
      }
      if (!id) throw new Error("Lawyer record could not be created");
      return { id, success: true };
    }),

});
