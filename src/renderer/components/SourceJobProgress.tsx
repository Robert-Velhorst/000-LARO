import { useEffect, useState } from 'react';
import { Clock3 } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { useI18n } from '@/contexts/I18nContext';
import { emptySourceHistory, formatSourceEta, sampleSourceProgress, sourceProgress, type SourceSample } from '@/lib/sourceProgress';

export default function SourceJobProgress({ sample }: { sample: SourceSample }) {
  const { t, formatNumber } = useI18n();
  const [history, setHistory] = useState(emptySourceHistory);
  const { at, total, pending, inventoryPending, analysisPending, status } = sample;
  useEffect(() => {
    setHistory(previous => sampleSourceProgress(previous, { at, total, pending, inventoryPending, analysisPending, status }));
  }, [at, total, pending, inventoryPending, analysisPending, status]);
  const progress = sourceProgress(sample, history);
  const number = (value: number) => formatNumber(value, { maximumFractionDigits: 1 });
  const percent = `${number(progress.percent)}%`;
  const done = status.startsWith('completed') && pending === 0;
  const eta = status === 'paused' ? t('sources.progress.paused')
    : done ? t('sources.progress.finished')
    : progress.stalled ? t('sources.progress.stalled')
    : progress.etaSeconds === null ? t('sources.progress.measuring')
    : t('sources.progress.about', { eta: formatSourceEta(progress.etaSeconds) });

  return <div className="min-w-0 space-y-2 py-2" aria-label={t('sources.progress.label')}>
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
      <span className="font-medium">{t('sources.progress.known')}</span>
      <strong className="tabular-nums">{percent}</strong>
    </div>
    <Progress className="h-2" value={progress.percent} aria-label={t('sources.progress.handled')}
      aria-valuetext={`${number(progress.completed)} / ${number(total)} (${percent})`} />
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-2 text-sm">
      <span className="tabular-nums text-muted-foreground">{t('sources.progress.summary', {
        completed: number(progress.completed), total: number(total), pending: number(pending),
      })}</span>
      <span className="flex min-w-0 items-start gap-2"><Clock3 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span><span className="text-muted-foreground">{t('sources.progress.eta')}</span>{eta}</span></span>
    </div>
    {inventoryPending > 0 && <p className="text-xs text-muted-foreground">{t('sources.progress.discovering')}</p>}
    {inventoryPending === 0 && pending > analysisPending && <p className="text-xs text-muted-foreground">{t('sources.progress.importing')}</p>}
    {done && status !== 'completed' && <p className="text-xs text-amber-500">{t('sources.progress.attention')}</p>}
  </div>;
}
