import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import type { AgentConfig } from '../../../shared/types';
import { getElectronAPI } from '@/lib/electronApiShim';
import { useI18n } from '@/contexts/I18nContext';
import { LanguageSelector } from '@/components/LanguageSelector';

import { ArrowLeft, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CasePicker, QueryNotice } from '@/components/WorkspaceUi';

interface Props {
  config: AgentConfig | null;
  onNavigate: (page: any) => void;
  onSave: (updates: Partial<AgentConfig>) => Promise<void>;
}

export default function SettingsPage({ config, onNavigate, onSave }: Props) {
  const { t, locale } = useI18n();
  const [caseId, setCaseId]     = useState(config?.caseId ?? '');
  const [saving, setSaving]     = useState(false);
  const [sysInfo, setSysInfo]   = useState<any>(null);
  const [version, setVersion]   = useState('');

  const [infoError, setInfoError] = useState<Error | null>(null);
  const loadInfo = useCallback(async () => {
    setInfoError(null);
    try {
      setSysInfo(await getElectronAPI().getSystemInfo());
      setVersion(await getElectronAPI().getAppVersion());
    } catch (error) {
      setInfoError(error instanceof Error ? error : new Error("System information unavailable"));
    }
  }, []);
  useEffect(() => { void loadInfo(); }, [loadInfo]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave({ caseId: caseId || null });
      toast.success(t('scanner.settingsSaved'));
    } catch {
      toast.error(t('scanner.settingsSaveError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="flex items-center justify-between px-6 py-4 border-b border-border">
        <Button variant="ghost"
          disabled={saving}
          onClick={() => onNavigate('home')}
          className="text-muted-foreground hover:text-foreground transition-colors text-sm"
        >
          <ArrowLeft className="h-4 w-4" />{t('common.back')}
        </Button>
        <h1 className="font-semibold">{t('nav.settings')}</h1>
        <div className="w-16" />
      </header>

      <main className="flex-1 p-6 max-w-2xl mx-auto w-full space-y-6">
        <Section title={t('language.label')}>
          <LanguageSelector />
        </Section>
        <form onSubmit={handleSave} className="space-y-6">
          <Section title={t('scanner.defaultCase')}>
            <CasePicker value={caseId || null} onChange={(id) => setCaseId(id || '')} disabled={saving}
              emptyLabel={locale === 'nl' ? 'Geen standaarddossier' : 'No default case'} />
          </Section>

          <Button
            type="submit"
            disabled={saving}
            className="min-h-10"
          >
            <Save className="h-4 w-4" />{saving ? t('scanner.saving') : t('scanner.saveSettings')}
          </Button>
        </form>

        {/* System info */}
        <Section title={t('scanner.systemInfo')}>
          {infoError && <QueryNotice error={infoError} retry={loadInfo} />}
          <div className="space-y-2 text-sm">
            <Row label={t('scanner.appVersion')} value={version ? `v${version}` : "..."} />
            <Row label={t('scanner.device')} value={sysInfo?.hostname ?? '—'} />
            <Row label={t('scanner.platform')} value={sysInfo?.platform ?? '—'} />
            <Row label={t('scanner.username')} value={sysInfo?.username ?? '—'} />
          </div>
        </Section>
      </main>

    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-4 border-b border-border pb-6">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-all text-foreground">{value}</span>
    </div>
  );
}
