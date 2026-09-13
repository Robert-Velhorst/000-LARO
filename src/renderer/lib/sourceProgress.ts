export type SourceSample = {
  at: number; total: number; pending: number; inventoryPending: number; analysisPending: number; status: string;
};
export type SourceHistory = { samples: SourceSample[]; lastAdvanceAt: number };
export const emptySourceHistory: SourceHistory = { samples: [], lastAdvanceAt: 0 };
const handled = (sample: SourceSample) => Math.max(0, sample.total - sample.pending);
const phase = (sample: SourceSample) => sample.inventoryPending > 0 ? 'inventory'
  : sample.pending > sample.analysisPending ? 'import' : 'analysis';

export function sampleSourceProgress(history: SourceHistory, next: SourceSample): SourceHistory {
  const previous = history.samples.at(-1);
  if (previous && next.at === previous.at) return history;
  // Never average a pause, tab suspension, retry or different processing phase into the ETA.
  if (!previous || next.status !== 'running' || previous.status !== 'running'
      || next.at < previous.at || next.at - previous.at > 20_000
      || handled(next) < handled(previous) || next.total < previous.total || phase(next) !== phase(previous)) {
    return { samples: [next], lastAdvanceAt: next.at };
  }
  return {
    samples: [...history.samples.filter(sample => next.at - sample.at <= 60_000), next],
    lastAdvanceAt: handled(next) > handled(previous) ? next.at : history.lastAdvanceAt,
  };
}

export function sourceProgress(sample: SourceSample, history: SourceHistory) {
  const completed = handled(sample);
  const percent = sample.total > 0 ? completed / sample.total * 100 : sample.status.startsWith('completed') ? 100 : 0;
  let etaSeconds: number | null = null;
  const first = history.samples[0];
  const latest = history.samples.at(-1);
  const stalled = sample.status === 'running' && sample.pending > 0 && history.lastAdvanceAt > 0 && sample.at - history.lastAdvanceAt >= 45_000;
  if (sample.status === 'running' && !stalled && first && latest && latest.at === sample.at
      && history.samples.length >= 3 && latest.at - first.at >= 15_000) {
    const count = handled(latest) - handled(first);
    if (count > 0) etaSeconds = Math.ceil(sample.pending * (latest.at - first.at) / count / 1000);
  }
  if (sample.pending === 0 && sample.status.startsWith('completed')) etaSeconds = 0;
  return { completed, percent: sample.pending > 0 ? Math.min(99.9, percent) : percent, etaSeconds, stalled };
}

export function formatSourceEta(seconds: number): string {
  const rounded = Math.ceil(seconds / (seconds < 60 ? 5 : seconds < 3600 ? 15 : 300)) * (seconds < 60 ? 5 : seconds < 3600 ? 15 : 300);
  const hours = Math.floor(rounded / 3600), minutes = Math.floor(rounded % 3600 / 60), rest = rounded % 60;
  if (hours) return `${hours} h${minutes ? ` ${minutes} min` : ''}`;
  if (minutes) return `${minutes} min${rest ? ` ${rest} s` : ''}`;
  return `${rest} s`;
}
