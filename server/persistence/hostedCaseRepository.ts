import type { QueryResultRow } from 'pg';

export type HostedQueryClient = {
  query<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
};

export type HostedCase = {
  id: string;
  userId: string;
  clientName: string | null;
  clientEmail: string | null;
  clientPhone: string | null;
  clientAddress: string | null;
  caseType: string | null;
  caseSummary: string | null;
  urgency: string | null;
  status: string | null;
  legalAreas: string | null;
  preferredLanguages: string | null;
  latitude: string | null;
  longitude: string | null;
  metadata: string | null;
  createdAt: number;
  updatedAt: number;
};

export type CreateHostedCase = Pick<HostedCase, 'id' | 'userId' | 'clientName' | 'caseType' | 'caseSummary' | 'urgency' | 'legalAreas'> &
  Partial<Omit<HostedCase, 'id' | 'userId' | 'clientName' | 'caseType' | 'caseSummary' | 'urgency' | 'legalAreas' | 'createdAt' | 'updatedAt'>>;

/**
 * PostgreSQL access for the core public case domain. It is intentionally
 * separate from the existing SQLite/Drizzle implementation while routes are
 * migrated domain-by-domain; every read and write carries the account owner.
 */
export function createHostedCaseRepository(client: HostedQueryClient) {
  return {
    async findOwnedCase(userId: string, caseId: string): Promise<HostedCase | null> {
      const result = await client.query<HostedCase>(`
        SELECT * FROM "cases"
        WHERE "id" = $1 AND "userId" = $2
        LIMIT 1
      `, [caseId, userId]);
      return result.rows[0] ?? null;
    },

    async createCase(input: CreateHostedCase): Promise<HostedCase> {
      const now = Date.now();
      const result = await client.query<HostedCase>(`
        INSERT INTO "cases" (
          "id", "userId", "clientName", "clientEmail", "clientPhone", "clientAddress",
          "caseType", "caseSummary", "urgency", "status", "legalAreas", "preferredLanguages",
          "latitude", "longitude", "metadata", "createdAt", "updatedAt"
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
        )
        RETURNING *
      `, [
        input.id, input.userId, input.clientName ?? null, input.clientEmail ?? null, input.clientPhone ?? null,
        input.clientAddress ?? null, input.caseType ?? null, input.caseSummary ?? null, input.urgency ?? null,
        input.status ?? 'active', input.legalAreas ?? null, input.preferredLanguages ?? null,
        input.latitude ?? null, input.longitude ?? null, input.metadata ?? null, now, now,
      ]);
      const created = result.rows[0];
      if (!created) throw new Error('Hosted case insert did not return a record.');
      return created;
    },
  };
}
