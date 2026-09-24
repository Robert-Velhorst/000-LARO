import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useLocation, useSearchParams } from "wouter";
import { useI18n } from "@/contexts/I18nContext";
import { PageHeading, QueryNotice, SectionNavigation } from "./WorkspaceUi";
import {
  AlertCircle,
  BrainCircuit,
  CheckCircle2,
  Copy,
  FileArchive,
  FolderSearch,
  HardDrive,
  History,
  Mail,
  KeyRound,
  Link2,
  Send,
  Shield,
  Trash2,
  XCircle,
} from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import EvidenceConnectionsCard from "@/components/EvidenceConnectionsCard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  HAI_FIELD_CATEGORIES,
  type HaiFieldCategory,
} from "../../../shared/haiGrant";
import type { TranslationKey } from "../../../shared/i18n";
import { EXTERNAL_DOCUMENT_SHARING_SCOPE } from "../../../shared/workflowConsent";
import { includeConnectedDesktopScanner } from "@/lib/scannerPrivacy";
import { readDefaultScannerFolders, writeDefaultScannerFolders } from "@/lib/scannerDefaultFolders";

type SettingsSection = "workflow" | "email" | "sources" | "hai" | "security";
type ExternalAnalysisProvider = "forge" | "openai" | "anthropic" | "google" | "deepseek" | "groq" | "together";

const NAV_ITEMS: Array<{
  id: SettingsSection;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  icon: typeof Mail;
}> = [
  { id: "workflow", labelKey: "settings.nav.workflow", descriptionKey: "settings.nav.workflowHint", icon: BrainCircuit },
  { id: "email", labelKey: "settings.nav.email", descriptionKey: "settings.nav.emailHint", icon: Mail },
  { id: "sources", labelKey: "settings.nav.sources", descriptionKey: "settings.nav.sourcesHint", icon: FolderSearch },
  { id: "hai", labelKey: "settings.nav.hai", descriptionKey: "settings.nav.haiHint", icon: Link2 },
  { id: "security", labelKey: "settings.nav.security", descriptionKey: "settings.nav.securityHint", icon: Shield },
];

const HAI_FIELD_LABEL_KEYS: Record<HaiFieldCategory, TranslationKey> = {
  case_overview: "settings.hai.field.caseOverview",
  analysis_summary: "settings.hai.field.analysisSummary",
  analysis_claims: "settings.hai.field.claims",
  analysis_obligations: "settings.hai.field.obligations",
  analysis_legal_issues: "settings.hai.field.legalIssues",
  analysis_timeline: "settings.hai.field.timeline",
};

const HAI_STATUS_KEYS: Record<string, TranslationKey> = {
  active: "settings.hai.status.active",
  expired: "settings.hai.status.expired",
  revoked: "settings.hai.status.revoked",
};

function downloadJsonFile(name: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function providerName(provider: string, consoleLabel: string) {
  if (provider === "sendgrid") return "SendGrid";
  if (provider === "smtp") return "SMTP";
  if (provider === "console") return consoleLabel;
  return provider;
}

export default function Settings() {
  const { user } = useAuth();
  const { t, formatDate, formatNumber } = useI18n();
  const [location, setLocation] = useLocation();
  const [params, setParams] = useSearchParams();
  const section = (NAV_ITEMS.some(item => item.id === params.get("section")) ? params.get("section") : ["/email-settings", "/email-preferences"].includes(location) ? "email" : "workflow") as SettingsSection;
  const setSection = (value: string) => setParams(previous => { const next = new URLSearchParams(previous); next.set("section", value); return next; });
  const [testEmail, setTestEmail] = useState("");
  const [isTesting, setIsTesting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isDownloadingActivity, setIsDownloadingActivity] = useState(false);
  const [scannerFolderState, setScannerFolderState] = useState<{ ownerId: string; paths: string[] }>({ ownerId: "", paths: [] });
  const scannerFolders = scannerFolderState.ownerId === user?.id ? scannerFolderState.paths : [];
  useEffect(() => {
    setScannerFolderState({ ownerId: user?.id ?? "", paths: readDefaultScannerFolders(user?.id) });
  }, [user?.id]);
  const [haiTokenName, setHaiTokenName] = useState(() => t("settings.hai.defaultName"));
  const [haiTokenDays, setHaiTokenDays] = useState("90");
  const [revealedHaiToken, setRevealedHaiToken] = useState<string | null>(null);
  const [haiSelectedCaseIds, setHaiSelectedCaseIds] = useState<string[]>([]);
  const [haiSelectedFields, setHaiSelectedFields] = useState<HaiFieldCategory[]>(["case_overview", "analysis_summary"]);
  const [haiIncludeFutureCases, setHaiIncludeFutureCases] = useState(false);
  const [haiIncludeFutureAnalyses, setHaiIncludeFutureAnalyses] = useState(false);
  const [haiGrantDialogOpen, setHaiGrantDialogOpen] = useState(false);
  const [haiEditingGrant, setHaiEditingGrant] = useState<{ tokenId: string; revision: number } | null>(null);
  const [acknowledgeHaiCases, setAcknowledgeHaiCases] = useState(false);
  const [acknowledgeHaiFields, setAcknowledgeHaiFields] = useState(false);
  const [acknowledgeHaiFutureRecords, setAcknowledgeHaiFutureRecords] = useState(false);
  const [consentDialogOpen, setConsentDialogOpen] = useState(false);
  const [acknowledgeFullDocumentContent, setAcknowledgeFullDocumentContent] = useState(false);
  const [acknowledgeAutomaticImports, setAcknowledgeAutomaticImports] = useState(false);
  const utils = trpc.useUtils();

  const providerQuery = trpc.email.getProviderInfo.useQuery(undefined, { enabled: section === "email" });
  const providerInfo = providerQuery.data;
  const workflowPreferences = trpc.userPreferences.workflow.useQuery();
  const analysisCapabilities = trpc.documentAnalysis.capabilities.useQuery();
  const updateWorkflowMutation = trpc.userPreferences.updateWorkflow.useMutation();
  const grantExternalDocumentSharingMutation = trpc.userPreferences.grantExternalDocumentSharing.useMutation();
  const revokeExternalDocumentSharingMutation = trpc.userPreferences.revokeExternalDocumentSharing.useMutation();
  const testEmailMutation = trpc.email.test.useMutation();
  const exportDataMutation = trpc.gdpr.exportData.useMutation();
  const auditLog = trpc.audit.list.useQuery(
    { limit: 200 },
    { enabled: section === "security" },
  );
  const legacyImports = trpc.legacyImports.listRuns.useQuery(undefined, {
    enabled: section === "security",
  });
  const haiConnection = trpc.haiIntegration.connectionInfo.useQuery(undefined, {
    enabled: section === "hai",
  });
  const haiTokens = trpc.haiIntegration.listTokens.useQuery(undefined, {
    enabled: section === "hai",
  });
  const haiEligibleCases = trpc.haiIntegration.listEligibleCases.useQuery(undefined, {
    enabled: section === "hai",
  });
  const createHaiTokenMutation = trpc.haiIntegration.createToken.useMutation();
  const updateHaiGrantMutation = trpc.haiIntegration.updateGrant.useMutation();
  const revokeHaiTokenMutation = trpc.haiIntegration.revokeToken.useMutation();

  const consentMutationPending = grantExternalDocumentSharingMutation.isPending || revokeExternalDocumentSharingMutation.isPending;
  const preferencesUnavailable = !workflowPreferences.data || updateWorkflowMutation.isPending || consentMutationPending;
  const haiFieldLabel = (field: HaiFieldCategory) => t(HAI_FIELD_LABEL_KEYS[field]);
  const haiStatusLabel = (status: string) => HAI_STATUS_KEYS[status] ? t(HAI_STATUS_KEYS[status]) : status;
  const navItems = NAV_ITEMS.map(item => ({
    ...item,
    label: t(item.labelKey),
    description: t(item.descriptionKey),
  }));

  useEffect(() => {
    if (user?.role === "admin" && user.email && !testEmail) setTestEmail(user.email);
  }, [testEmail, user?.email, user?.role]);

  const updateWorkflow = async (updates: Parameters<typeof updateWorkflowMutation.mutateAsync>[0]) => {
    try {
      const consentWasActive = workflowPreferences.data?.shareRawDocumentContent === true;
      const updated = await updateWorkflowMutation.mutateAsync(updates);
      await Promise.all([
        utils.userPreferences.workflow.invalidate(),
        utils.documentAnalysis.capabilities.invalidate(),
      ]);
      toast.success(consentWasActive && !updated.shareRawDocumentContent
        ? t("settings.workflow.preferenceSavedConsentRevoked")
        : t("settings.workflow.preferenceSaved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings.workflow.preferenceSaveFailed"));
    }
  };

  const refreshWorkflowConsent = async () => {
    await Promise.all([
      utils.userPreferences.workflow.invalidate(),
      utils.documentAnalysis.capabilities.invalidate(),
    ]);
  };

  const handleGrantExternalDocumentSharing = async () => {
    const provider = workflowPreferences.data?.analysisProvider;
    if (!provider || provider === "local" || provider === "ollama") return;
    try {
      await grantExternalDocumentSharingMutation.mutateAsync({
        provider: provider as ExternalAnalysisProvider,
        scope: EXTERNAL_DOCUMENT_SHARING_SCOPE,
        automaticImports: workflowPreferences.data!.autoAnalyzeImports,
        acknowledgeFullDocumentContent: true,
        acknowledgeAutomaticImports: true,
      });
      await refreshWorkflowConsent();
      setConsentDialogOpen(false);
      setAcknowledgeFullDocumentContent(false);
      setAcknowledgeAutomaticImports(false);
      toast.success(t("settings.workflow.consentAllowed", { provider }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings.workflow.consentSaveFailed"));
    }
  };

  const handleRevokeExternalDocumentSharing = async () => {
    const consentId = workflowPreferences.data?.externalDocumentSharingConsent?.id;
    if (!consentId) return;
    try {
      await revokeExternalDocumentSharingMutation.mutateAsync({ consentId });
      await refreshWorkflowConsent();
      toast.success(t("settings.workflow.consentRevoked"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings.workflow.consentRevokeFailed"));
    }
  };

  const openScanner = useCallback(async () => {
    try {
      const ownerId = user?.id;
      if (!ownerId) throw new Error(t("settings.sources.signInRequired"));
      if (!window.electronAPI?.selectFolder) {
        toast.message(t("settings.sources.desktopRequired"));
        return;
      }
      const result = await window.electronAPI.selectFolder();
      const picked = Array.isArray(result) ? result : result ? [String(result)] : [];
      if (picked.length === 0) return;
      const merged = Array.from(new Set([...readDefaultScannerFolders(ownerId), ...picked]));
      writeDefaultScannerFolders(ownerId, merged);
      setScannerFolderState({ ownerId, paths: merged });
      toast.success(picked.length === 1
        ? t("settings.sources.folderAdded")
        : t("settings.sources.foldersAdded", { count: formatNumber(picked.length) }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings.sources.folderPickerFailed"));
    }
  }, [formatNumber, t, user?.id]);

  const removeScannerFolder = (path: string) => {
    const ownerId = user?.id;
    if (!ownerId) return;
    const next = scannerFolders.filter((folder) => folder !== path);
    writeDefaultScannerFolders(ownerId, next);
    setScannerFolderState({ ownerId, paths: next });
  };

  const handleTestEmail = async () => {
    if (!testEmail.includes("@")) {
      toast.error(t("validation.email"));
      return;
    }
    setIsTesting(true);
    try {
      const result = await testEmailMutation.mutateAsync({
        to: testEmail,
      });
      result.success ? toast.success(result.message) : toast.error(result.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings.email.testFailed"));
    } finally {
      setIsTesting(false);
    }
  };

  const handleAccountExport = async () => {
    setIsExporting(true);
    try {
      const archive = await includeConnectedDesktopScanner(await exportDataMutation.mutateAsync());
      downloadJsonFile(`laro-account-archive-${new Date().toISOString().slice(0, 10)}.json`, archive);
      toast.success(t("settings.security.archiveDownloaded"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings.security.archiveFailed"));
    } finally {
      setIsExporting(false);
    }
  };

  const handleActivityExport = async () => {
    setIsDownloadingActivity(true);
    try {
      const result = await auditLog.refetch();
      if (result.error) throw result.error;
      downloadJsonFile(
        `laro-activity-history-${new Date().toISOString().slice(0, 10)}.json`,
        { generatedAt: new Date().toISOString(), entries: result.data ?? [] },
      );
      toast.success(t("settings.security.activityDownloaded"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings.security.activityFailed"));
    } finally {
      setIsDownloadingActivity(false);
    }
  };

  const copyValue = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("settings.copy.success", { label }));
    } catch {
      toast.error(t("settings.copy.failed", { label }));
    }
  };

  const toggleHaiCase = (caseId: string, checked: boolean) => {
    setHaiSelectedCaseIds((current) => checked
      ? [...new Set([...current, caseId])]
      : current.filter((id) => id !== caseId));
  };

  const toggleHaiField = (field: HaiFieldCategory, checked: boolean) => {
    setHaiSelectedFields((current) => checked
      ? [...new Set([...current, field])]
      : current.filter((item) => item !== field));
  };

  const openHaiGrantReview = () => {
    if (haiSelectedCaseIds.length < 1) {
      toast.error(t("settings.hai.selectCase"));
      return;
    }
    if (haiSelectedFields.length < 1) {
      toast.error(t("settings.hai.selectField"));
      return;
    }
    setAcknowledgeHaiCases(false);
    setAcknowledgeHaiFields(false);
    setAcknowledgeHaiFutureRecords(false);
    setHaiGrantDialogOpen(true);
  };

  const handleSaveHaiGrant = async () => {
    const grant = {
      caseIds: haiSelectedCaseIds,
      fieldCategories: haiSelectedFields,
      includeFutureCases: haiIncludeFutureCases,
      includeFutureAnalyses: haiIncludeFutureAnalyses,
      acknowledgeCaseScope: true as const,
      acknowledgeFieldScope: true as const,
      acknowledgeFutureRecords: true as const,
    };
    try {
      if (haiEditingGrant) {
        await updateHaiGrantMutation.mutateAsync({
          tokenId: haiEditingGrant.tokenId,
          expectedRevision: haiEditingGrant.revision,
          grant,
        });
        toast.success(t("settings.hai.scopeUpdated"));
      } else {
        const result = await createHaiTokenMutation.mutateAsync({
          name: haiTokenName.trim(),
          expiresInDays: Number(haiTokenDays),
          grant,
        });
        setRevealedHaiToken(result.token);
        toast.success(t("settings.hai.credentialCreated"));
      }
      await utils.haiIntegration.listTokens.invalidate();
      setHaiGrantDialogOpen(false);
      setHaiEditingGrant(null);
      setHaiSelectedCaseIds([]);
      setHaiSelectedFields(["case_overview", "analysis_summary"]);
      setHaiIncludeFutureCases(false);
      setHaiIncludeFutureAnalyses(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings.hai.saveFailed"));
    }
  };

  const handleEditHaiGrant = (credential: NonNullable<typeof haiTokens.data>[number]) => {
    if (!credential.grant) return;
    setHaiEditingGrant({ tokenId: credential.id, revision: credential.grant.revision });
    setHaiSelectedCaseIds([...credential.grant.caseIds]);
    setHaiSelectedFields([...credential.grant.fieldCategories]);
    setHaiIncludeFutureCases(credential.grant.includeFutureCases);
    setHaiIncludeFutureAnalyses(credential.grant.includeFutureAnalyses);
    setRevealedHaiToken(null);
  };

  const cancelHaiGrantEdit = () => {
    setHaiEditingGrant(null);
    setHaiSelectedCaseIds([]);
    setHaiSelectedFields(["case_overview", "analysis_summary"]);
    setHaiIncludeFutureCases(false);
    setHaiIncludeFutureAnalyses(false);
  };

  const handleRevokeHaiToken = async (tokenId: string) => {
    try {
      await revokeHaiTokenMutation.mutateAsync({ tokenId });
      await utils.haiIntegration.listTokens.invalidate();
      toast.success(t("settings.hai.credentialRevoked"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings.hai.revokeFailed"));
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeading title={t("settings.title")} />
        <SectionNavigation label={t("settings.sections")} items={navItems} value={section} onChange={setSection} />
        {section === "workflow" && workflowPreferences.error && <QueryNotice error={workflowPreferences.error} retry={workflowPreferences.refetch} />}
        {section === "workflow" && analysisCapabilities.error && <QueryNotice error={analysisCapabilities.error} retry={analysisCapabilities.refetch} />}
        {section === "email" && providerQuery.error && <QueryNotice error={providerQuery.error} retry={providerQuery.refetch} />}
        {section === "workflow" && <p role="status" className="text-xs text-muted-foreground">{updateWorkflowMutation.isPending ? t("settings.state.saving") : updateWorkflowMutation.isError ? t("settings.state.notSaved") : updateWorkflowMutation.isSuccess ? t("settings.state.saved") : ""}</p>}

        {section === "workflow" ? (
          <div className="space-y-4">
            <Card className="rounded-none border-0 border-t border-border bg-transparent shadow-none">
              <CardHeader className="px-0 py-5">
                <CardTitle>{t("settings.workflow.title")}</CardTitle>
                <CardDescription>{t("settings.workflow.description")}</CardDescription>
              </CardHeader>
              <CardContent className="px-0 space-y-5">
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="space-y-2 text-sm">
                    <span className="font-medium">{t("settings.workflow.provider")}</span>
                    <select
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={workflowPreferences.data?.analysisProvider ?? "local"}
                      disabled={preferencesUnavailable || !analysisCapabilities.data}
                      onChange={(event) => void updateWorkflow({ analysisProvider: event.target.value as "local" | "ollama" | "forge" | "openai" | "anthropic" | "google" | "deepseek" | "groq" | "together" })}
                    >
                      <option value="local">{t("settings.workflow.localProvider")}</option>
                      {(analysisCapabilities.data?.providers || []).map((provider) => (
                        <option key={provider.id} value={provider.id} disabled={!provider.configured}>
                          {provider.label} - {provider.model}{!provider.configured && <> {t("settings.workflow.notConfigured")}</>}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">{t("settings.workflow.providerHint")}</p>
                  </label>
                  <div className="flex items-center justify-between gap-4 border border-border/60 p-4">
                    <div>
                      <Label htmlFor="auto-analyze-imports">{t("settings.workflow.autoAnalyze")}</Label>
                      <p className="mt-1 text-xs text-muted-foreground">{t("settings.workflow.autoAnalyzeHint")}</p>
                    </div>
                    <Switch
                      id="auto-analyze-imports"
                      checked={workflowPreferences.data?.autoAnalyzeImports ?? true}
                      disabled={preferencesUnavailable}
                      onCheckedChange={(checked) => void updateWorkflow({ autoAnalyzeImports: checked })}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-4 border border-border/60 p-4">
                    <Label htmlFor="auto-organize-documents">{t("settings.workflow.autoOrganize")}</Label>
                    <Switch id="auto-organize-documents" checked={workflowPreferences.data?.autoOrganizeDocuments ?? true}
                      disabled={preferencesUnavailable}
                      onCheckedChange={(checked) => void updateWorkflow({ autoOrganizeDocuments: checked })} />
                  </div>
                </div>
                <div className="space-y-3 border-t border-border/60 pt-4">
                  <div>
                    <Label>{t("settings.workflow.externalTitle")}</Label>
                    <p className="mt-1 text-xs text-muted-foreground">{t("settings.workflow.externalHint")}</p>
                  </div>
                  {workflowPreferences.data?.analysisProvider === "local" || workflowPreferences.data?.analysisProvider === "ollama" ? (
                    <Alert>
                      <HardDrive className="h-4 w-4" />
                      <AlertDescription>{t("settings.workflow.localOnly")}</AlertDescription>
                    </Alert>
                  ) : workflowPreferences.data?.shareRawDocumentContent ? (
                    <div className="flex flex-col gap-3 border border-border/60 p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="space-y-1 text-sm">
                        <p className="font-medium">{t("settings.workflow.allowedFor", {
                          provider: analysisCapabilities.data?.providers.find((item) => item.id === workflowPreferences.data?.analysisProvider)?.label
                            || workflowPreferences.data?.analysisProvider
                            || t("settings.email.notConfigured"),
                        })}</p>
                        <p className="text-xs text-muted-foreground">
                          {t("settings.workflow.granted", {
                            date: workflowPreferences.data.externalDocumentSharingConsent?.grantedAt
                              ? formatDate(workflowPreferences.data.externalDocumentSharingConsent.grantedAt, { dateStyle: "medium", timeStyle: "short" })
                              : t("settings.workflow.now"),
                            automaticImports: workflowPreferences.data.externalDocumentSharingConsent?.automaticImports
                              ? t("settings.workflow.included")
                              : t("settings.workflow.notIncluded"),
                          })}
                        </p>
                      </div>
                      <Button type="button" variant="destructive" disabled={preferencesUnavailable} onClick={() => void handleRevokeExternalDocumentSharing()}>
                        {t("settings.workflow.revoke")}
                      </Button>
                    </div>
                  ) : (
                    <Alert>
                      <Shield className="h-4 w-4" />
                      <AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <span>{t("settings.workflow.noExternalSharing")}</span>
                        <Button type="button" variant="outline" disabled={preferencesUnavailable} onClick={() => setConsentDialogOpen(true)}>
                          {t("settings.workflow.reviewPermission")}
                        </Button>
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              </CardContent>
            </Card>

            <Dialog open={consentDialogOpen} onOpenChange={(open) => {
              setConsentDialogOpen(open);
              if (!open) {
                setAcknowledgeFullDocumentContent(false);
                setAcknowledgeAutomaticImports(false);
              }
            }}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t("settings.workflow.consentTitle")}</DialogTitle>
                  <DialogDescription>
                    {t("settings.workflow.consentDescription")}
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-1 border border-border/60 p-3 text-sm">
                    <p><span className="font-medium">{t("settings.email.provider")}:</span> {analysisCapabilities.data?.providers.find((item) => item.id === workflowPreferences.data?.analysisProvider)?.label || workflowPreferences.data?.analysisProvider}</p>
                    <p><span className="font-medium">{t("settings.workflow.scope")}</span> {t("settings.workflow.scopeDescription")}</p>
                    <p><span className="font-medium">{t("settings.workflow.automaticImports")}</span> {workflowPreferences.data?.autoAnalyzeImports ? t("settings.workflow.automaticImportsOn") : t("settings.workflow.automaticImportsOff")}</p>
                    <p className="text-xs text-muted-foreground">{t("settings.workflow.consentChangeHint")}</p>
                  </div>
                  <label className="flex items-start gap-3 text-sm" htmlFor="acknowledge-full-document-content">
                    <Checkbox id="acknowledge-full-document-content" checked={acknowledgeFullDocumentContent} onCheckedChange={(value) => setAcknowledgeFullDocumentContent(value === true)} />
                    <span>{t("settings.workflow.acknowledgeContent")}</span>
                  </label>
                  <label className="flex items-start gap-3 text-sm" htmlFor="acknowledge-automatic-imports">
                    <Checkbox id="acknowledge-automatic-imports" checked={acknowledgeAutomaticImports} onCheckedChange={(value) => setAcknowledgeAutomaticImports(value === true)} />
                    <span>{t("settings.workflow.acknowledgeImports")}</span>
                  </label>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setConsentDialogOpen(false)}>{t("common.cancel")}</Button>
                  <Button
                    type="button"
                    disabled={!acknowledgeFullDocumentContent || !acknowledgeAutomaticImports || consentMutationPending}
                    onClick={() => void handleGrantExternalDocumentSharing()}
                  >
                    {grantExternalDocumentSharingMutation.isPending ? t("settings.state.saving") : t("settings.workflow.grantPermission")}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Card className="rounded-none border-0 border-t border-border bg-transparent shadow-none">
              <CardHeader className="px-0 py-5">
                <CardTitle>{t("settings.workflow.reviewTitle")}</CardTitle>
                <CardDescription>{t("settings.workflow.reviewDescription")}</CardDescription>
              </CardHeader>
              <CardContent className="px-0 grid gap-5 md:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span className="font-medium">{t("settings.workflow.shortlistReview")}</span>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={workflowPreferences.data?.outreachReviewMode ?? "each"}
                    disabled={preferencesUnavailable}
                    onChange={(event) => void updateWorkflow({ outreachReviewMode: event.target.value as "each" | "batch" | "automatic" })}
                  >
                    <option value="each">{t("settings.workflow.reviewEach")}</option>
                    <option value="batch">{t("settings.workflow.reviewBatch")}</option>
                    <option value="automatic">{t("settings.workflow.reviewAutomatic")}</option>
                  </select>
                </label>
                <label className="space-y-2 text-sm">
                  <span className="font-medium">{t("settings.workflow.messageApproval")}</span>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={workflowPreferences.data?.messageApprovalMode ?? "each"}
                    disabled={preferencesUnavailable}
                    onChange={(event) => void updateWorkflow({ messageApprovalMode: event.target.value as "each" | "batch" | "automatic" })}
                  >
                    <option value="each">{t("settings.workflow.approveEach")}</option>
                    <option value="batch">{t("settings.workflow.approveBatch")}</option>
                    <option value="automatic">{t("settings.workflow.approveAutomatic")}</option>
                  </select>
                </label>
                <Alert className="md:col-span-2">
                  <Shield className="h-4 w-4" />
                  <AlertDescription>{t("settings.workflow.approvalSafety")}</AlertDescription>
                </Alert>
              </CardContent>
            </Card>
          </div>
        ) : null}

        {section === "email" ? (
          <Card className="rounded-none border-0 border-t border-border bg-transparent shadow-none">
            <CardHeader className="px-0 py-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle>{t("settings.email.title")}</CardTitle>
                  <CardDescription className="mt-2">{t("settings.email.description")}</CardDescription>
                </div>
                {providerInfo ? (
                  <Badge variant={providerInfo.configured ? "default" : "destructive"}>
                    {providerInfo.configured ? <CheckCircle2 className="mr-1 h-3 w-3" /> : <XCircle className="mr-1 h-3 w-3" />}
                    {providerInfo.configured ? t("settings.email.configured") : t("settings.email.notConfigured")}
                  </Badge>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="px-0 space-y-6">
              <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
                <div className="space-y-2">
                  <Label>{t("settings.email.provider")}</Label>
                  <p className="text-sm font-semibold">{providerInfo ? providerName(providerInfo.provider, t("settings.email.consoleProvider")) : t("common.loading")}</p>
                </div>
                <div className="space-y-2">
                  <Label>{t("settings.email.from")}</Label>
                  <p className="text-sm font-semibold">{providerInfo?.from || t("settings.email.notConfigured")}</p>
                </div>
                <div className="space-y-2">
                  <Label>{t("settings.email.status")}</Label>
                  <p className="text-sm font-semibold">{providerInfo?.configured ? t("settings.email.ready") : t("settings.email.configurationNeeded")}</p>
                </div>
              </div>

              {providerInfo && !providerInfo.configured && providerInfo.missingVars?.length ? (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{t("settings.email.missingVariables", { variables: providerInfo.missingVars.join(", ") })}</AlertDescription>
                </Alert>
              ) : null}

              {providerInfo?.provider === "console" ? (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{t("settings.email.developmentProvider")}</AlertDescription>
                </Alert>
              ) : null}

              {user?.role === "admin" ? <div className="space-y-3 border-t pt-4">
                <Label htmlFor="test-email">{t("settings.email.testRecipient")}</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    id="test-email"
                    type="email"
                    autoComplete="email"
                    placeholder="name@example.com"
                    value={testEmail}
                    onChange={(event) => setTestEmail(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && void handleTestEmail()}
                    className="max-w-md"
                  />
                  <Button onClick={() => void handleTestEmail()} disabled={isTesting || !testEmail}>
                    <Send className="mr-2 h-4 w-4" />
                    {isTesting ? t("settings.email.sending") : t("settings.email.sendTest")}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t("settings.email.testHint")}</p>
              </div> : <Alert>
                <Shield className="h-4 w-4" />
                <AlertDescription>{t("settings.email.adminOnly")}</AlertDescription>
              </Alert>}
            </CardContent>
          </Card>
        ) : null}

        {section === "sources" ? (
          <div className="space-y-4">
            <EvidenceConnectionsCard />
            <Card className="rounded-none border-0 border-t border-border bg-transparent shadow-none">
              <CardHeader className="px-0 py-5">
                <CardTitle>{t("settings.sources.localTitle")}</CardTitle>
                <CardDescription>{t("settings.sources.localDescription")}</CardDescription>
              </CardHeader>
              <CardContent className="px-0 space-y-3">
                <Button variant="outline" onClick={() => void openScanner()}>
                  <HardDrive className="mr-2 h-4 w-4" />
                  {t("settings.sources.addFolder")}
                </Button>
                {scannerFolders.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("settings.sources.noFolders")}</p>
                ) : (
                  <div className="space-y-2">
                    {scannerFolders.map((path) => (
                      <div key={path} className="flex items-center gap-2 border-b border-border/40 py-2">
                        <span className="min-w-0 flex-1 truncate text-sm" title={path}>{path}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("settings.sources.removePath", { path })}
                          title={t("settings.sources.removeFolder")}
                          onClick={() => removeScannerFolder(path)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ) : null}

        {section === "hai" ? (
          <div className="space-y-4">
            <Card className="rounded-none border-0 border-t border-border bg-transparent shadow-none">
              <CardHeader className="px-0 py-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2"><Link2 className="h-5 w-5" />{t("settings.hai.title")}</CardTitle>
                    <CardDescription className="mt-2">{t("settings.hai.description")}</CardDescription>
                  </div>
                  <Badge variant="outline">{t("settings.hai.readOnly")}</Badge>
                </div>
              </CardHeader>
              <CardContent className="px-0 space-y-5">
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="hai-base-url">{t("settings.hai.baseUrl")}</Label>
                    <div className="flex gap-2">
                      <Input id="hai-base-url" readOnly value={haiConnection.data?.baseUrl ?? t("common.loading")} className="font-mono text-xs" />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={t("settings.hai.copyBaseUrl")}
                        title={t("settings.hai.copyBaseUrl")}
                        disabled={!haiConnection.data?.baseUrl}
                        onClick={() => haiConnection.data?.baseUrl && void copyValue(haiConnection.data.baseUrl, t("settings.hai.baseUrl"))}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="hai-feed-url">{t("settings.hai.feedEndpoint")}</Label>
                    <div className="flex gap-2">
                      <Input id="hai-feed-url" readOnly value={haiConnection.data?.feedUrl ?? t("common.loading")} className="font-mono text-xs" />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={t("settings.hai.copyFeed")}
                        title={t("settings.hai.copyFeed")}
                        disabled={!haiConnection.data?.feedUrl}
                        onClick={() => haiConnection.data?.feedUrl && void copyValue(haiConnection.data.feedUrl, t("settings.hai.feedEndpoint"))}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>

                {revealedHaiToken ? (
                  <Alert>
                    <KeyRound className="h-4 w-4" />
                    <AlertDescription className="space-y-3">
                      <p>{t("settings.hai.shownOnce")}</p>
                      <div className="flex gap-2">
                        <Input aria-label={t("settings.hai.newCredential")} readOnly value={revealedHaiToken} className="font-mono text-xs" />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label={t("settings.hai.copyNewCredential")}
                          title={t("settings.hai.copyNewCredential")}
                          onClick={() => void copyValue(revealedHaiToken, t("settings.hai.newCredential"))}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setRevealedHaiToken(null)}>{t("settings.hai.hideCredential")}</Button>
                    </AlertDescription>
                  </Alert>
                ) : null}

                <div className="space-y-5 border-t border-border/50 pt-4">
                  <div>
                    <h3 className="text-sm font-semibold">{haiEditingGrant ? t("settings.hai.editAccess") : t("settings.hai.createAccess")}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">{t("settings.hai.accessHint")}</p>
                  </div>
                  {haiEditingGrant ? (
                    <Alert>
                      <Shield className="h-4 w-4" />
                      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                        <span>{t("settings.hai.editingHint")}</span>
                        <Button type="button" size="sm" variant="ghost" onClick={cancelHaiGrantEdit}>{t("settings.hai.cancelEdit")}</Button>
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_180px]">
                      <div className="space-y-2">
                        <Label htmlFor="hai-token-name">{t("settings.hai.credentialName")}</Label>
                        <Input id="hai-token-name" value={haiTokenName} maxLength={80} onChange={(event) => setHaiTokenName(event.target.value)} />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="hai-token-expiry">{t("settings.hai.expiresAfter")}</Label>
                        <select
                          id="hai-token-expiry"
                          value={haiTokenDays}
                          onChange={(event) => setHaiTokenDays(event.target.value)}
                          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <option value="30">{t("settings.hai.days", { count: 30 })}</option>
                          <option value="90">{t("settings.hai.days", { count: 90 })}</option>
                          <option value="180">{t("settings.hai.days", { count: 180 })}</option>
                          <option value="365">{t("settings.hai.days", { count: 365 })}</option>
                        </select>
                      </div>
                    </div>
                  )}

                  <fieldset className="space-y-3">
                    <legend className="text-sm font-medium">{t("settings.hai.casesNow")}</legend>
                    <p className="text-xs text-muted-foreground">{t("settings.hai.casesHint")}</p>
                    {haiEligibleCases.isLoading ? (
                      <p className="text-sm text-muted-foreground">{t("settings.hai.loadingCases")}</p>
                    ) : haiEligibleCases.error ? (
                      <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{t("settings.hai.casesLoadFailed")}</AlertDescription></Alert>
                    ) : (haiEligibleCases.data?.cases.length ?? 0) === 0 ? (
                      <p className="text-sm text-muted-foreground">{t("settings.hai.createCaseFirst")}</p>
                    ) : (
                      <div className="max-h-64 space-y-2 overflow-y-auto border border-border/60 p-3">
                        {haiEligibleCases.data?.cases.map((caseItem) => (
                          <label key={caseItem.id} htmlFor={`hai-case-${caseItem.id}`} className="flex items-start gap-3 text-sm">
                            <Checkbox
                              id={`hai-case-${caseItem.id}`}
                              checked={haiSelectedCaseIds.includes(caseItem.id)}
                              onCheckedChange={(value) => toggleHaiCase(caseItem.id, value === true)}
                            />
                            <span className="min-w-0">
                              <span className="block font-medium">{caseItem.caseType || t("settings.hai.untitledCase")}</span>
                              <span className="block break-all font-mono text-xs text-muted-foreground">{caseItem.id} · {caseItem.status || t("settings.hai.unknownStatus")}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                    {haiEligibleCases.data?.truncated ? (
                      <p className="text-xs text-destructive">{t("settings.hai.truncatedCases", { count: formatNumber(haiEligibleCases.data.maximumSelectable) })}</p>
                    ) : null}
                  </fieldset>

                  <fieldset className="space-y-3">
                    <legend className="text-sm font-medium">{t("settings.hai.fields")}</legend>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {HAI_FIELD_CATEGORIES.map((field) => (
                        <label key={field} htmlFor={`hai-field-${field}`} className="flex items-center gap-3 border border-border/60 p-3 text-sm">
                          <Checkbox
                            id={`hai-field-${field}`}
                            checked={haiSelectedFields.includes(field)}
                            onCheckedChange={(value) => toggleHaiField(field, value === true)}
                          />
                          <span>{haiFieldLabel(field)}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>

                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="flex items-center justify-between gap-4 border border-border/60 p-4">
                      <div>
                        <Label htmlFor="hai-future-cases">{t("settings.hai.futureCases")}</Label>
                        <p className="mt-1 text-xs text-muted-foreground">{t("settings.hai.futureCasesHint")}</p>
                      </div>
                      <Switch id="hai-future-cases" checked={haiIncludeFutureCases} onCheckedChange={setHaiIncludeFutureCases} />
                    </div>
                    <div className="flex items-center justify-between gap-4 border border-border/60 p-4">
                      <div>
                        <Label htmlFor="hai-future-analyses">{t("settings.hai.futureAnalyses")}</Label>
                        <p className="mt-1 text-xs text-muted-foreground">{t("settings.hai.futureAnalysesHint")}</p>
                      </div>
                      <Switch id="hai-future-analyses" checked={haiIncludeFutureAnalyses} onCheckedChange={setHaiIncludeFutureAnalyses} />
                    </div>
                  </div>

                  <Button
                    type="button"
                    disabled={
                      createHaiTokenMutation.isPending || updateHaiGrantMutation.isPending ||
                      (!haiEditingGrant && haiTokenName.trim().length < 2) ||
                      haiSelectedCaseIds.length < 1 || haiSelectedFields.length < 1
                    }
                    onClick={openHaiGrantReview}
                  >
                    <KeyRound className="mr-2 h-4 w-4" />
                    {haiEditingGrant ? t("settings.hai.reviewUpdate") : t("settings.hai.reviewCreate")}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Dialog open={haiGrantDialogOpen} onOpenChange={(open) => {
              setHaiGrantDialogOpen(open);
              if (!open) {
                setAcknowledgeHaiCases(false);
                setAcknowledgeHaiFields(false);
                setAcknowledgeHaiFutureRecords(false);
              }
            }}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{haiEditingGrant ? t("settings.hai.confirmUpdate") : t("settings.hai.confirmCreate")}</DialogTitle>
                  <DialogDescription>{t("settings.hai.confirmDescription")}</DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-1 border border-border/60 p-3 text-sm">
                    <p><span className="font-medium">{t("settings.hai.currentCases")}</span> {t("settings.hai.explicitlySelected", { count: formatNumber(haiSelectedCaseIds.length) })}</p>
                    <p><span className="font-medium">{t("settings.hai.fieldsLabel")}</span> {haiSelectedFields.map(haiFieldLabel).join(", ")}</p>
                    <p><span className="font-medium">{t("settings.hai.futureCasesLabel")}</span> {haiIncludeFutureCases ? t("settings.hai.includedAutomatically") : t("settings.hai.excluded")}</p>
                    <p><span className="font-medium">{t("settings.hai.futureAnalysesLabel")}</span> {haiIncludeFutureAnalyses ? t("settings.hai.includedForCases") : t("settings.hai.excluded")}</p>
                    <p className="text-xs text-muted-foreground">{t("settings.hai.existingExcluded")}</p>
                  </div>
                  <label className="flex items-start gap-3 text-sm" htmlFor="acknowledge-hai-cases">
                    <Checkbox id="acknowledge-hai-cases" checked={acknowledgeHaiCases} onCheckedChange={(value) => setAcknowledgeHaiCases(value === true)} />
                    <span>{t(haiSelectedCaseIds.length === 1 ? "settings.hai.acknowledgeCaseOne" : "settings.hai.acknowledgeCaseMany", { count: formatNumber(haiSelectedCaseIds.length) })}</span>
                  </label>
                  <label className="flex items-start gap-3 text-sm" htmlFor="acknowledge-hai-fields">
                    <Checkbox id="acknowledge-hai-fields" checked={acknowledgeHaiFields} onCheckedChange={(value) => setAcknowledgeHaiFields(value === true)} />
                    <span>{t("settings.hai.acknowledgeFields")}</span>
                  </label>
                  <label className="flex items-start gap-3 text-sm" htmlFor="acknowledge-hai-future">
                    <Checkbox id="acknowledge-hai-future" checked={acknowledgeHaiFutureRecords} onCheckedChange={(value) => setAcknowledgeHaiFutureRecords(value === true)} />
                    <span>{t("settings.hai.acknowledgeFuture")}</span>
                  </label>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setHaiGrantDialogOpen(false)}>{t("common.cancel")}</Button>
                  <Button
                    type="button"
                    disabled={
                      !acknowledgeHaiCases || !acknowledgeHaiFields || !acknowledgeHaiFutureRecords ||
                      createHaiTokenMutation.isPending || updateHaiGrantMutation.isPending
                    }
                    onClick={() => void handleSaveHaiGrant()}
                  >
                    {createHaiTokenMutation.isPending || updateHaiGrantMutation.isPending
                      ? t("settings.state.saving")
                      : haiEditingGrant ? t("settings.hai.updateScope") : t("settings.hai.createCredential")}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Card className="rounded-none border-0 border-t border-border bg-transparent shadow-none">
              <CardHeader className="px-0 py-5">
                <CardTitle>{t("settings.hai.credentialsTitle")}</CardTitle>
                <CardDescription>{t("settings.hai.credentialsDescription")}</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                {haiTokens.isLoading ? (
                  <p className="text-sm text-muted-foreground">{t("settings.hai.loadingCredentials")}</p>
                ) : haiTokens.error ? (
                  <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{t("settings.hai.credentialsLoadFailed")}</AlertDescription></Alert>
                ) : (haiTokens.data?.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("settings.hai.noCredentials")}</p>
                ) : (
                  <div className="divide-y divide-border/50 border-y border-border/50">
                    {haiTokens.data?.map((credential) => (
                      <article key={credential.id} aria-label={t("settings.hai.credentialLabel", { name: credential.name })} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{credential.name}</p>
                          <p className="font-mono text-xs text-muted-foreground">{credential.tokenPrefix}...</p>
                          <p className="text-xs text-muted-foreground">
                            {t("settings.hai.expires", { date: formatDate(credential.expiresAt, { dateStyle: "medium" }) })}
                            {" · "}{credential.lastUsedAt
                              ? t("settings.hai.lastUsed", { date: formatDate(credential.lastUsedAt, { dateStyle: "medium", timeStyle: "short" }) })
                              : t("settings.hai.notUsed")}
                          </p>
                          {credential.grant ? (
                            <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                              <p>{t(credential.grant.caseCount === 1 ? "settings.hai.selectedCaseOne" : "settings.hai.selectedCaseMany", { count: formatNumber(credential.grant.caseCount) })} · {credential.grant.fieldCategories.map(haiFieldLabel).join(", ")}</p>
                              <p>
                                {t("settings.hai.futureCasesLabel")} {credential.grant.includeFutureCases ? t("settings.hai.futureIncluded") : t("settings.hai.futureExcluded")}
                                {" · "}{t("settings.hai.futureAnalysesLabel")} {credential.grant.includeFutureAnalyses ? t("settings.hai.futureIncluded") : t("settings.hai.futureExcluded")}
                              </p>
                              <p>{t("settings.hai.reviewedRevision", {
                                date: formatDate(credential.grant.reviewedAt, { dateStyle: "medium", timeStyle: "short" }),
                                revision: credential.grant.revision,
                              })}</p>
                            </div>
                          ) : (
                            <p className="mt-2 text-xs text-destructive">{t("settings.hai.noReviewedGrant")}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 sm:justify-end">
                          <Badge variant={credential.status === "active" ? "default" : "outline"}>{haiStatusLabel(credential.status)}</Badge>
                          {credential.status === "active" ? (
                            <>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={!credential.grant || updateHaiGrantMutation.isPending}
                                onClick={() => handleEditHaiGrant(credential)}
                              >
                                {t("settings.hai.editScope")}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={revokeHaiTokenMutation.isPending}
                                onClick={() => void handleRevokeHaiToken(credential.id)}
                              >
                                {t("settings.hai.revoke")}
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ) : null}

        {section === "security" ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4 lg:col-span-2">
              <h2 className="text-base font-semibold">{t("settings.security.title")}</h2>
              <Button variant="outline" onClick={() => setLocation("/privacy")}><Shield className="h-4 w-4" />{t("settings.security.privacySettings")}</Button>
            </div>
            <Card className="rounded-none border-0 border-t border-border bg-transparent shadow-none">
              <CardHeader className="px-0 py-5">
                <CardTitle className="flex items-center gap-2"><FileArchive className="h-5 w-5" />{t("settings.security.archiveTitle")}</CardTitle>
                <CardDescription>{t("settings.security.archiveDescription")}</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                <Button variant="outline" onClick={() => void handleAccountExport()} disabled={isExporting}>
                  <FileArchive className="mr-2 h-4 w-4" />
                  {isExporting ? t("settings.security.exporting") : t("settings.security.downloadArchive")}
                </Button>
              </CardContent>
            </Card>
            <Card className="rounded-none border-0 border-t border-border bg-transparent shadow-none">
              <CardHeader className="px-0 py-5">
                <CardTitle className="flex items-center gap-2"><History className="h-5 w-5" />{t("settings.security.activityTitle")}</CardTitle>
                <CardDescription>{t("settings.security.activityDescription")}</CardDescription>
              </CardHeader>
              <CardContent className="px-0 space-y-3">
                {auditLog.error && <QueryNotice error={auditLog.error} retry={auditLog.refetch} />}
                <p className="text-sm text-muted-foreground">
                  {auditLog.isLoading ? t("common.loading") : auditLog.data ? t("settings.security.entriesAvailable", { count: formatNumber(auditLog.data.length) }) : ""}
                </p>
                <Button variant="outline" onClick={() => void handleActivityExport()} disabled={isDownloadingActivity}>
                  <History className="mr-2 h-4 w-4" />
                  {isDownloadingActivity ? t("settings.security.preparing") : t("settings.security.downloadActivity")}
                </Button>
              </CardContent>
            </Card>
            <Card className="rounded-none border-0 border-t border-border bg-transparent shadow-none lg:col-span-2">
              <CardHeader className="px-0 py-5">
                <CardTitle className="flex items-center gap-2"><HardDrive className="h-5 w-5" />{t("settings.security.legacyTitle")}</CardTitle>
                <CardDescription>{t("settings.security.legacyDescription")}</CardDescription>
              </CardHeader>
              <CardContent className="px-0 space-y-3">
                {legacyImports.isLoading ? (
                  <p className="text-sm text-muted-foreground">{t("settings.security.loadingMigrations")}</p>
                ) : legacyImports.error ? (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{t("settings.security.migrationsLoadFailed")}</AlertDescription>
                  </Alert>
                ) : (legacyImports.data?.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("settings.security.noMigrations")}</p>
                ) : (
                  <div className="divide-y divide-border/50 border-y border-border/50">
                    {legacyImports.data?.map((run) => (
                      <div key={run.id} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{run.sourceInstanceId}</p>
                          <p className="text-xs text-muted-foreground">
                            {t("settings.security.migrationSummary", {
                              cases: formatNumber(run.casesImported),
                              records: formatNumber(run.recordsImported),
                              files: formatNumber(run.filesCopied),
                            })}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                          <Badge variant={run.missingFiles > 0 ? "destructive" : "outline"}>
                            {run.missingFiles > 0
                              ? t("settings.security.unavailableFiles", { count: formatNumber(run.missingFiles) })
                              : t("settings.security.filesVerified")}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {run.completedAt ? formatDate(run.completedAt, { dateStyle: "medium", timeStyle: "short" }) : run.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">{t("settings.security.archivedIncluded")}</p>
              </CardContent>
            </Card>
          </div>
        ) : null}
      </div>
    </DashboardLayout>
  );
}
