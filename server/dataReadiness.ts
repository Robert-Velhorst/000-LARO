import { getDb } from "./db";
import { verifyInvariants, type Invariant } from "./invariants";
import { reconcileReport, type ReconcileReport } from "./reconcile";
import { assessNumericIntegrity, type NumericIntegrityReport } from "./numericIntegrity";

export interface DataReadinessReport {
  ok: boolean;
  sqliteIntegrity: string;
  foreignKeyViolations: number;
  invariants: Invariant[];
  reconciliation: ReconcileReport;
  numericIntegrity: NumericIntegrityReport;
  demoLikeRecords: {
    users: number;
    cases: number;
  };
}

function rawClient(db: any): any {
  return db?.$client ?? db?.session?.client ?? null;
}

function scalar(sqlite: any, statement: string): number {
  return Number((sqlite.prepare(statement).get() as { count?: number } | undefined)?.count || 0);
}

export async function assessDataReadiness(): Promise<DataReadinessReport> {
  const db = await getDb();
  const sqlite = rawClient(db);
  if (!sqlite) throw new Error("Database not available");

  const integrityRows = sqlite.pragma("integrity_check") as Array<Record<string, unknown>>;
  const integrityValues = integrityRows.flatMap((row) => Object.values(row).map(String));
  const sqliteIntegrity = integrityValues.length === 1 ? integrityValues[0] : integrityValues.join("; ");
  const foreignKeyViolations = (sqlite.pragma("foreign_key_check") as unknown[]).length;
  const invariantReport = await verifyInvariants();
  const reconciliation = await reconcileReport();
  const numericIntegrity = assessNumericIntegrity(sqlite);

  // Exact development markers only. Do not reject ordinary example.com addresses,
  // which may be intentionally used in an isolated acceptance environment.
  const demoLikeRecords = {
    users: scalar(sqlite, `
      SELECT count(*) AS count
      FROM users
      WHERE lower(id) IN ('demo-user-123', 'test-user-id')
         OR lower(email) LIKE '%@example.invalid'
         OR lower(email) LIKE '%@example.test'
    `),
    cases: scalar(sqlite, `
      SELECT count(*) AS count
      FROM cases
      WHERE lower(id) IN ('demo-case-123', 'test-case-id')
         OR lower(clientEmail) LIKE '%@example.invalid'
         OR lower(clientEmail) LIKE '%@example.test'
    `),
  };

  const allInvariantsClean = invariantReport.invariants.every((item) => item.ok);
  const noReconciliationIssues =
    reconciliation.totalOrphans === 0 && reconciliation.duplicateEmails.length === 0;
  const noDemoMarkers = demoLikeRecords.users === 0 && demoLikeRecords.cases === 0;

  return {
    ok:
      sqliteIntegrity === "ok" &&
      foreignKeyViolations === 0 &&
      allInvariantsClean &&
      noReconciliationIssues &&
      numericIntegrity.ok &&
      noDemoMarkers,
    sqliteIntegrity,
    foreignKeyViolations,
    invariants: invariantReport.invariants,
    reconciliation,
    numericIntegrity,
    demoLikeRecords,
  };
}
