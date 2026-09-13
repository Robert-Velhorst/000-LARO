import { useEffect, useState } from 'react';
import { Clock3 } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { useI18n } from '@/contexts/I18nContext';
import { emptySourceHistory, formatSourceEta, sampleSourceProgress, sourceProgress, type SourceSample } from '@/lib/sourceProgress';

export default function SourceJobProgress({ sample }: { sample: SourceSample }) {
  const { locale } = useI18n();
  const nl = locale === 'nl';
  const [history, setHistory] = useState(emptySourceHistory);
  const { at, total, pending, inventoryPending, analysisPending, status } = sample;
  useEffect(() => {
    setHistory(previous => sampleSourceProgress(previous, { at, total, pending, inventoryPending, analysisPending, status }));
  }, [at, total, pending, inventoryPending, analysisPending, status]);
  const progress = sourceProgress(sample, history);
  const number = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 1 });
  const percent = `${number(progress.percent)}%`;
  const done = status.startsWith('completed') && pending === 0;
  const eta = status === 'paused' ? (nl ? 'Gepauzeerd' : 'Paused')
    : done ? (nl ? 'Verwerking afgerond' : 'Processing finished')
    : progress.stalled ? (nl ? 'Geen recente voortgang; ETA onbekend' : 'No recent progress; ETA unknown')
    : progress.etaSeconds === null ? (nl ? 'Snelheid meten...' : 'Measuring processing speed...')
    : `${nl ? 'circa' : 'about'} ${formatSourceEta(progress.etaSeconds)}`;

  return <div className="min-w-0 space-y-2 py-2" aria-label={nl ? 'Voortgang bronverwerking' : 'Source processing progress'}>
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
      <span className="font-medium">{nl ? 'Verwerking bekende taken' : 'Known work processing'}</span>
      <strong className="tabular-nums">{percent}</strong>
    </div>
    <Progress className="h-2" value={progress.percent} aria-label={nl ? 'Bekende taken behandeld' : 'Known work handled'}
      aria-valuetext={`${number(progress.completed)} / ${number(total)} (${percent})`} />
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-2 text-sm">
      <span className="tabular-nums text-muted-foreground">{number(progress.completed)} / {number(total)} {nl ? 'taken behandeld' : 'tasks handled'}
        {' · '}{number(pending)} {nl ? 'resterend' : 'remaining'}</span>
      <span className="flex min-w-0 items-start gap-2"><Clock3 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span><span className="text-muted-foreground">{nl ? 'ETA bekende wachtrij: ' : 'Known queue ETA: '}</span>{eta}</span></span>
    </div>
    {inventoryPending > 0 && <p className="text-xs text-muted-foreground">{nl
      ? 'Bestanden worden nog gezocht. Totaal en totale ETA zijn nog onbekend; nieuwe taken kunnen het percentage verlagen.'
      : 'Files are still being discovered. Final total and overall ETA are unknown; new tasks may lower the percentage.'}</p>}
    {inventoryPending === 0 && pending > analysisPending && <p className="text-xs text-muted-foreground">{nl
      ? 'Import loopt. Nieuwe analysetaken kunnen de resterende tijd verlengen.'
      : 'Import is ongoing. New analysis tasks may increase the remaining time.'}</p>}
    {done && status !== 'completed' && <p className="text-xs text-amber-500">{nl
      ? 'De verwerkingsronde is klaar; fouten of dossierkeuzes vragen nog aandacht.'
      : 'The processing pass has finished; errors or dossier decisions still need attention.'}</p>}
  </div>;
}
