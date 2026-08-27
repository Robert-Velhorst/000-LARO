/**
 * Phase 027 — reminders & scheduling.
 *
 * A real reminder sweep: scans a user's cases and creates user-facing
 * notifications for items that need timely attention (drafts awaiting approval,
 * high-urgency cases with no evidence). It is IDEMPOTENT per (case, kind, day):
 * a reminder is created at most once per case per kind per calendar day, so a
 * scheduled run does not spam duplicates.
 *
 * Wired into the job scheduler (cronScheduler) and exposed via an endpoint so a
 * user can trigger it. Reminders are honest — each links to the real case state
 * that triggered it; nothing external is sent.
 */
import { getDb } from "./db";
import { cases as casesTable, evidence as evidenceTable, outreachStatus, notifications } from "./schema";
import { and, eq, sql } from "drizzle-orm";
import { getSystemSwitch, setSystemSwitch } from "./systemState";
import { createNotification } from "./notifications";

export interface ReminderResult {
  created: number;
  scanned: number;
}

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Run the reminder sweep for one user. `now` is injectable for tests. */
export async function runRemindersForUser(userId: string, now: Date = new Date()): Promise<ReminderResult> {
  const db = await getDb();
  if (!db) return { created: 0, scanned: 0 };
  const today = dayKey(now);

  const userCases = await db
    .select({
      id: casesTable.id,
      clientName: casesTable.clientName,
      urgency: casesTable.urgency,
      pendingOutreachCount: sql<number>`count(distinct ${outreachStatus.id})`,
      evidenceCount: sql<number>`count(distinct ${evidenceTable.id})`,
    })
    .from(casesTable)
    .leftJoin(evidenceTable, and(
      eq(evidenceTable.caseId, casesTable.id),
      eq(evidenceTable.userId, userId),
    ))
    .leftJoin(outreachStatus, and(
      eq(outreachStatus.caseId, casesTable.id),
      eq(outreachStatus.status, "PendingApproval"),
    ))
    .where(eq(casesTable.userId, userId))
    .groupBy(casesTable.id, casesTable.clientName, casesTable.urgency);

  let created = 0;
  for (const c of userCases) {
    const title = c.clientName || c.id;

    // Reminder 1: outreach drafts awaiting approval.
    const pendingOutreachCount = Number(c.pendingOutreachCount || 0);
    if (pendingOutreachCount > 0) {
      created += await emitOnce(userId, c.id, "approval-pending", today,
        `Reminder: ${pendingOutreachCount} outreach draft(s) for "${title}" are still awaiting your approval.`);
    }

    // Reminder 2: high-urgency case with no evidence.
    if ((c.urgency || "").toLowerCase() === "high") {
      if (Number(c.evidenceCount || 0) === 0) {
        created += await emitOnce(userId, c.id, "urgent-no-evidence", today,
          `Reminder: high-urgency case "${title}" still has no evidence. Add documents so it can be assessed.`);
      }
    }
  }
  return { created, scanned: userCases.length };
}

/** Create a notification at most once per (case, kind, day). */
async function emitOnce(userId: string, caseId: string, kind: string, day: string, message: string): Promise<number> {
  const guardKey = `reminder:${userId}:${caseId}:${kind}:${day}`;
  if (await getSystemSwitch(guardKey)) return 0;
  await createNotification({ userId, title: "Reminder", body: message });
  await setSystemSwitch(guardKey, true);
  return 1;
}

/** Sweep reminders for all users (for the scheduled job). */
export async function runReminderSweep(now: Date = new Date()): Promise<{ users: number; created: number }> {
  const db = await getDb();
  if (!db) return { users: 0, created: 0 };
  const rows = await db.selectDistinct({ userId: casesTable.userId }).from(casesTable);
  let created = 0;
  for (const r of rows) {
    const res = await runRemindersForUser(r.userId, now);
    created += res.created;
  }
  return { users: rows.length, created };
}
