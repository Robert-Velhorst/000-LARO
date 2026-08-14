import cron from 'node-cron';
import { runAutoCollectionForAllCases } from './autoCollectionService';
import { retryWithBackoff } from './retry';
import { logOperationalEvent } from './operationalMetrics';
import {
  readScheduledBackupConfig,
  refreshScheduledBackupState,
  runScheduledBackup,
} from './scheduledBackup';

/**
 * Phase 016 — background jobs, schedulers, and workers.
 *
 * Every scheduled job runs through runJob(), which adds:
 *  - error isolation (a failing job never crashes the scheduler),
 *  - bounded retry with backoff,
 *  - observable status (last run, last success, last error, run count) exposed
 *    via getJobStatus() for the health/observability endpoints.
 *
 * The hourly outreach job does NOT send anything. The real send path is
 * explicit, human-approved, provider-backed, and feature-flagged; scheduled
 * follow-ups remain disabled so a cron tick cannot contact a third party.
 */

export interface JobStatus {
  name: string;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  runs: number;
  failures: number;
  enabled: boolean;
}

const jobStatus = new Map<string, JobStatus>();
let initialized = false;
const scheduledTasks: Array<{ stop: () => void; destroy?: () => void }> = [];

export const CRON_SCHEDULES = {
  autoCollection: '0 2 * * *',
  outreachHeartbeat: '0 * * * *',
  reminders: '0 8 * * *',
  retention: '30 3 * * *',
  backup: '15 1 * * *',
} as const;

function ensureStatus(name: string): JobStatus {
  let s = jobStatus.get(name);
  if (!s) {
    s = {
      name,
      lastRunAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null,
      runs: 0,
      failures: 0,
      enabled: true,
    };
    jobStatus.set(name, s);
  }
  return s;
}

export function getJobStatus(): JobStatus[] {
  return Array.from(jobStatus.values());
}

/**
 * Run a job with error isolation and bounded retry+backoff. Never throws.
 */
export async function runJob(
  name: string,
  fn: () => Promise<void>,
  opts: { retries?: number; baseDelayMs?: number } = {}
): Promise<void> {
  const { retries = 2, baseDelayMs = 1000 } = opts;
  const s = ensureStatus(name);
  s.runs += 1;
  s.lastRunAt = nowMs();

  try {
    // Phase 110 — delegate to the shared, tested retry primitive. A scheduled job
    // wants to retry on ANY failure (transient or not), so isRetryable is forced
    // true here; the default heuristic is used elsewhere for external calls.
    await retryWithBackoff(fn, {
      attempts: retries + 1,
      baseDelayMs,
      isRetryable: () => true,
      sleep,
      jitter: () => 0, // deterministic backoff for the scheduler
      onRetry: ({ attempt, delayMs, err }) => {
        const msg = err instanceof Error ? err.message : String(err);
        logOperationalEvent('warn', 'worker_retry', {
          worker: name,
          attempt,
          attempts: retries + 1,
          delayMs,
          error: msg.slice(0, 500),
        });
      },
    });
    s.lastSuccessAt = nowMs();
    s.lastError = null;
    logOperationalEvent('info', 'worker_success', { worker: name, run: s.runs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    s.failures += 1;
    s.lastErrorAt = nowMs();
    s.lastError = msg;
    logOperationalEvent('error', 'worker_failed', {
      worker: name,
      attempts: retries + 1,
      error: msg.slice(0, 500),
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Date.now via a helper so it is easy to reason about / stub if needed.
function nowMs(): number {
  return Date.now();
}

export function initCronScheduler() {
  if (initialized) return;
  initialized = true;
  console.log('[Cron] Initializing scheduled tasks...');
  ensureStatus('auto-collection');
  ensureStatus('outreach-heartbeat');
  ensureStatus('reminders');
  ensureStatus('retention');
  ensureStatus('backup');

  // Daily auto-collection at 02:00.
  scheduledTasks.push(cron.schedule(CRON_SCHEDULES.autoCollection, () => {
    void runJob('auto-collection', async () => { await runAutoCollectionForAllCases(); }, { retries: 2 });
  }));

  // Hourly outreach heartbeat — intentionally does NOT send anything.
  scheduledTasks.push(cron.schedule(CRON_SCHEDULES.outreachHeartbeat, () => {
    void runJob('outreach-heartbeat', async () => {
      console.log('[Cron] Automated outreach follow-ups are disabled; explicit approved sends only. Heartbeat recorded.');
    }, { retries: 0 });
  }));

  // Phase 027 — daily reminder sweep: creates user notifications for items needing
  // attention (approval-pending, urgent-no-evidence). Idempotent per case/kind/day.
  scheduledTasks.push(cron.schedule(CRON_SCHEDULES.reminders, () => {
    void runJob('reminders', async () => {
      const { runReminderSweep } = await import('./reminders');
      const res = await runReminderSweep();
      console.log(`[Cron] Reminder sweep: ${res.created} reminder(s) across ${res.users} user(s).`);
    }, { retries: 1 });
  }));

  const runRetention = async () => {
    const { runRetentionSweep } = await import('./retention');
    const report = await runRetentionSweep();
    console.log(
      `[Cron] Retention sweep: removed ${report.auditLogsDeleted} audit log(s) older than ${report.cutoffISO}.`
    );
  };

  // Catch up after downtime at startup, then enforce the policy daily. The
  // sweep is idempotent and never touches cases, evidence, or outreach data.
  void runJob('retention', runRetention, { retries: 1 });
  scheduledTasks.push(cron.schedule(CRON_SCHEDULES.retention, () => {
    void runJob('retention', runRetention, { retries: 1 });
  }));

  const backupConfig = readScheduledBackupConfig();
  const backupHealth = refreshScheduledBackupState(backupConfig);
  if (backupConfig) {
    if (backupHealth.status !== 'healthy') {
      void runJob('backup', () => runScheduledBackup(backupConfig), { retries: 1 });
    }
    scheduledTasks.push(cron.schedule(CRON_SCHEDULES.backup, () => {
      void runJob('backup', () => runScheduledBackup(backupConfig), { retries: 1 });
    }));
  } else {
    const status = ensureStatus('backup');
    status.enabled = false;
  }

  console.log('[Cron] Scheduled tasks loaded:', getJobStatus().map((j) => j.name).join(', '));
}

export function stopCronScheduler(): void {
  for (const task of scheduledTasks.splice(0)) {
    try {
      task.stop();
      task.destroy?.();
    } catch (error) {
      console.warn('[Cron] Could not stop a scheduled task:', error);
    }
  }
  initialized = false;
}
