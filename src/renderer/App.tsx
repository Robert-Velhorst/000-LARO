import { useCallback, useEffect, useRef, useState } from "react";
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
  const [activeScan, setActiveScan] = useState<{ ownerId: string; scanId: string } | null>(null);
  const [sessionInvalidated, setSessionInvalidated] = useState(false);
  const [sessionCheckFailed, setSessionCheckFailed] = useState(false);
  const sessionGeneration = useRef(0);
  const [configError, setConfigError] = useState<string | null>(null);
  const loadConfig = useCallback(async () => {
    setConfigError(null);
    try { setConfig(await getElectronAPI().getConfig()); }
    catch (error) { setConfigError(error instanceof Error ? error.message : "Scanner configuration unavailable"); }
  }, []);

  const session = trpc.auth.me.useQuery(undefined, {
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const ownerId = session.data?.id ?? null;
  const activeScanId = activeScan?.ownerId === ownerId ? activeScan.scanId : null;

  useEffect(() => {
    const clearForSessionChange = () => {
      const generation = ++sessionGeneration.current;
      setSessionInvalidated(true);
      setSessionCheckFailed(false);
      setActiveScan(null);
      setCurrentPage("home");
      setConfig((current) => current ? { ...current, caseId: null } : current);
      void session.refetch().then((result) => {
        if (sessionGeneration.current !== generation) return;
        if (result.isError) setSessionCheckFailed(true);
        else setSessionInvalidated(false);
      }).catch(() => {
        if (sessionGeneration.current === generation) setSessionCheckFailed(true);
      });
    };
    window.addEventListener('laro:scanner-session-changed', clearForSessionChange);
    return () => window.removeEventListener('laro:scanner-session-changed', clearForSessionChange);
  }, [session.refetch]);

  useEffect(() => {
    if (activeScan && activeScan.ownerId !== ownerId) {
      setActiveScan(null);
      setCurrentPage("home");
      setConfig((current) => current ? { ...current, caseId: null } : current);
    }
  }, [activeScan, ownerId]);

  useEffect(() => {
    if (!session.isSuccess || session.data || !config?.caseId) return;
    void electronAPI
      .setConfig({ caseId: null })
      .then(setConfig)
      .catch((error: unknown) => console.error("Failed to clear scanner case selection:", error));
  }, [session.isSuccess, session.data, config?.caseId]);

  useEffect(() => {
    if (!ownerId || activeScanId) return;
    let cancelled = false;
    const storageKey = `laroScannerActiveScan:${ownerId}`;
    const storedScanId = window.localStorage.getItem(storageKey);
    if (!storedScanId) return;
    void electronAPI.getScanProgress(storedScanId).then(({ progress }: { progress: { status?: string } | null }) => {
      if (cancelled) return;
      if (!progress || !["review", "uploading", "upload-paused", "failed", "cancelled"].includes(progress.status || "")) {
        window.localStorage.removeItem(storageKey);
        return;
      }
      setActiveScan({ ownerId, scanId: storedScanId });
      setCurrentPage("scan");
    }).catch(() => { if (!cancelled) window.localStorage.removeItem(storageKey); });
    return () => { cancelled = true; };
  }, [ownerId, activeScanId, electronAPI]);

  const saveSettings = async (updates: Partial<AgentConfig>) => {
    const updated = await electronAPI.setConfig({ caseId: updates.caseId ?? null });
    setConfig(updated);
  };

  if (configError || session.error) {
    return <ScannerStatus title={locale === "nl" ? "Scanner niet beschikbaar" : "Scanner unavailable"}
      detail={configError || session.error!.message} actionLabel={t("common.retry")}
      onAction={() => { void loadConfig(); void session.refetch(); }} />;
  }

  if (sessionInvalidated && sessionCheckFailed) {
    return <ScannerStatus title={locale === "nl" ? "Sessie niet beschikbaar" : "Session unavailable"}
      detail={t("scanner.verifySession")} actionLabel={t("common.retry")}
      onAction={() => window.location.reload()} />;
  }

  if (sessionInvalidated || session.isLoading || !config) {
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

  switch (currentPage === "scan" && !activeScanId ? "home" : currentPage) {
    case "scan":
      return (
        <ScanPage
          key={`${ownerId}:${activeScanId}`}
          activeScanId={activeScanId}
          onNavigate={(page) => setCurrentPage(page as Page)}
        />
      );
    case "settings":
      return (
        <SettingsPage
          key={ownerId}
          config={config}
          onNavigate={(page) => setCurrentPage(page as Page)}
          onSave={saveSettings}
        />
      );
    default:
      return (
        <HomePage
          key={ownerId}
          config={config}
          onNavigate={(page) => setCurrentPage(page as Page)}
          onScanStarted={(scanId) => {
            if (session.data?.id) window.localStorage.setItem(`laroScannerActiveScan:${session.data.id}`, scanId);
            if (ownerId) setActiveScan({ ownerId, scanId });
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
