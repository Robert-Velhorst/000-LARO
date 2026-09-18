import { useCallback, useEffect, useState } from "react";
import HomePage from "./pages/HomePage";
import ScanPage from "./pages/ScanPage";
import SettingsPage from "./pages/SettingsPage";
import { getElectronAPI, isElectron } from "@/lib/electronApiShim";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import type { AgentConfig, Page } from "../../shared/types";
import { useI18n } from "./contexts/I18nContext";

export default function App() {
  const { t, locale } = useI18n();
  const electronAPI = getElectronAPI();
  const [currentPage, setCurrentPage] = useState<Page>("home");
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [activeScanId, setActiveScanId] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const loadConfig = useCallback(async () => {
    setConfigError(null);
    try { setConfig(await getElectronAPI().getConfig()); }
    catch (error) { setConfigError(error instanceof Error ? error.message : "Scanner configuration unavailable"); }
  }, []);

  const session = trpc.auth.me.useQuery(undefined, {
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (!session.isSuccess || session.data || !config?.caseId) return;
    void electronAPI
      .setConfig({ caseId: null })
      .then(setConfig)
      .catch((error: unknown) => console.error("Failed to clear scanner case selection:", error));
  }, [session.isSuccess, session.data, config?.caseId]);

  useEffect(() => {
    const userId = session.data?.id;
    if (!userId || activeScanId) return;
    const storageKey = `laroScannerActiveScan:${userId}`;
    const storedScanId = window.localStorage.getItem(storageKey);
    if (!storedScanId) return;
    void electronAPI.getScanProgress(storedScanId).then(({ progress }: { progress: { status?: string } | null }) => {
      if (!progress || !["review", "uploading", "upload-paused", "failed", "cancelled"].includes(progress.status || "")) {
        window.localStorage.removeItem(storageKey);
        return;
      }
      setActiveScanId(storedScanId);
      setCurrentPage("scan");
    }).catch(() => window.localStorage.removeItem(storageKey));
  }, [session.data?.id, activeScanId, electronAPI]);

  const saveSettings = async (updates: Partial<AgentConfig>) => {
    const updated = await electronAPI.setConfig({ caseId: updates.caseId ?? null });
    setConfig(updated);
  };

  if (configError || session.error) {
    return <ScannerStatus title={locale === "nl" ? "Scanner niet beschikbaar" : "Scanner unavailable"}
      detail={configError || session.error!.message} actionLabel={t("common.retry")}
      onAction={() => { void loadConfig(); void session.refetch(); }} />;
  }

  if (session.isLoading || !config) {
    return <ScannerStatus title={t("scanner.preparing")} detail={t("scanner.verifySession")} />;
  }

  if (!session.data) {
    return (
      <ScannerStatus
        title={t("scanner.signInRequired")}
        detail={t("scanner.signInDetail")}
        actionLabel={t("common.retry")}
        onAction={() => void session.refetch()}
      />
    );
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
            if (session.data?.id) window.localStorage.setItem(`laroScannerActiveScan:${session.data.id}`, scanId);
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
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <section className="w-full max-w-md space-y-3">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p role="status" className="mt-2 break-words text-sm leading-6 text-muted-foreground">{detail}</p>
        <div className="mt-5 flex gap-3">
          {actionLabel && onAction ? (
            <Button type="button" onClick={onAction}>
              {actionLabel}
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={() => isElectron() ? window.close() : window.location.assign("/")}>
            {isElectron() ? t("common.close") : "LARO"}
          </Button>
        </div>
      </section>
    </main>
  );
}
