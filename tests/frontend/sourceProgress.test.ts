import { describe, expect, it } from 'vitest';
import { emptySourceHistory, formatSourceEta, sampleSourceProgress, sourceProgress, type SourceSample } from '../../src/renderer/lib/sourceProgress';

const sample = (at: number, pending: number, status = 'running'): SourceSample => ({ at, total: 100, pending, analysisPending: pending, inventoryPending: 0, status });
const measured = () => [sample(1000, 100), sample(6000, 95), sample(11000, 90), sample(16000, 85)]
  .reduce(sampleSourceProgress, emptySourceHistory);

describe('source progress from observed queue work', () => {
  it('shows known work progress immediately, without inventing an initial ETA', () => {
    expect(sourceProgress(sample(1000, 80), emptySourceHistory)).toMatchObject({ completed: 20, percent: 20, etaSeconds: null });
  });
  it('measures seconds remaining after enough observed progress', () => {
    expect(sourceProgress(sample(16000, 85), measured()).etaSeconds).toBe(85);
  });
  it('retains valid progress when discovery grows the queue', () => {
    const next = { ...sample(21000, 180), total: 200 };
    expect(sourceProgress(next, sampleSourceProgress(measured(), next))).toMatchObject({ completed: 20, percent: 10, etaSeconds: 180 });
  });
  it('does not include paused time on resume', () => {
    const paused = sampleSourceProgress(measured(), sample(21000, 85, 'paused'));
    expect(sourceProgress(sample(21000, 85, 'paused'), paused).etaSeconds).toBeNull();
    const next = sample(100000, 85);
    expect(sourceProgress(next, sampleSourceProgress(paused, next)).etaSeconds).toBeNull();
  });
  it('drops stale speed after long work without a completed item', () => {
    let history = measured();
    for (let at = 21000; at <= 61000; at += 5000) history = sampleSourceProgress(history, sample(at, 85));
    expect(sourceProgress(sample(61000, 85), history)).toMatchObject({ stalled: true, etaSeconds: null });
  });
  it('resets after retries, a phase change or a suspended tab', () => {
    for (const next of [sample(21000, 95), { ...sample(21000, 80), inventoryPending: 1 }, sample(60000, 80)]) {
      expect(sourceProgress(next, sampleSourceProgress(measured(), next)).etaSeconds).toBeNull();
    }
  });
  it('does not count a duplicate poll twice', () => {
    const history = measured();
    expect(sampleSourceProgress(history, sample(16000, 85))).toBe(history);
  });
  it('handles empty completed jobs and does not round pending work to 100%', () => {
    expect(sourceProgress({ ...sample(1000, 0, 'completed'), total: 0 }, emptySourceHistory)).toMatchObject({ percent: 100, etaSeconds: 0 });
    expect(sourceProgress({ ...sample(1000, 1), total: 100000 }, emptySourceHistory).percent).toBe(99.9);
  });
  it('formats approximate durations without false precision', () => {
    expect(formatSourceEta(12)).toBe('15 s');
    expect(formatSourceEta(85)).toBe('1 min 30 s');
    expect(formatSourceEta(3700)).toBe('1 h 5 min');
  });
});
