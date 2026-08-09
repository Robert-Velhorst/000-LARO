import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import type { AgentConfig } from '../../../shared/types';
import { getElectronAPI } from '@/lib/electronApiShim';
import { useI18n } from '@/contexts/I18nContext';
import { LanguageSelector } from '@/components/LanguageSelector';

interface Props {
  config: AgentConfig | null;
  onNavigate: (page: any) => void;
  onSave: (updates: Partial<AgentConfig>) => Promise<void>;
}

export default function SettingsPage({ config, onNavigate, onSave }: Props) {
  const { t } = useI18n();
  const electronAPI = getElectronAPI();
  const [caseId, setCaseId]     = useState(config?.caseId ?? '');
  const [saving, setSaving]     = useState(false);
  const [sysInfo, setSysInfo]   = useState<any>(null);
  const [version, setVersion]   = useState('');

  useEffect(() => {
    electronAPI.getSystemInfo().then(setSysInfo);
  electronAPI.getAppVersion().then(setVersion);
  }, []);

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
    <div className="min-h-screen bg-slate-950 text-white flex flex-col">
      <header className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
        <button
          onClick={() => onNavigate('home')}
          className="text-slate-400 hover:text-white transition-colors text-sm"
        >
          ← {t('common.back')}
        </button>
        <h1 className="font-semibold">{t('nav.settings')}</h1>
        <div className="w-16" />
      </header>

      <main className="flex-1 p-6 max-w-2xl mx-auto w-full space-y-6">
        <Section title={t('language.label')}>
          <LanguageSelector />
        </Section>
        <form onSubmit={handleSave} className="space-y-6">
          <Section title={t('scanner.defaultCase')}>
            <Field label={t('scanner.defaultCaseId')} hint={t('scanner.defaultCaseHint')}>
              <input
                value={caseId}
                onChange={e => setCaseId(e.target.value)}
                className="input"
                placeholder="case_abc123"
              />
            </Field>
          </Section>

          <button
            type="submit"
            disabled={saving}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
          >
            {saving ? t('scanner.saving') : t('scanner.saveSettings')}
          </button>
        </form>

        {/* System info */}
        <Section title={t('scanner.systemInfo')}>
          <div className="space-y-2 text-sm">
            <Row label={t('scanner.appVersion')} value={`v${version}`} />
            <Row label={t('scanner.device')} value={sysInfo?.hostname ?? '—'} />
            <Row label={t('scanner.platform')} value={sysInfo?.platform ?? '—'} />
            <Row label={t('scanner.username')} value={sysInfo?.username ?? '—'} />
          </div>
        </Section>
      </main>

      <style>{`.input { width:100%; background:#1e293b; border:1px solid #334155; border-radius:0.5rem; padding:0.625rem 0.75rem; color:white; font-size:0.875rem; outline:none; } .input:focus { ring: 2px solid #3b82f6; border-color:#3b82f6; }`}</style>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-900 rounded-xl p-5 border border-slate-800 space-y-4">
      <h2 className="text-sm font-semibold text-slate-300">{title}</h2>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-300 mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-xs text-slate-500 mt-1">{hint}</p>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-300 font-mono">{value}</span>
    </div>
  );
}
