import { describe, expect, it } from 'vitest';
import { getOperationalMetrics, recordOperationalRequest } from '../../server/operationalMetrics';

describe('privacy-safe operational metrics', () => {
  it('aggregates bounded request health without retaining request identifiers', () => {
    const before = getOperationalMetrics();
    const now = Date.now();
    recordOperationalRequest(200, 10, now);
    recordOperationalRequest(404, 20, now);
    recordOperationalRequest(503, 100, now);
    const after = getOperationalMetrics(now);

    expect(after.totalRequests - before.totalRequests).toBe(3);
    expect(after.totalServerErrors - before.totalServerErrors).toBe(1);
    expect(after.recentClientErrors).toBeGreaterThanOrEqual(1);
    expect(after.recentServerErrors).toBeGreaterThanOrEqual(1);
    expect(after.recentP95LatencyMs).toBeGreaterThanOrEqual(100);
    expect(Object.keys(after)).not.toContain('paths');
    expect(JSON.stringify(after)).not.toContain('caseId');
  });

  it('expires observations outside the five-minute window', () => {
    const old = Date.now() - 6 * 60_000;
    recordOperationalRequest(500, 999, old);
    const snapshot = getOperationalMetrics(Date.now());
    expect(snapshot.recentP95LatencyMs).toBeLessThan(999);
  });
});

