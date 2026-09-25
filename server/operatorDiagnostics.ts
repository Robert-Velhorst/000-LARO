import { ENV } from './_core/env';
import { APP_VERSION } from './_core/version';
import { getJobStatus } from './cronScheduler';
import { getDb } from './db';
import { resolveOutboundEmailConfiguration } from './emailConfig';
import { getLLMProviderDescriptors } from './llm';
import { getOperationalMetrics } from './operationalMetrics';
import { getScheduledBackupHealth, type ScheduledBackupHealth } from './scheduledBackup';

export async function getDatabaseReadiness(): Promise<boolean> {
  try {
    return !!(await getDb());
  } catch {
    return false;
  }
}

export async function getPublicReadiness() {
  const dbReady = await getDatabaseReadiness();
  return {
    status: dbReady ? 'ready' as const : 'not-ready' as const,
    dbReady,
  };
}

export async function getPublicHealthSummary() {
  const dbReady = await getDatabaseReadiness();
  return {
    status: dbReady ? 'healthy' as const : 'degraded' as const,
    dbReady,
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
  };
}

function readBackupHealth(): ScheduledBackupHealth {
  try {
    return getScheduledBackupHealth();
  } catch {
    return {
      configured: true,
      status: 'failed',
      destinationKind: null,
      latestValidAt: null,
      ageHours: null,
      maxAgeHours: null,
      retentionCount: null,
      retentionDays: null,
    };
  }
}

/**
 * Canonical protected snapshot for operator/admin surfaces.
 *
 * Public probes deliberately do not call this function: backup posture, worker
 * topology, failure history, and traffic metrics are operational capabilities,
 * not liveness metadata.
 */
export async function getOperatorDiagnostics() {
  const dbReady = await getDatabaseReadiness();
  const backup = readBackupHealth();
  const jobs = getJobStatus().map((job) => ({ ...job }));
  const workers = jobs.map((worker) => {
    const failing = !!worker.lastErrorAt && (!worker.lastSuccessAt || worker.lastErrorAt > worker.lastSuccessAt);
    return {
      ...worker,
      status: !worker.enabled ? 'disabled' as const
        : failing ? 'failed' as const
          : worker.lastSuccessAt ? 'healthy' as const : 'pending' as const,
      lastRunAtISO: worker.lastRunAt ? new Date(worker.lastRunAt).toISOString() : null,
      lastSuccessAtISO: worker.lastSuccessAt ? new Date(worker.lastSuccessAt).toISOString() : null,
      lastErrorAtISO: worker.lastErrorAt ? new Date(worker.lastErrorAt).toISOString() : null,
    };
  });
  const warnings = [
    ...(!backup.configured ? ['Automatic recovery backups are not configured.'] : []),
    ...(backup.status === 'stale' ? ['The latest verified recovery backup is stale.'] : []),
    ...(backup.status === 'failed' ? ['The automatic recovery backup job needs attention.'] : []),
    ...(backup.destinationKind === 'local' ? ['Recovery backups are stored locally and are not off-device.'] : []),
  ];
  const workerFailure = workers.some((worker) => worker.status === 'failed');
  const operationallyDegraded = !dbReady || workerFailure || backup.status === 'failed' || backup.status === 'stale';
  return {
    generatedAt: new Date().toISOString(),
    status: operationallyDegraded ? 'degraded' as const : 'healthy' as const,
    version: APP_VERSION,
    system: {
      node: process.version,
      platform: process.platform,
      uptimeSeconds: Math.round(process.uptime()),
      env: ENV.NODE_ENV,
      isProduction: ENV.isProd,
      demoMode: ENV.isDemo,
    },
    db: { ready: dbReady },
    backup,
    warnings,
    operations: getOperationalMetrics(),
    jobs,
    workers,
    integrations: {
      ai: getLLMProviderDescriptors().some((provider) => provider.configured),
      s3: !!ENV.AWS_S3_BUCKET,
      google: !!(ENV.GOOGLE_CLIENT_ID && ENV.GOOGLE_CLIENT_SECRET),
      microsoft: !!(ENV.MICROSOFT_CLIENT_ID && ENV.MICROSOFT_CLIENT_SECRET),
      email: resolveOutboundEmailConfiguration().configured,
    },
  };
}
