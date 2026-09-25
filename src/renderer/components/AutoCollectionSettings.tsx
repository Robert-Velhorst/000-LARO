import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Plus, X, Search, Calendar, Mail, Play, Settings2, Sparkles, Folder, Cloud } from "lucide-react";
import { toast } from "sonner";
import { GoogleDriveSourceSelector } from "./GoogleDriveSourceSelector";
import { savedGoogleDriveSources, type GoogleDriveSource } from "../../../shared/googleDriveSources";
import { useI18n } from "@/contexts/I18nContext";

interface AutoCollectionSettingsProps {
  caseId: string;
}

export function AutoCollectionSettings({ caseId }: AutoCollectionSettingsProps) {
  const { t } = useI18n();
  const [keywords, setKeywords] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState("");
  const [keywordMatchMode, setKeywordMatchMode] = useState<"all" | "any">("any");
  const [dateRangeStart, setDateRangeStart] = useState<string>("");
  const [dateRangeEnd, setDateRangeEnd] = useState<string>("");
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [selectedDriveAccountId, setSelectedDriveAccountId] = useState("");
  const [autoDownloadAttachments, setAutoDownloadAttachments] = useState(true);
  const [autoDownloadGoogleDriveFiles, setAutoDownloadGoogleDriveFiles] = useState(true);
  const [driveSources, setDriveSources] = useState<GoogleDriveSource[]>([]);
  const [driveSelectionError, setDriveSelectionError] = useState("");
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);

  // Fetch existing settings
  const { data: settingsData, isLoading: isLoadingSettings } = trpc.autoCollection.getSettings.useQuery(
    { caseId },
    { enabled: !!caseId }
  );

  // Fetch connected email accounts
  const { data: accountsData } = trpc.providerConnections.list.useQuery(
    { provider: "gmail" },
    { refetchOnWindowFocus: true },
  );
  
  const emailAccounts = accountsData ?? [];
  const googleAccounts = emailAccounts.filter((account) => account.provider === "gmail");

  // Mutations
  const upsertMutation = trpc.autoCollection.upsertSettings.useMutation({
    onSuccess: (data) => {
      toast.success(t("collection.settings.saved"));
      if (data.runResult) {
        toast.success(t("collection.settings.pulled", {
          emails: data.runResult.emailsProcessed,
          files: data.runResult.filesDownloaded,
        }));
        if (data.runResult.errors.length) toast.error(data.runResult.errors.join("; "));
      } else if (data.error) {
        toast.error(t("collection.settings.savedPullFailed", { message: data.error }));
      }
    },
    onError: (error) => {
      toast.error(t("collection.settings.saveFailed", { message: error.message }));
    },
  });

  const runCollectionMutation = trpc.autoCollection.runCollection.useMutation({
    onSuccess: (data) => {
      const summary = t("collection.run.summary", {
        emails: data.result.emailsProcessed,
        files: data.result.filesDownloaded,
      });
      if (data.success) toast.success(summary);
      else toast.warning(t("collection.run.withErrors", { summary }), { description: data.result.errors[0] });
    },
    onError: (error) => {
      toast.error(t("collection.run.failed", { message: error.message }));
    },
  });

  // Load existing settings
  useEffect(() => {
    if (settingsData?.settings) {
      const s = settingsData.settings;
      
      // Parse keywords
      const parsedKeywords = typeof s.keywords === 'string' 
        ? JSON.parse(s.keywords) 
        : (Array.isArray(s.keywords) ? s.keywords : []);
      setKeywords(parsedKeywords);
      
      const mode = s.keywordMatchMode as "all" | "any";
      setKeywordMatchMode(mode || "any");
      
      // Parse email account IDs
      const parsedAccountIds = typeof s.emailAccountIds === 'string'
        ? JSON.parse(s.emailAccountIds)
        : (Array.isArray(s.emailAccountIds) ? s.emailAccountIds : []);
      setSelectedAccountIds(parsedAccountIds);
      setDriveSelectionError("");
      try {
        const saved = savedGoogleDriveSources(s.metadata);
        const metadata = JSON.parse(s.metadata || "{}");
        const legacyFolders = JSON.parse(s.googleDriveFolderIds || "[]") as string[];
        const legacyId = metadata.googleDriveAccountId || "";
        setDriveSources(saved ?? (legacyId || legacyFolders.length ? [{
          accountId: legacyId, folderIds: legacyFolders.length ? legacyFolders : ["root"],
        }] : []));
      } catch {
        setDriveSelectionError(t("collection.drive.selectionUnreadable"));
      }
      
      setAutoDownloadAttachments(s.autoDownloadAttachments ?? true);
      setAutoDownloadGoogleDriveFiles(s.autoDownloadGoogleDriveFiles ?? true);
      
      
      if (s.dateRangeStart) {
        setDateRangeStart(new Date(s.dateRangeStart).toISOString().split("T")[0]);
      }
      if (s.dateRangeEnd) {
        setDateRangeEnd(new Date(s.dateRangeEnd).toISOString().split("T")[0]);
      }
    }
  }, [settingsData, t]);

  const handleAddKeyword = () => {
    const trimmed = newKeyword.trim();
    if (trimmed && !keywords.includes(trimmed)) {
      setKeywords([...keywords, trimmed]);
      setNewKeyword("");
    }
  };

  const handleRemoveKeyword = (keyword: string) => {
    setKeywords(keywords.filter((k) => k !== keyword));
  };

  const handleSaveSettings = () => {
    if (driveSelectionError || driveSources.some((source) => !source.accountId)) {
      toast.error(driveSelectionError || t("collection.drive.accountRequired"));
      return;
    }
    if (keywords.length === 0) {
      toast.error(t("collection.keywords.required"));
      return;
    }

    upsertMutation.mutate({
      caseId,
      keywords,
      keywordMatchMode,
      dateRangeStart: dateRangeStart ? new Date(dateRangeStart) : undefined,
      dateRangeEnd: dateRangeEnd ? new Date(dateRangeEnd) : undefined,
      emailAccountIds: selectedAccountIds,
      googleDriveSources: driveSources,
      autoDownloadAttachments,
      autoDownloadGoogleDriveFiles,
    });
  };

  const handleRunCollection = () => {
    if (keywords.length === 0) {
      toast.error(t("collection.keywords.configureFirst"));
      return;
    }
    runCollectionMutation.mutate({ caseId });
  };

  const handleRemoveDriveFolder = (accountId: string, folderId: string) => {
    setDriveSources((sources) => sources.map((source) => source.accountId !== accountId ? source : {
      ...source,
      folderIds: source.folderIds.filter((id) => id !== folderId),
      folderNames: source.folderIds.flatMap((id, index) => id === folderId ? [] : [source.folderNames?.[index] || id]),
    }).filter((source) => source.folderIds.length > 0));
  };

  const handleFoldersSelected = (folderIds: string[], folderNames: string[], accountId: string) => {
    setDriveSources((sources) => {
      const existing = sources.find((source) => source.accountId === accountId);
      const folders = new Map(existing?.folderIds.map((id, index) => [id, existing.folderNames?.[index] || id]));
      folderIds.forEach((id, index) => folders.set(id, folderNames[index] || id));
      return [...sources.filter((source) => source.accountId !== accountId), {
        accountId, folderIds: [...folders.keys()], folderNames: [...folders.values()],
      }];
    });
    setSelectedDriveAccountId(accountId);
    setShowFolderBrowser(false);
    toast.success(t("collection.drive.foldersSelected", { count: folderIds.length }));
  };

  if (isLoadingSettings) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {showFolderBrowser ? (
        <div className="space-y-4">
          <Button
            variant="outline"
            onClick={() => setShowFolderBrowser(false)}
          >
            &larr; {t("collection.backToSettings")}
          </Button>
          <GoogleDriveSourceSelector
            initialAccountId={selectedDriveAccountId}
            onFoldersSelected={handleFoldersSelected}
            multiSelect={true}
          />
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              {t("collection.settings.title")}
            </CardTitle>
            <CardDescription>
              {t("collection.settings.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <Tabs defaultValue="keywords" className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="keywords">
                  <Search className="h-4 w-4 mr-2" />
                  {t("collection.tabs.keywords")}
                </TabsTrigger>
                <TabsTrigger value="sources">
                  <Mail className="h-4 w-4 mr-2" />
                  {t("collection.tabs.sources")}
                </TabsTrigger>
                <TabsTrigger value="options">
                  <Settings2 className="h-4 w-4 mr-2" />
                  {t("collection.tabs.options")}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="keywords" className="space-y-4 mt-4">
                {/* Keywords Section */}
                <div className="space-y-3">
                  <Label className="flex items-center gap-2">
                    <Search className="h-4 w-4" />
                    {t("collection.keywords.label")}
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder={t("collection.keywords.placeholder")}
                      value={newKeyword}
                      onChange={(e) => setNewKeyword(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleAddKeyword()}
                    />
                    <Button onClick={handleAddKeyword} variant="secondary">
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {keywords.map((keyword) => (
                      <Badge key={keyword} variant="secondary" className="gap-1 px-3 py-1">
                        {keyword}
                        <button
                          onClick={() => handleRemoveKeyword(keyword)}
                          className="ml-1 hover:text-destructive"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                    {keywords.length === 0 && (
                      <span className="text-sm text-muted-foreground">{t("collection.keywords.none")}</span>
                    )}
                  </div>
                </div>

                {/* Match Mode */}
                <div className="space-y-3">
                  <Label>{t("collection.matchMode.label")}</Label>
                  <Select value={keywordMatchMode} onValueChange={(v: "all" | "any") => setKeywordMatchMode(v)}>
                    <SelectTrigger className="w-[200px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">{t("collection.matchMode.any")}</SelectItem>
                      <SelectItem value="all">{t("collection.matchMode.all")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {keywordMatchMode === "any"
                      ? t("collection.matchMode.anyHint")
                      : t("collection.matchMode.allHint")}
                  </p>
                </div>

                {/* Date Range */}
                <div className="space-y-3">
                  <Label className="flex items-center gap-2">
                    <Calendar className="h-4 w-4" />
                    {t("collection.dateRange")}
                  </Label>
                  <div className="flex gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">{t("collection.dateFrom")}</Label>
                      <Input
                        type="date"
                        value={dateRangeStart}
                        onChange={(e) => setDateRangeStart(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">{t("collection.dateTo")}</Label>
                      <Input
                        type="date"
                        value={dateRangeEnd}
                        onChange={(e) => setDateRangeEnd(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="sources" className="space-y-4 mt-4">
                {/* Email Accounts */}
                <div className="space-y-3">
                  <Label className="flex items-center gap-2">
                    <Mail className="h-4 w-4" />
                    {t("collection.emailAccounts")}
                  </Label>
                  {emailAccounts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("collection.emailAccounts.none")}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {emailAccounts.map((account) => (
                        <div key={account.id} className="flex items-center gap-3">
                          <Switch
                            checked={selectedAccountIds.includes(account.id)}
                            onCheckedChange={(checked: boolean) => {
                              if (checked) {
                                setSelectedAccountIds([...selectedAccountIds, account.id]);
                              } else {
                                setSelectedAccountIds(selectedAccountIds.filter((id) => id !== account.id));
                              }
                            }}
                          />
                          <span className="text-sm">{account.email}</span>
                          <Badge variant="outline" className="text-xs">
                            {account.provider}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Google Drive Folders */}
                <div className="space-y-3">
                  <Label className="flex items-center gap-2">
                    <Cloud className="h-4 w-4" />
                    {t("collection.drive.folders")}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t("collection.drive.foldersHint")}
                  </p>

                  {driveSelectionError && <p role="alert" className="text-sm text-destructive">{driveSelectionError}</p>}
                  {driveSources.map((source) => (
                    <div key={source.accountId} className="space-y-2 border-b pb-3" data-testid="drive-source-selection">
                      <p className="break-all text-sm font-medium">
                        {googleAccounts.find((account) => account.id === source.accountId)?.email || t("collection.drive.accountUnavailable")}
                      </p>
                      {!source.accountId && <Select onValueChange={(accountId) => setDriveSources((sources) => sources.map((item) => item === source ? { ...item, accountId } : item))}>
                        <SelectTrigger aria-label={t("collection.drive.existingAccountLabel")}><SelectValue placeholder={t("collection.drive.existingAccountPlaceholder")} /></SelectTrigger>
                        <SelectContent>{googleAccounts.filter((account) => !driveSources.some((item) => item.accountId === account.id)).map((account) => <SelectItem key={account.id} value={account.id}>{account.email}</SelectItem>)}</SelectContent>
                      </Select>}
                      <div className="flex flex-wrap gap-2">
                        {source.folderIds.map((folderId, index) => (
                          <Badge key={folderId} variant="secondary" className="max-w-full gap-1 px-3 py-1">
                            <Folder className="h-3 w-3 shrink-0" />
                            <span className="break-all">{folderId === "root" ? t("collection.drive.myDrive") : source.folderNames?.[index] || folderId}</span>
                            <button type="button" aria-label={t("collection.drive.removeFolder", { name: source.folderNames?.[index] || folderId })}
                              onClick={() => handleRemoveDriveFolder(source.accountId, folderId)} className="ml-1 shrink-0 hover:text-destructive">
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ))}
                  {driveSources.length === 0 && <p className="text-sm text-muted-foreground">{t("collection.drive.none")}</p>}

                  <Button
                    variant="outline"
                    onClick={() => setShowFolderBrowser(true)}
                    disabled={googleAccounts.length === 0}
                  >
                    <Folder className="h-4 w-4 mr-2" />
                    {t("collection.drive.browse")}
                  </Button>
                </div>
              </TabsContent>

              <TabsContent value="options" className="space-y-4 mt-4">
                {/* Options */}
                <div className="space-y-3">
                  <Label className="flex items-center gap-2">
                    <Settings2 className="h-4 w-4" />
                    {t("collection.options.title")}
                  </Label>
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <Switch
                        checked={autoDownloadAttachments}
                        onCheckedChange={setAutoDownloadAttachments}
                      />
                      <span className="text-sm">{t("collection.options.emailAttachments")}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <Switch
                        checked={autoDownloadGoogleDriveFiles}
                        onCheckedChange={setAutoDownloadGoogleDriveFiles}
                      />
                      <span className="text-sm">{t("collection.options.driveFiles")}</span>
                    </div>
                  </div>
                </div>
              </TabsContent>
            </Tabs>

            {/* Actions */}
            <div className="flex gap-3 pt-4 border-t">
              <Button
                onClick={handleSaveSettings}
                disabled={upsertMutation.isPending}
              >
                {upsertMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    {t("collection.saving")}
                  </>
                ) : (
                  t("collection.saveSettings")
                )}
              </Button>
              <Button
                variant="secondary"
                onClick={handleRunCollection}
                disabled={runCollectionMutation.isPending || keywords.length === 0}
              >
                {runCollectionMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    {t("collection.collecting")}
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 mr-2" />
                    {t("collection.runNow")}
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default AutoCollectionSettings;
