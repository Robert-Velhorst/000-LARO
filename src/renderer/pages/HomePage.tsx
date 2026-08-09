import { useState, useEffect, useMemo } from "react";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../../../server/routers";
import { getElectronAPI } from "@/lib/electronApiShim";
import { useI18n } from "@/contexts/I18nContext";
import type { TranslationKey } from "../../../shared/i18n";

interface HomePageProps {
  onNavigate: (page: string) => void;
  onScanStarted: (scanId: string) => void;
  config: any;
}

interface Case {
  id: string;
  clientName: string;
  caseType: string;
  urgency: string;
  status: string;
  createdAt: string | Date | null;
}

export default function HomePage({ onNavigate, onScanStarted, config }: HomePageProps) {
  const { t } = useI18n();
  const electronAPI = getElectronAPI();
  const [cases, setCases] = useState<Case[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedCase, setSelectedCase] = useState<Case | null>(null);
  const [scanFolders, setScanFolders] = useState<string[]>([]);

  const apiClient = useMemo(() => {
    const base = config?.apiUrl?.replace(/\/$/, "");
    if (!base) return null;

    return createTRPCProxyClient<AppRouter>({
      transformer: superjson,
      links: [
        httpBatchLink({
          url: `${base}/api/trpc`,
          fetch(url, options) {
            return fetch(url, {
              ...options,
              credentials: "include",
            });
          },
        }),
      ],
    });
  }, [config?.apiUrl]);

  useEffect(() => {
    if (!apiClient) {
      setIsLoading(false);
      setCases([]);
      return;
    }

    let cancelled = false;
    const refreshCases = async (showLoading: boolean) => {
      if (showLoading) setIsLoading(true);
      try {
        const data = await apiClient.cases.list.query({ page: 1, limit: 100 });
        if (cancelled) return;
        setCases((data.cases ?? []) as unknown as Case[]);
        setError("");
      } catch (err: unknown) {
        console.error("Failed to load cases:", err);
        if (!cancelled) {
          const msg =
            err && typeof err === "object" && "message" in err
              ? String((err as { message: string }).message)
              : t("scanner.loadCasesError");
          setError(
            msg.includes("UNAUTHORIZED") || msg.includes("Not authenticated")
              ? t("scanner.signInDetail")
              : msg
          );
          setCases([]);
        }
      } finally {
        if (!cancelled && showLoading) setIsLoading(false);
      }
    };

    void refreshCases(true);
    const interval = window.setInterval(() => void refreshCases(false), 10_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [apiClient, t]);

  const loadCases = () => {
    if (!apiClient) return;
    setIsLoading(true);
    setError("");
    void apiClient.cases.list
      .query({ page: 1, limit: 100 })
      .then((data) => {
        setCases((data.cases ?? []) as unknown as Case[]);
      })
      .catch((err: unknown) => {
        console.error("Failed to load cases:", err);
        const msg =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: string }).message)
            : t("scanner.loadCasesError");
        setError(msg);
        setCases([]);
      })
      .finally(() => setIsLoading(false));
  };

  const handleAddScanFolder = async () => {
    const folders = await electronAPI.selectFolder();
    if (folders && Array.isArray(folders)) {
      const next = [...scanFolders];
      for (const folder of folders) {
        if (folder && !next.includes(folder)) next.push(folder);
      }
      setScanFolders(next);
    }
  };

  const handleRemoveScanFolder = (folder: string) => {
    setScanFolders(scanFolders.filter((value) => value !== folder));
  };

  const handleStartScan = async () => {
    if (!selectedCase) {
      alert(t("scanner.selectCaseFirst"));
      return;
    }
    if (!scanFolders.length) {
      alert(t("scanner.selectFolderFirst"));
      return;
    }

    try {
      const result = await electronAPI.startScan({
        caseId: selectedCase.id,
        caseName: `${selectedCase.clientName} - ${selectedCase.caseType}`,
        autoUpload: false,
        excludedFolders: [],
        folders: scanFolders,
      });
      onScanStarted(result.scanId);
    } catch (err: unknown) {
      console.error("Failed to start scan:", err);
      alert(t("scanner.startScanError", { message: err instanceof Error ? err.message : String(err) }));
    }
  };

  if (!config?.apiUrl) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-gray-600">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t("scanner.collection")}</h1>
          <p className="text-sm text-gray-600">{t("scanner.collectionHint")}</p>
        </div>
        <button
          type="button"
          onClick={() => onNavigate("settings")}
          className="rounded-lg px-4 py-2 text-gray-700 transition-colors hover:bg-gray-100"
        >
          {t("nav.settings")}
        </button>
      </header>

      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-4xl space-y-6">
          <div className="rounded-lg bg-white p-6 shadow">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-gray-900">{t("scanner.selectCase")}</h2>
              <button
                type="button"
                onClick={loadCases}
                className="text-sm font-medium text-blue-600 hover:text-blue-800"
              >
                {t("common.refresh")}
              </button>
            </div>

            {isLoading ? (
              <div className="py-8 text-center">
                <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600" />
                <p className="mt-2 text-gray-600">{t("scanner.loadingCases")}</p>
              </div>
            ) : error ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                <p className="text-red-600">{error}</p>
                <button
                  type="button"
                  onClick={loadCases}
                  className="mt-2 text-sm font-medium text-red-700 hover:text-red-800"
                >
                  {t("common.retry")}
                </button>
              </div>
            ) : cases.length === 0 ? (
              <div className="py-8 text-center text-gray-600">
                <p>{t("scanner.noCases")}</p>
                <p className="mt-2 text-sm">
                  {t("scanner.noCasesHint")}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {cases.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setSelectedCase(c)}
                    className={`w-full rounded-lg border-2 p-4 text-left transition-colors ${
                      selectedCase?.id === c.id
                        ? "border-blue-500 bg-blue-50"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-semibold text-gray-900">{c.clientName}</h3>
                        <p className="text-sm text-gray-600">{c.caseType}</p>
                      </div>
                      <div className="text-right">
                        <span
                          className={`inline-block rounded px-2 py-1 text-xs font-medium ${
                            c.urgency === "High"
                              ? "bg-red-100 text-red-700"
                              : c.urgency === "Medium"
                                ? "bg-yellow-100 text-yellow-700"
                                : "bg-green-100 text-green-700"
                          }`}
                        >
                          {t(`case.urgency.${c.urgency}` as TranslationKey)}
                        </span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg bg-white p-6 shadow">
            <h2 className="mb-1 text-lg font-semibold text-gray-900">{t("scanner.folders")}</h2>
            <p className="mb-4 text-sm text-gray-600">
              {t("scanner.folderSafety")}
            </p>
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-medium text-gray-900">{t("scanner.selectedFolders")}</h3>
                <button
                  type="button"
                  onClick={handleAddScanFolder}
                  className="rounded-lg bg-blue-600 px-3 py-1 text-sm text-white transition-colors hover:bg-blue-700"
                >
                  {t("scanner.chooseFolders")}
                </button>
              </div>

              {scanFolders.length === 0 ? (
                <p className="text-sm text-gray-600">
                  {t("scanner.noFolders")}
                </p>
              ) : (
                <div className="space-y-2">
                  {scanFolders.map((folder) => (
                    <div key={folder} className="flex items-center justify-between rounded bg-gray-50 p-2">
                      <span className="flex-1 truncate text-sm text-gray-700">{folder}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveScanFolder(folder)}
                        className="ml-2 text-red-600 hover:text-red-700"
                      >
                        {t("common.remove")}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={handleStartScan}
            disabled={!selectedCase || scanFolders.length === 0}
            className="w-full rounded-lg bg-blue-600 px-6 py-4 text-lg font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {!selectedCase
              ? t("scanner.selectCaseContinue")
              : scanFolders.length === 0
                ? t("scanner.chooseFolderContinue")
                : t("scanner.scanFolders")}
          </button>
        </div>
      </div>
    </div>
  );
}
