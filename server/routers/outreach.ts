import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { assertCaseAccess } from "../_core/authz";
import { outreachStatus, lawyers } from '../schema';
import { eq } from "drizzle-orm";

export const outreachRouter = router({
  byCaseId: protectedProcedure
    .input(z.string())
    .query(async ({ input: caseId, ctx }) => {
      await assertCaseAccess(caseId, ctx.user.id); // owner or accepted case share
      const db = await getDb();
      if (!db) return [];
      const results = await db
        .select({
          id: outreachStatus.id,
          lawyerName: lawyers.name,
          lawyerEmail: lawyers.email,
          status: outreachStatus.status,
          distanceKm: outreachStatus.distanceKm,
          initialContact: outreachStatus.initialContact,
          followUpsSent: outreachStatus.followUpsSent,
          response: outreachStatus.response,
          responseTimeHours: outreachStatus.responseTimeHours,
          lastContact: outreachStatus.lastContact,
        })
        .from(outreachStatus)
        .leftJoin(lawyers, eq(outreachStatus.lawyerId, lawyers.id))
        .where(eq(outreachStatus.caseId, caseId));
        
      return results;
    }),
});
