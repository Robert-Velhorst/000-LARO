import { useCallback, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";

type SettingsSection = "workflow" | "email" | "sources" | "hai" | "security";

const NAV_ITEMS: Array<{
  id: SettingsSection;
  label: string;
  description: string;
  icon: typeof Mail;
}> = [
  { id: "workflow", label: "Workflow", description: "Analysis and approval controls", icon: BrainCircuit },
  { id: "email", label: "Email", description: "Provider and test send", icon: Mail },
  { id: "sources", label: "Evidence sources", description: "Google and local folders", icon: FolderSearch },
  { id: "hai", label: "HAI", description: "Read-only case intelligence connector", icon: Link2 },
  { id: "security", label: "Security", description: "Account data and activity", icon: Shield },
];

const LARO_FOLDERS_KEY = "laroDefaultLocalScanFolders";

function readDefaultFolders(): string[] {
  try {
    const raw = localStorage.getItem(LARO_FOLDERS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function writeDefaultFolders(paths: string[]) {
  localStorage.setItem(LARO_FOLDERS_KEY, JSON.stringify(paths));
  window.dispatchEvent(new CustomEvent("laro:default-folders-changed"));
}

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

function providerName(provider: string) {
  if (provider === "sendgrid") return "SendGrid";
  if (provider === "smtp") return "SMTP";
  if (provider === "console") return "Console (development)";
  return provider;
}

export default function Settings() {
  const { locale } = useI18n();
  const nl = locale === "nl";
  const [location, setLocation] = useLocation();
  const [params, setParams] = useSearchParams();
  const section = (NAV_ITEMS.some(item => item.id === params.get("section")) ? params.get("section") : ["/email-settings", "/email-preferences"].includes(location) ? "email" : "workflow") as SettingsSection;
  const setSection = (value: string) => setParams(previous => { const next = new URLSearchParams(previous); next.set("section", value); return next; });
  const [testEmail, setTestEmail] = useState("");
  const [isTesting, setIsTesting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isDownloadingActivity, setIsDownloadingActivity] = useState(false);
  const [scannerFolders, setScannerFolders] = useState<string[]>(readDefaultFolders);
  const [haiTokenName, setHaiTokenName] = useState("HAI connected source");
  const [haiTokenDays, setHaiTokenDays] = useState("90");
  const [revealedHaiToken, setRevealedHaiToken] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const providerQuery = trpc.email.getProviderInfo.useQuery(undefined, { enabled: section === "email" });
  const providerInfo = providerQuery.data;
  const workflowPreferences = trpc.userPreferences.workflow.useQuery();
  const analysisCapabilities = trpc.documentAnalysis.capabilities.useQuery();
  const updateWorkflowMutation = trpc.userPreferences.updateWorkflow.useMutation();
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
  const createHaiTokenMutation = trpc.haiIntegration.createToken.useMutation();
  const revokeHaiTokenMutation = trpc.haiIntegration.revokeToken.useMutation();

  const preferencesUnavailable = !workflowPreferences.data || updateWorkflowMutation.isPending;
  const navItems = NAV_ITEMS.map(item => ({ ...item, label: nl ? ({ workflow: "Analyse en controle", email: "E-mail", sources: "Bronnen", hai: "HAI-koppeling", security: "Gegevens en privacy" }[item.id]) : item.label }));

  const updateWorkflow = async (updates: Parameters<typeof updateWorkflowMutation.mutateAsync>[0]) => {
    try {
      await updateWorkflowMutation.mutateAsync(updates);
      await Promise.all([
        utils.userPreferences.workflow.invalidate(),
        utils.documentAnalysis.capabilities.invalidate(),
      ]);
      toast.success("Workflow preference saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Workflow preference could not be saved");
    }
  };

  const openScanner = useCallback(async () => {
    try {
      if (!window.electronAPI?.selectFolder) {
        toast.message("Folder picker requires LARO Desktop");
        return;
      }
      const result = await window.electronAPI.selectFolder();
      const picked = Array.isArray(result) ? result : result ? [String(result)] : [];
      if (picked.length === 0) return;
      const merged = Array.from(new Set([...readDefaultFolders(), ...picked]));
      writeDefaultFolders(merged);
      setScannerFolders(merged);
      toast.success(picked.length === 1 ? "Folder added" : `${picked.length} folders added`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open the folder picker");
    }
  }, []);

  const removeScannerFolder = (path: string) => {
    const next = scannerFolders.filter((folder) => folder !== path);
    writeDefaultFolders(next);
    setScannerFolders(next);
  };

  const handleTestEmail = async () => {
    if (!testEmail.includes("@")) {
      toast.error("Enter a valid email address");
      return;
    }
    setIsTesting(true);
    try {
      const result = await testEmailMutation.mutateAsync({
        to: testEmail,
        subject: "LARO Email Service Test",
      });
      result.success ? toast.success(result.message) : toast.error(result.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Test email failed");
    } finally {
      setIsTesting(false);
    }
  };

  const handleAccountExport = async () => {
    setIsExporting(true);
    try {
      const archive = await exportDataMutation.mutateAsync();
      downloadJsonFile(`laro-account-archive-${new Date().toISOString().slice(0, 10)}.json`, archive);
      toast.success("Account archive downloaded");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Account export failed");
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
      toast.success("Activity history downloaded");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Activity export failed");
    } finally {
      setIsDownloadingActivity(false);
    }
  };

  const copyValue = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error(`${label} could not be copied`);
    }
  };

  const handleCreateHaiToken = async () => {
    try {
      const result = await createHaiTokenMutation.mutateAsync({
        name: haiTokenName.trim(),
        expiresInDays: Number(haiTokenDays),
      });
      setRevealedHaiToken(result.token);
      await utils.haiIntegration.listTokens.invalidate();
      toast.success("HAI credential created");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "HAI credential could not be created");
    }
  };

  const handleRevokeHaiToken = async (tokenId: string) => {
    try {
      await revokeHaiTokenMutation.mutateAsync({ tokenId });
      await utils.haiIntegration.listTokens.invalidate();
      toast.success("HAI credential revoked");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "HAI credential could not be revoked");
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeading title={nl ? "Instellingen" : "Settings"} />
        <SectionNavigation label={nl ? "Instellingengroepen" : "Settings sections"} items={navItems} value={section} onChange={setSection} />
        {section === "workflow" && workflowPreferences.error && <QueryNotice error={workflowPreferences.error} retry={workflowPreferences.refetch} />}
        {section === "workflow" && analysisCapabilities.error && <QueryNotice error={analysisCapabilities.error} retry={analysisCapabilities.refetch} />}
        {section === "email" && providerQuery.error && <QueryNotice error={providerQuery.error} retry={providerQuery.refetch} />}
        {section === "workflow" && <p role="status" className="text-xs text-muted-foreground">{updateWorkflowMutation.isPending ? (nl ? "Opslaan..." : "Saving...") : updateWorkflowMutation.isError ? (nl ? "Wijziging niet opgeslagen" : "Change not saved") : updateWorkflowMutation.isSuccess ? (nl ? "Wijziging opgeslagen" : "Change saved") : ""}</p>}

        {section === "workflow" ? (
          <div className="space-y-4">
            <Card className="rounded-none border-0 border-t border-border bg-transparent shadow-none">
              <CardHeader className="px-0 py-5">
                <CardTitle>Document analysis</CardTitle>
                <CardDescription>Choose how LARO analyzes new and existing evidence</CardDescription>
              </CardHeader>
              <CardContent className="px-0 space-y-5">
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="space-y-2 text-sm">
                    <span className="font-medium">Analysis provider</span>
                    <select
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={workflowPreferences.data?.analysisProvider ?? "local"}
                      disabled={preferencesUnavailable || !analysisCapabilities.data}
                      onChange={(event) => void updateWorkflow({ analysisProvider: event.target.value as "local" | "ollama" | "forge" | "openai" | "anthropic" | "google" | "deepseek" | "groq" | "together" })}
                    >
                      <option value="local">Local source extraction - no AI model</option>
                      {(analysisCapabilities.data?.providers || []).map((provider) => (
                        <option key={provider.id} value={provider.id} disabled={!provider.configured}>
                          {provider.label} - {provider.model}{provider.configured ? "" : " (not configured)"}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">Local Ollama keeps source text on this computer. External analysis uses only the selected provider and never falls back to another paid service.</p>
                  </label>
                  <div className="flex items-center justify-between gap-4 border border-border/60 p-4">
                    <div>
                      <Label htmlFor="auto-analyze-imports">Analyze imports automatically</Label>
                      <p className="mt-1 text-xs text-muted-foreground">Start analysis after Gmail, Drive, or local evidence is stored.</p>
                    </div>
                    <Switch
                      id="auto-analyze-imports"
                      checked={workflowPreferences.data?.autoAnalyzeImports ?? true}
                      disabled={preferencesUnavailable}
                      onCheckedChange={(checked) => void updateWorkflow({ autoAnalyzeImports: checked })}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-4 border border-border/60 p-4">
                    <Label htmlFor="auto-organize-documents">Discover and build dossiers automatically</Label>
                    <Switch id="auto-organize-documents" checked={workflowPreferences.data?.autoOrganizeDocuments ?? true}
                      disabled={preferencesUnavailable}
                      onCheckedChange={(checked) => void updateWorkflow({ autoOrganizeDocuments: checked })} />
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4 border-t border-border/60 pt-4">
                  <div>
                    <Label htmlFor="share-raw-analysis">Allow full source text for cloud analysis</Label>
                    <p className="mt-1 text-xs text-muted-foreground">Enabled by default so the selected provider can assess the complete record. Turning this off forces local analysis.</p>
                  </div>
                  <Switch
                    id="share-raw-analysis"
                    checked={workflowPreferences.data?.shareRawDocumentContent ?? true}
                    disabled={preferencesUnavailable}
                    onCheckedChange={(checked) => void updateWorkflow({ shareRawDocumentContent: checked })}
                  />
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-none border-0 border-t border-border bg-transparent shadow-none">
              <CardHeader className="px-0 py-5">
                <CardTitle>Review and approval</CardTitle>
                <CardDescription>Keep maximum control or reduce repetitive confirmations</CardDescription>
              </CardHeader>
              <CardContent className="px-0 grid gap-5 md:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span className="font-medium">Outreach shortlist review</span>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={workflowPreferences.data?.outreachReviewMode ?? "each"}
                    disabled={preferencesUnavailable}
                    onChange={(event) => void updateWorkflow({ outreachReviewMode: event.target.value as "each" | "batch" | "automatic" })}
                  >
                    <option value="each">Review every suggestion</option>
                    <option value="batch">Review a complete shortlist</option>
                    <option value="automatic">Build shortlists automatically</option>
                  </select>
                </label>
                <label className="space-y-2 text-sm">
                  <span className="font-medium">Outbound message approval</span>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={workflowPreferences.data?.messageApprovalMode ?? "each"}
                    disabled={preferencesUnavailable}
                    onChange={(event) => void updateWorkflow({ messageApprovalMode: event.target.value as "each" | "batch" | "automatic" })}
                  >
                    <option value="each">Approve every message</option>
                    <option value="batch">Approve reviewed batches</option>
                    <option value="automatic">Prepare drafts automatically; approval remains required</option>
                  </select>
                </label>
                <Alert className="md:col-span-2">
                  <Shield className="h-4 w-4" />
                  <AlertDescription>Changing an approval preference does not enable sending. Provider configuration, the outbound feature switch, ownership checks, and duplicate-send protection remain required.</AlertDescription>
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
                  <CardTitle>Email service</CardTitle>
                  <CardDescription className="mt-2">Current provider configuration and delivery test</CardDescription>
                </div>
                {providerInfo ? (
                  <Badge variant={providerInfo.configured ? "default" : "destructive"}>
                    {providerInfo.configured ? <CheckCircle2 className="mr-1 h-3 w-3" /> : <XCircle className="mr-1 h-3 w-3" />}
                    {providerInfo.configured ? "Configured" : "Not configured"}
                  </Badge>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="px-0 space-y-6">
              <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
                <div className="space-y-2">
                  <Label>Provider</Label>
                  <p className="text-sm font-semibold">{providerInfo ? providerName(providerInfo.provider) : "Loading..."}</p>
                </div>
                <div className="space-y-2">
                  <Label>From address</Label>
                  <p className="text-sm font-semibold">{providerInfo?.from || "Not configured"}</p>
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <p className="text-sm font-semibold">{providerInfo?.configured ? "Ready to send" : "Configuration needed"}</p>
                </div>
              </div>

              {providerInfo && !providerInfo.configured && providerInfo.missingVars?.length ? (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>Missing environment variables: {providerInfo.missingVars.join(", ")}</AlertDescription>
                </Alert>
              ) : null}

              {providerInfo?.provider === "console" ? (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>Development provider: messages are logged locally and are not delivered.</AlertDescription>
                </Alert>
              ) : null}

              <div className="space-y-3 border-t pt-4">
                <Label htmlFor="test-email">Test recipient</Label>
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
                    {isTesting ? "Sending..." : "Send test"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {section === "sources" ? (
          <div className="space-y-4">
            <EvidenceConnectionsCard />
            <Card className="rounded-none border-0 border-t border-border bg-transparent shadow-none">
              <CardHeader className="px-0 py-5">
                <CardTitle>Local computer</CardTitle>
                <CardDescription>Folders included in case keyword pulls</CardDescription>
              </CardHeader>
              <CardContent className="px-0 space-y-3">
                <Button variant="outline" onClick={() => void openScanner()}>
                  <HardDrive className="mr-2 h-4 w-4" />
                  Add folder
                </Button>
                {scannerFolders.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No local folders selected.</p>
                ) : (
                  <div className="space-y-2">
                    {scannerFolders.map((path) => (
                      <div key={path} className="flex items-center gap-2 border-b border-border/40 py-2">
                        <span className="min-w-0 flex-1 truncate text-sm" title={path}>{path}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${path}`}
                          title="Remove folder"
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
                    <CardTitle className="flex items-center gap-2"><Link2 className="h-5 w-5" />HAI connector</CardTitle>
                    <CardDescription className="mt-2">Owner-bound, incremental access to minimized case and analysis records</CardDescription>
                  </div>
                  <Badge variant="outline">Read only</Badge>
                </div>
              </CardHeader>
              <CardContent className="px-0 space-y-5">
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="hai-base-url">LARO base URL</Label>
                    <div className="flex gap-2">
                      <Input id="hai-base-url" readOnly value={haiConnection.data?.baseUrl ?? "Loading..."} className="font-mono text-xs" />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label="Copy LARO base URL"
                        title="Copy LARO base URL"
                        disabled={!haiConnection.data?.baseUrl}
                        onClick={() => haiConnection.data?.baseUrl && void copyValue(haiConnection.data.baseUrl, "Base URL")}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="hai-feed-url">Feed endpoint</Label>
                    <div className="flex gap-2">
                      <Input id="hai-feed-url" readOnly value={haiConnection.data?.feedUrl ?? "Loading..."} className="font-mono text-xs" />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label="Copy HAI feed endpoint"
                        title="Copy HAI feed endpoint"
                        disabled={!haiConnection.data?.feedUrl}
                        onClick={() => haiConnection.data?.feedUrl && void copyValue(haiConnection.data.feedUrl, "Feed endpoint")}
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
                      <p>This credential is shown once. LARO stores only its hash.</p>
                      <div className="flex gap-2">
                        <Input aria-label="New HAI credential" readOnly value={revealedHaiToken} className="font-mono text-xs" />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label="Copy new HAI credential"
                          title="Copy new HAI credential"
                          onClick={() => void copyValue(revealedHaiToken, "Credential")}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setRevealedHaiToken(null)}>Hide credential</Button>
                    </AlertDescription>
                  </Alert>
                ) : null}

                <div className="grid gap-4 border-t border-border/50 pt-4 md:grid-cols-[minmax(0,1fr)_180px_auto] md:items-end">
                  <div className="space-y-2">
                    <Label htmlFor="hai-token-name">Credential name</Label>
                    <Input id="hai-token-name" value={haiTokenName} maxLength={80} onChange={(event) => setHaiTokenName(event.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="hai-token-expiry">Expires after</Label>
                    <select
                      id="hai-token-expiry"
                      value={haiTokenDays}
                      onChange={(event) => setHaiTokenDays(event.target.value)}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="30">30 days</option>
                      <option value="90">90 days</option>
                      <option value="180">180 days</option>
                      <option value="365">365 days</option>
                    </select>
                  </div>
                  <Button
                    type="button"
                    disabled={createHaiTokenMutation.isPending || haiTokenName.trim().length < 2}
                    onClick={() => void handleCreateHaiToken()}
                  >
                    <KeyRound className="mr-2 h-4 w-4" />
                    {createHaiTokenMutation.isPending ? "Creating..." : "Create credential"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-none border-0 border-t border-border bg-transparent shadow-none">
              <CardHeader className="px-0 py-5">
                <CardTitle>Credentials</CardTitle>
                <CardDescription>Active, expired, and revoked HAI access</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                {haiTokens.isLoading ? (
                  <p className="text-sm text-muted-foreground">Loading credentials...</p>
                ) : haiTokens.error ? (
                  <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>Credentials could not be loaded.</AlertDescription></Alert>
                ) : (haiTokens.data?.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">No HAI credential has been created.</p>
                ) : (
                  <div className="divide-y divide-border/50 border-y border-border/50">
                    {haiTokens.data?.map((credential) => (
                      <div key={credential.id} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{credential.name}</p>
                          <p className="font-mono text-xs text-muted-foreground">{credential.tokenPrefix}...</p>
                          <p className="text-xs text-muted-foreground">
                            Expires {new Date(credential.expiresAt).toLocaleDateString()}
                            {credential.lastUsedAt ? ` | Last used ${new Date(credential.lastUsedAt).toLocaleString()}` : " | Not used"}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 sm:justify-end">
                          <Badge variant={credential.status === "active" ? "default" : "outline"}>{credential.status}</Badge>
                          {credential.status === "active" ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={revokeHaiTokenMutation.isPending}
                              onClick={() => void handleRevokeHaiToken(credential.id)}
                            >
                              Revoke
                            </Button>
                          ) : null}
                        </div>
                      </div>
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
              <h2 className="text-base font-semibold">{nl ? "Privacy en account" : "Privacy and account"}</h2>
              <Button variant="outline" onClick={() => setLocation("/privacy")}><Shield className="h-4 w-4" />{nl ? "Privacy-instellingen" : "Privacy settings"}</Button>
            </div>
            <Card className="rounded-none border-0 border-t border-border bg-transparent shadow-none">
              <CardHeader className="px-0 py-5">
                <CardTitle className="flex items-center gap-2"><FileArchive className="h-5 w-5" />Account archive</CardTitle>
                <CardDescription>Portable JSON export of data owned by your account</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                <Button variant="outline" onClick={() => void handleAccountExport()} disabled={isExporting}>
                  <FileArchive className="mr-2 h-4 w-4" />
                  {isExporting ? "Exporting..." : "Download archive"}
                </Button>
              </CardContent>
            </Card>
            <Card className="rounded-none border-0 border-t border-border bg-transparent shadow-none">
              <CardHeader className="px-0 py-5">
                <CardTitle className="flex items-center gap-2"><History className="h-5 w-5" />Activity history</CardTitle>
                <CardDescription>Up to 200 recent audit entries for your account</CardDescription>
              </CardHeader>
              <CardContent className="px-0 space-y-3">
                {auditLog.error && <QueryNotice error={auditLog.error} retry={auditLog.refetch} />}
                <p className="text-sm text-muted-foreground">
                  {auditLog.isLoading ? "Loading..." : auditLog.data ? `${auditLog.data.length} entries available` : ""}
                </p>
                <Button variant="outline" onClick={() => void handleActivityExport()} disabled={isDownloadingActivity}>
                  <History className="mr-2 h-4 w-4" />
                  {isDownloadingActivity ? "Preparing..." : "Download activity"}
                </Button>
              </CardContent>
            </Card>
            <Card className="rounded-none border-0 border-t border-border bg-transparent shadow-none lg:col-span-2">
              <CardHeader className="px-0 py-5">
                <CardTitle className="flex items-center gap-2"><HardDrive className="h-5 w-5" />Legacy workspace imports</CardTitle>
                <CardDescription>Owner-bound Flask migrations retained with source hashes and provenance</CardDescription>
              </CardHeader>
              <CardContent className="px-0 space-y-3">
                {legacyImports.isLoading ? (
                  <p className="text-sm text-muted-foreground">Loading migration history...</p>
                ) : legacyImports.error ? (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>Migration history could not be loaded.</AlertDescription>
                  </Alert>
                ) : (legacyImports.data?.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">No Flask workspace has been migrated into this account.</p>
                ) : (
                  <div className="divide-y divide-border/50 border-y border-border/50">
                    {legacyImports.data?.map((run) => (
                      <div key={run.id} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{run.sourceInstanceId}</p>
                          <p className="text-xs text-muted-foreground">
                            {run.casesImported} cases, {run.recordsImported} archived records, {run.filesCopied} files
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                          <Badge variant={run.missingFiles > 0 ? "destructive" : "outline"}>
                            {run.missingFiles > 0 ? `${run.missingFiles} unavailable files` : "Files verified"}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {run.completedAt ? new Date(run.completedAt).toLocaleString() : run.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">Archived source rows are included in the Account archive above.</p>
              </CardContent>
            </Card>
          </div>
        ) : null}
      </div>
    </DashboardLayout>
  );
}
