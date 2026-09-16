/**
 * Phase 061 — data invariants and constraints.
 *
 * Read-only verification of the invariants the app relies on but that are not
 * all enforced by declared DB constraints. Complements Phase 054 reconciliation
 * (which repairs orphans) — this reports the broader integrity picture and is
 * surfaced via the admin diagnostics endpoint and the doctor CLI.
 *
 * Each violation has a severity so callers can decide what is fatal.
 */
import { getDb } from "./db";
import { VALID_LEGAL_AREAS } from "./legalAreasValidator";
import { relationshipIntegrityReport } from "./relationshipIntegrity";

function rawClient(db: any): any {
  return db?.$client ?? db?.session?.client ?? null;
}

export interface Invariant {
  name: string;
  severity: "error" | "warning";
  ok: boolean;
  detail?: string;
  count?: number;
}

export async function verifyInvariants(): Promise<{ ok: boolean; invariants: Invariant[] }> {
  const db = await getDb();
  const sqlite = rawClient(db);
  const inv: Invariant[] = [];
  const add = (i: Invariant) => inv.push(i);

  if (!sqlite) {
    return { ok: false, invariants: [{ name: "database", severity: "error", ok: false, detail: "DB unavailable" }] };
  }

  const scalar = (sql: string): number => {
    try { return (sqlite.prepare(sql).get() as any)?.c ?? 0; } catch { return 0; }
  };

  // 1. No duplicate canonical user email identities (expression index should prevent this).
  const dupEmails = scalar(
    "SELECT count(*) AS c FROM (SELECT lower(trim(email)) FROM users WHERE email IS NOT NULL GROUP BY lower(trim(email)) HAVING count(*) > 1)"
  );
  add({ name: "users.email canonical unique", severity: "error", ok: dupEmails === 0, count: dupEmails });

  // 2. Every case has an owner.
  const caseNoOwner = scalar("SELECT count(*) AS c FROM cases WHERE userId IS NULL OR userId = ''");
  add({ name: "cases have an owner (userId)", severity: "error", ok: caseNoOwner === 0, count: caseNoOwner });

  // 3. No duplicate outreach per (case, lawyer).
  const dupOutreach = scalar(
    "SELECT count(*) AS c FROM (SELECT caseId, lawyerId FROM outreach_status GROUP BY caseId, lawyerId HAVING count(*) > 1)"
  );
  add({ name: "outreach unique per (case, lawyer)", severity: "error", ok: dupOutreach === 0, count: dupOutreach });

  // 4. No orphaned outreach (caseId points at a missing case).
  const orphanOutreach = scalar(
    "SELECT count(*) AS c FROM outreach_status o WHERE o.caseId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cases c WHERE c.id = o.caseId)"
  );
  add({ name: "no orphaned outreach rows", severity: "warning", ok: orphanOutreach === 0, count: orphanOutreach });

  // 5. cases.legalAreas is valid JSON of canonical areas.
  let badAreas = 0;
  try {
    const rows = sqlite.prepare("SELECT legalAreas FROM cases WHERE legalAreas IS NOT NULL").all() as Array<{ legalAreas: string }>;
    const valid = new Set(VALID_LEGAL_AREAS as readonly string[]);
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.legalAreas || "[]");
        if (!Array.isArray(parsed) || parsed.some((a: any) => typeof a !== "string" || !valid.has(a))) badAreas += 1;
      } catch { badAreas += 1; }
    }
  } catch { /* table may be empty */ }
  add({ name: "cases.legalAreas is valid canonical JSON", severity: "warning", ok: badAreas === 0, count: badAreas });

  // SQLite cannot add foreign keys to legacy tables without rebuilding them,
  // so readiness separately verifies the non-destructive relationship guards.
  const relationshipIntegrity = relationshipIntegrityReport(sqlite);
  add({
    name: "database relationship guards installed",
    severity: "error",
    ok: relationshipIntegrity.ok,
    count: relationshipIntegrity.missing.length,
    detail: relationshipIntegrity.ok
      ? `${relationshipIntegrity.installed} triggers installed`
      : `Missing: ${relationshipIntegrity.missing.join(", ")}`,
  });

  const ok = inv.filter((i) => i.severity === "error").every((i) => i.ok);
  return { ok, invariants: inv };
}
