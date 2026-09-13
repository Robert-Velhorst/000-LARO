import { trpc } from '@/lib/trpc';
import { useI18n } from '@/contexts/I18nContext';

export default function WorkspaceIdentity() {
  const { locale } = useI18n();
  const { data } = trpc.auth.environment.useQuery(undefined, { staleTime: Infinity, retry: false });
  if (!data || data.workspace === 'default') return null;
  const nl = locale === 'nl';
  return <div role="note" className="border-b border-border bg-muted px-4 py-2 text-center text-sm text-foreground">
    {data.workspace === 'preview'
      ? (nl ? 'Testomgeving. Je eigen account en dossiers zijn hier niet beschikbaar.' : 'Test workspace. Your personal account and cases are not available here.')
      : (nl ? 'Lokale dossieromgeving' : 'Local case workspace')}
    {data.workspace === 'local' && !data.backgroundJobsEnabled && <span className="ml-2 text-muted-foreground">
      {nl ? 'Automatische achtergrondtaken staan uit.' : 'Automatic background jobs are off.'}
    </span>}
  </div>;
}
