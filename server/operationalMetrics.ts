import type { RequestHandler } from 'express';

interface RequestObservation {
  at: number;
  durationMs: number;
  status: number;
}

const WINDOW_MS = 5 * 60_000;
const MAX_OBSERVATIONS = 2_000;
const startedAt = Date.now();
const recent: RequestObservation[] = [];
let totalRequests = 0;
let totalServerErrors = 0;
let inFlight = 0;

function prune(now: number): void {
  const cutoff = now - WINDOW_MS;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    if (recent[index].at < cutoff) recent.splice(index, 1);
  }
  if (recent.length > MAX_OBSERVATIONS) recent.splice(0, recent.length - MAX_OBSERVATIONS);
}

export function recordOperationalRequest(status: number, durationMs: number, at = Date.now()): void {
  totalRequests += 1;
  if (status >= 500) totalServerErrors += 1;
  recent.push({
    at,
    status,
    durationMs: Math.max(0, Math.round(durationMs * 10) / 10),
  });
  prune(at);
}

export const operationalMetricsMiddleware: RequestHandler = (_req, res, next) => {
  const started = performance.now();
  inFlight += 1;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    inFlight = Math.max(0, inFlight - 1);
    recordOperationalRequest(res.statusCode || 500, performance.now() - started);
  };
  res.once('finish', finish);
  res.once('close', finish);
  next();
};

export function getOperationalMetrics(now = Date.now()) {
  prune(now);
  const durations = recent.map((entry) => entry.durationMs).sort((a, b) => a - b);
  const serverErrors = recent.filter((entry) => entry.status >= 500).length;
  const clientErrors = recent.filter((entry) => entry.status >= 400 && entry.status < 500).length;
  const average = durations.length
    ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length
    : 0;
  const p95Index = durations.length ? Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1) : 0;
  return {
    uptimeSeconds: Math.max(0, Math.floor((now - startedAt) / 1000)),
    inFlight,
    totalRequests,
    totalServerErrors,
    recentWindowMinutes: WINDOW_MS / 60_000,
    recentRequests: durations.length,
    recentClientErrors: clientErrors,
    recentServerErrors: serverErrors,
    recentAverageLatencyMs: Math.round(average * 10) / 10,
    recentP95LatencyMs: durations[p95Index] || 0,
  };
}

export function logOperationalEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, string | number | boolean | null> = {},
): void {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.log(entry);
}
