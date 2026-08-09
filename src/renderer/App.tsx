import { useEffect, useState } from "react";
import HomePage from "./pages/HomePage";
import ScanPage from "./pages/ScanPage";
import SettingsPage from "./pages/SettingsPage";
import { getElectronAPI } from "@/lib/electronApiShim";
import { trpc } from "@/lib/trpc";
import type { AgentConfig, Page } from "../../shared/types";
import { useI18n } from "./contexts/I18nContext";

export default function App() {
  const { t } = useI18n();
  const electronAPI = getElectronAPI();
  const [currentPage, setCurrentPage] = useState<Page>("home");
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [activeScanId, setActiveScanId] = useState<string | null>(null);

  const session = trpc.auth.me.useQuery(undefined, {
    refetchInterval: 15_000,
    retry: false,
  });
  const scannerToken = trpc.auth.getScannerToken.useQuery(undefined, {
    enabled: Boolean(session.data),
    refetchInterval: 10 * 60_000,
    retry: false,
  });

  useEffect(() => {
    void electronAPI.getConfig().then(setConfig).catch((error: unknown) => {
      console.error("Failed to load scanner configuration:", error);
    });
  }, []);

  useEffect(() => {
    if (!session.data || !scannerToken.data?.token) return;
    void electronAPI
      .setConfig({
        token: scannerToken.data.token,
        userId: session.data.id,
        deviceId: "local-evidence-scanner",
      })
      .then(setConfig)
      .catch((error: unknown) => console.error("Failed to authorize evidence scanner:", error));
  }, [session.data, scannerToken.data?.token]);

  useEffect(() => {
    if (!session.isFetched || session.data || !config?.token) return;
    void electronAPI
      .setConfig({ token: null, userId: null, deviceId: null, caseId: null })
      .then(setConfig)
      .catch((error: unknown) => console.error("Failed to clear scanner authorization:", error));
  }, [session.isFetched, session.data, config?.token]);

  const saveSettings = async (updates: Partial<AgentConfig>) => {
    const updated = await electronAPI.setConfig({ caseId: updates.caseId ?? null });
    setConfig(updated);
  };

  if (session.isLoading || (session.data && scannerToken.isLoading) || !config) {
    return <ScannerStatus title={t("scanner.preparing")} detail={t("scanner.verifySession")} />;
  }

  if (!session.data || scannerToken.isError || !scannerToken.data?.token) {
    return (
      <ScannerStatus
        title={t("scanner.signInRequired")}
        detail={t("scanner.signInDetail")}
        actionLabel={t("common.retry")}
        onAction={() => void session.refetch()}
      />
    );
  }

  if (!config.token || config.userId !== session.data.id) {
    return <ScannerStatus title={t("scanner.preparing")} detail={t("scanner.createSession")} />;
  }

  switch (currentPage) {
    case "scan":
      return (
        <ScanPage
          activeScanId={activeScanId}
          onNavigate={(page) => setCurrentPage(page as Page)}
        />
      );
    case "settings":
      return (
        <SettingsPage
          config={config}
          onNavigate={(page) => setCurrentPage(page as Page)}
          onSave={saveSettings}
        />
      );
    default:
      return (
        <HomePage
          config={config}
          onNavigate={(page) => setCurrentPage(page as Page)}
          onScanStarted={(scanId) => {
            setActiveScanId(scanId);
            setCurrentPage("scan");
          }}
        />
      );
  }
}

function ScannerStatus({
  title,
  detail,
  actionLabel,
  onAction,
}: {
  title: string;
  detail: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const { t } = useI18n();
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-white">
      <section className="w-full max-w-md border border-slate-800 bg-slate-900 p-6">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-slate-400">{detail}</p>
        <div className="mt-5 flex gap-3">
          {actionLabel && onAction ? (
            <button type="button" onClick={onAction} className="bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700">
              {actionLabel}
            </button>
          ) : null}
          <button type="button" onClick={() => window.close()} className="border border-slate-700 px-4 py-2 text-sm hover:bg-slate-800">
            {t("common.close")}
          </button>
        </div>
      </section>
    </main>
  );
}
