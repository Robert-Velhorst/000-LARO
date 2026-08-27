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

export type HostedEvidence = {
  id: string;
  caseId: string;
  userId: string;
  type: string;
  title: string;
  source: string | null;
  description: string | null;
  fileUrl: string | null;
  fileName: string | null;
  fileSize: string | null;
  mimeType: string | null;
  metadata: string | null;
  tags: string | null;
  relevant: number;
  createdAt: number;
  updatedAt: number;
};

export type HostedUser = {
  id: string;
  name: string | null;
  email: string | null;
  password: string | null;
  loginMethod: string | null;
  role: string;
  createdAt: number;
  lastSignedIn: number;
};

export type HostedDocumentAnalysis = {
  id: string;
  evidenceId: string;
  caseId: string;
  userId: string;
  analysisVersion: string;
  contentHash: string;
  status: string;
  extractionMethod: string;
  providerStatus: string;
  documentType: string;
  confidence: number;
  summary: string;
  result: string;
  analyzedChars: number;
  createdAt: number;
  updatedAt: number;
};

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

/** Account lookup for hosted authentication; email comparison is exact but case-insensitive. */
export function createHostedUserRepository(client: HostedQueryClient) {
  return {
    async findByEmail(email: string): Promise<HostedUser | null> {
      const result = await client.query<HostedUser>(`
        SELECT * FROM "users"
        WHERE lower("email") = lower($1)
        LIMIT 1
      `, [email]);
      return result.rows[0] ?? null;
    },
  };
}

/** Preserves the existing owner-keyed team membership model in PostgreSQL. */
export function createHostedTeamRepository(client: HostedQueryClient) {
  return {
    async hasCaseAccess(ownerId: string, userId: string): Promise<boolean> {
      if (ownerId === userId) return true;
      const result = await client.query<{ configValue: string | null }>(`
        SELECT "configValue" FROM "system_config"
        WHERE "configKey" = $1
        LIMIT 1
      `, [`team:${ownerId}:members`]);
      const raw = result.rows[0]?.configValue;
      if (!raw) return false;
      try {
        const members = JSON.parse(raw);
        return Array.isArray(members) && members.includes(userId);
      } catch {
        return false;
      }
    },
  };
}

/** Owner- and case-scoped evidence reads for the hosted runtime. */
export function createHostedEvidenceRepository(client: HostedQueryClient) {
  return {
    async findOwnedEvidence(userId: string, caseId: string, evidenceId: string): Promise<HostedEvidence | null> {
      const result = await client.query<HostedEvidence>(`
        SELECT * FROM "evidence"
        WHERE "id" = $1 AND "caseId" = $2 AND "userId" = $3
        LIMIT 1
      `, [evidenceId, caseId, userId]);
      return result.rows[0] ?? null;
    },
  };
}

/** Source-linked analysis reads require the owned evidence, case, and account. */
export function createHostedDocumentAnalysisRepository(client: HostedQueryClient) {
  return {
    async findOwnedAnalysis(
      userId: string,
      caseId: string,
      evidenceId: string,
      analysisId: string,
    ): Promise<HostedDocumentAnalysis | null> {
      const result = await client.query<HostedDocumentAnalysis>(`
        SELECT * FROM "document_analyses"
        WHERE "id" = $1 AND "evidenceId" = $2 AND "caseId" = $3 AND "userId" = $4
        LIMIT 1
      `, [analysisId, evidenceId, caseId, userId]);
      return result.rows[0] ?? null;
    },
  };
}
