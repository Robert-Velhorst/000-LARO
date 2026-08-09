import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowLeft, CheckCircle2, FileText, FolderSearch, Pause, Play, Square, Upload } from "lucide-react";
import { toast } from "sonner";
import { getElectronAPI } from "@/lib/electronApiShim";
import type { FileItem, ScanProgress } from "../../../shared/types";
import { useI18n } from "@/contexts/I18nContext";
import type { TranslationKey } from "../../../shared/i18n";

interface Props {
  activeScanId: string | null;
  onNavigate: (page: string) => void;
}

type Phase = "scanning" | "paused" | "review" | "uploading" | "completed" | "failed" | "cancelled";

export default function ScanPage({ activeScanId, onNavigate }: Props) {
  const { t } = useI18n();
  const electronAPI = getElectronAPI();
  const [phase, setPhase] = useState<Phase>(activeScanId ? "scanning" : "review");
  const [progress, setProgress] = useState<Partial<ScanProgress>>({ scanId: activeScanId ?? "" });
  const [files, setFiles] = useState<FileItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const loadFiles = async () => {
    if (!activeScanId) return;
    const result = await electronAPI.getScanFiles(activeScanId);
    const next = (result.files ?? []) as FileItem[];
    setFiles(next);
    setSelectedIds(new Set(next.filter((file) => file.uploadStatus === "pending").map((file) => file.id)));
  };

  useEffect(() => {
    electronAPI.clearScanProgressListeners();
    electronAPI.clearUploadProgressListeners();

    electronAPI.onScanProgress((next: Partial<ScanProgress>) => {
      if (!activeScanId || next.scanId !== activeScanId) return;
      setProgress((current) => ({ ...current, ...next }));
      if (next.status === "review") {
        setPhase("review");
        void loadFiles();
      } else if (next.status === "cancelled") {
        setPhase("cancelled");
      } else if (next.status === "failed" || next.status === "error") {
        setPhase("failed");
      }
    });

    electronAPI.onUploadProgress((next: { scanId?: string; done?: boolean; failedFiles?: number; fileId?: string; failed?: boolean; errorMessage?: string }) => {
      if (!activeScanId || next.scanId !== activeScanId) return;
      setProgress((current) => ({ ...current, ...next }));
      if (next.fileId) {
        setFiles((current) => current.map((file) => file.id === next.fileId
          ? { ...file, uploadStatus: next.failed ? "failed" : "completed", uploadProgress: next.failed ? 0 : 100, errorMessage: next.errorMessage }
          : file));
      }
      if (next.done) {
        setPhase(next.failedFiles ? "failed" : "completed");
        setBusy(false);
        void loadFiles();
      }
    });

    return () => {
      electronAPI.clearScanProgressListeners();
      electronAPI.clearUploadProgressListeners();
    };
  }, [activeScanId]);

  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + Number(file.size || 0), 0), [files]);
  const selectedBytes = useMemo(
    () => files.filter((file) => selectedIds.has(file.id)).reduce((sum, file) => sum + Number(file.size || 0), 0),
    [files, selectedIds]
  );

  const toggleFile = (fileId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  };

  const startUpload = async () => {
    if (!activeScanId || selectedIds.size === 0) return;
    setBusy(true);
    try {
      await electronAPI.setScanFileSelection(activeScanId, [...selectedIds]);
      setFiles((current) => current.map((file) => ({
        ...file,
        uploadStatus: selectedIds.has(file.id) ? "pending" : "excluded",
      })));
      await electronAPI.startUpload(activeScanId);
      setPhase("uploading");
    } catch (error) {
      setBusy(false);
      toast.error(error instanceof Error ? error.message : t("scanner.uploadStartError"));
    }
  };

  const pause = async () => {
    await electronAPI.pauseScan();
    setPhase("paused");
  };

  const resume = async () => {
    await electronAPI.resumeScan();
    setPhase("scanning");
  };

  const cancel = async () => {
    await electronAPI.stopScan();
    setPhase("cancelled");
  };

  if (!activeScanId) {
    return <EmptyScan onBack={() => onNavigate("home")} />;
  }

  const scanning = phase === "scanning" || phase === "paused";
  const uploadableFiles = files.filter((file) => file.uploadStatus !== "excluded");
  const uploadPercent = uploadableFiles.length
    ? Math.round((uploadableFiles.filter((file) => file.uploadStatus === "completed").length / uploadableFiles.length) * 100)
    : 0;

  return (
    <main className="flex min-h-screen flex-col bg-slate-950 text-white">
      <header className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
        <button type="button" onClick={() => onNavigate("home")} className="flex items-center gap-2 text-sm text-slate-300 hover:text-white">
          <ArrowLeft className="h-4 w-4" /> {t("scanner.newScan")}
        </button>
        <StatusBadge phase={phase} />
        <button type="button" onClick={() => window.close()} className="text-sm text-slate-400 hover:text-white">{t("common.close")}</button>
      </header>

      <div className="mx-auto w-full max-w-5xl flex-1 space-y-5 overflow-auto p-5">
        <section className="border border-slate-800 bg-slate-900 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-lg font-semibold">{t("scanner.folderScan")}</h1>
              <p className="mt-1 text-sm text-slate-400">
                {scanning
                  ? t("scanner.filesFoundProgress", { count: progress.scannedFiles ?? progress.totalFiles ?? 0 })
                  : t("scanner.filesFound", { count: files.length, size: formatBytes(totalBytes) })}
              </p>
            </div>
            {scanning ? (
              <div className="flex gap-2">
                {phase === "paused" ? (
                  <IconButton label={t("scanner.resume")} onClick={resume}><Play className="h-4 w-4" /></IconButton>
                ) : (
                  <IconButton label={t("scanner.pause")} onClick={pause}><Pause className="h-4 w-4" /></IconButton>
                )}
                <IconButton label={t("scanner.cancel")} onClick={cancel}><Square className="h-4 w-4" /></IconButton>
              </div>
            ) : null}
          </div>
          {(scanning || phase === "uploading") && (
            <div className="mt-4 h-2 overflow-hidden bg-slate-800">
              <div className={`h-full bg-blue-500 ${scanning ? "w-1/3 animate-pulse" : ""}`} style={scanning ? undefined : { width: `${uploadPercent}%` }} />
            </div>
          )}
          {progress.currentFile && scanning ? <p className="mt-2 truncate text-xs text-slate-500">{progress.currentFile}</p> : null}
          {progress.errorMessage ? <p className="mt-3 text-sm text-red-400">{progress.errorMessage}</p> : null}
        </section>

        {(phase === "review" || phase === "uploading" || phase === "completed" || phase === "failed") && (
          <section className="border border-slate-800 bg-slate-900">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
              <div>
                <h2 className="font-medium">{t("scanner.review")}</h2>
                <p className="mt-1 text-xs text-slate-400">{t("scanner.selected", { count: selectedIds.size, size: formatBytes(selectedBytes) })}</p>
              </div>
              {phase === "review" ? (
                <div className="flex gap-2">
                  <button type="button" onClick={() => setSelectedIds(new Set(files.map((file) => file.id)))} className="border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800">{t("scanner.selectAll")}</button>
                  <button type="button" onClick={() => setSelectedIds(new Set())} className="border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800">{t("scanner.clear")}</button>
                  <button type="button" disabled={busy || selectedIds.size === 0} onClick={startUpload} className="flex items-center gap-2 bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
                    <Upload className="h-4 w-4" /> {t("scanner.uploadSelected")}
                  </button>
                </div>
              ) : null}
            </div>

            {files.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-400">{t("scanner.noSupportedFiles")}</div>
            ) : (
              <div className="max-h-[52vh] divide-y divide-slate-800 overflow-auto">
                {files.map((file) => (
                  <label key={file.id} className="flex cursor-pointer items-center gap-3 px-5 py-3 hover:bg-slate-800/60">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(file.id)}
                      disabled={phase !== "review"}
                      onChange={() => toggleFile(file.id)}
                      className="h-4 w-4 accent-blue-500"
                    />
                    <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-slate-200">{file.name}</p>
                      <p className="truncate text-xs text-slate-500">{file.path}</p>
                    </div>
                    <span className="text-xs text-slate-500">{formatBytes(file.size)}</span>
                    <FileState state={file.uploadStatus} />
                  </label>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

function EmptyScan({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-white">
      <section className="max-w-md border border-slate-800 bg-slate-900 p-6 text-center">
        <FolderSearch className="mx-auto h-8 w-8 text-slate-400" />
        <h1 className="mt-4 text-lg font-semibold">{t("scanner.noActive")}</h1>
        <p className="mt-2 text-sm text-slate-400">{t("scanner.noActiveHint")}</p>
        <button type="button" onClick={onBack} className="mt-5 bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700">{t("scanner.configure")}</button>
      </section>
    </main>
  );
}

function StatusBadge({ phase }: { phase: Phase }) {
  const { t } = useI18n();
  const tone = phase === "completed" ? "text-emerald-300" : phase === "failed" || phase === "cancelled" ? "text-red-300" : "text-blue-300";
  return <span className={`text-xs font-semibold uppercase ${tone}`}>{t(`scanner.status.${phase}` as TranslationKey)}</span>;
}

function FileState({ state }: { state: FileItem["uploadStatus"] }) {
  if (state === "completed") return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
  if (state === "failed") return <AlertCircle className="h-4 w-4 text-red-400" />;
  return null;
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" title={label} aria-label={label} onClick={onClick} className="border border-slate-700 p-2 hover:bg-slate-800">{children}</button>;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
