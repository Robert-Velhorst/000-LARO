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
import { GoogleDriveFolderBrowser } from "./GoogleDriveFolderBrowser";

interface AutoCollectionSettingsProps {
  caseId: string;
}

export function AutoCollectionSettings({ caseId }: AutoCollectionSettingsProps) {
  const [keywords, setKeywords] = useState<string[]>([]);
  const [newKeyword, setNewKeyword] = useState("");
  const [keywordMatchMode, setKeywordMatchMode] = useState<"all" | "any">("any");
  const [dateRangeStart, setDateRangeStart] = useState<string>("");
  const [dateRangeEnd, setDateRangeEnd] = useState<string>("");
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [selectedDriveAccountId, setSelectedDriveAccountId] = useState("");
  const [autoDownloadAttachments, setAutoDownloadAttachments] = useState(true);
  const [autoDownloadGoogleDriveFiles, setAutoDownloadGoogleDriveFiles] = useState(true);
  const [selectedDriveFolderIds, setSelectedDriveFolderIds] = useState<string[]>([]);
  const [selectedDriveFolderNames, setSelectedDriveFolderNames] = useState<string[]>([]);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);

  // Fetch existing settings
  const { data: settingsData, isLoading: isLoadingSettings } = trpc.autoCollection.getSettings.useQuery(
    { caseId },
    { enabled: !!caseId }
  );

  // Fetch connected email accounts
  const { data: accountsData } = trpc.emailAccounts.list.useQuery();
  
  const emailAccounts = accountsData ?? [];
  const googleAccounts = emailAccounts.filter((account) => account.provider === "gmail");

  // Mutations
  const upsertMutation = trpc.autoCollection.upsertSettings.useMutation({
    onSuccess: (data) => {
      toast.success("Auto-collection settings saved");
      if (data.runResult) {
        toast.success(`Evidence automatically pulled: ${data.runResult.emailsProcessed} emails, ${data.runResult.filesDownloaded} files`);
      } else if (data.error) {
        toast.error(`Settings saved, but auto-pull failed: ${data.error}`);
      }
    },
    onError: (error) => {
      toast.error(`Failed to save settings: ${error.message}`);
    },
  });

  const runCollectionMutation = trpc.autoCollection.runCollection.useMutation({
    onSuccess: (data) => {
      toast.success(
        `Collection complete: ${data.result.emailsProcessed} emails, ${data.result.filesDownloaded} files`
      );
    },
    onError: (error) => {
      toast.error(`Collection failed: ${error.message}`);
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
      if (s.metadata) {
        try {
          const metadata = JSON.parse(s.metadata);
          setSelectedDriveAccountId(
            typeof metadata.googleDriveAccountId === "string" ? metadata.googleDriveAccountId : "",
          );
        } catch {
          setSelectedDriveAccountId("");
        }
      }
      
      setAutoDownloadAttachments(s.autoDownloadAttachments ?? true);
      setAutoDownloadGoogleDriveFiles(s.autoDownloadGoogleDriveFiles ?? true);
      
      if (s.googleDriveFolderIds) {
        try {
          const folderIds = typeof s.googleDriveFolderIds === 'string'
            ? JSON.parse(s.googleDriveFolderIds)
            : s.googleDriveFolderIds;
          setSelectedDriveFolderIds(folderIds);
        } catch (e) {
          console.error("Failed to parse Google Drive folder IDs:", e);
        }
      }
      
      if (s.dateRangeStart) {
        setDateRangeStart(new Date(s.dateRangeStart).toISOString().split("T")[0]);
      }
      if (s.dateRangeEnd) {
        setDateRangeEnd(new Date(s.dateRangeEnd).toISOString().split("T")[0]);
      }
    }
  }, [settingsData]);

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
    if (keywords.length === 0) {
      toast.error("Please add at least one keyword");
      return;
    }

    upsertMutation.mutate({
      caseId,
      keywords,
      keywordMatchMode,
      dateRangeStart: dateRangeStart ? new Date(dateRangeStart) : undefined,
      dateRangeEnd: dateRangeEnd ? new Date(dateRangeEnd) : undefined,
      emailAccountIds: selectedAccountIds,
      googleDriveAccountId: selectedDriveAccountId || undefined,
      googleDriveFolderIds: selectedDriveFolderIds,
      autoDownloadAttachments,
      autoDownloadGoogleDriveFiles,
    });
  };

  const handleRunCollection = () => {
    if (keywords.length === 0) {
      toast.error("Please configure keywords first");
      return;
    }
    runCollectionMutation.mutate({ caseId });
  };

  const handleRemoveDriveFolder = (index: number) => {
    const newFolderIds = [...selectedDriveFolderIds];
    const newFolderNames = [...selectedDriveFolderNames];
    newFolderIds.splice(index, 1);
    newFolderNames.splice(index, 1);
    setSelectedDriveFolderIds(newFolderIds);
    setSelectedDriveFolderNames(newFolderNames);
  };

  const handleFoldersSelected = (folderIds: string[], folderNames: string[], accountId: string) => {
    setSelectedDriveFolderIds(folderIds);
    setSelectedDriveFolderNames(folderNames);
    setSelectedDriveAccountId(accountId);
    setShowFolderBrowser(false);
    toast.success(`Selected ${folderIds.length} folder(s)`);
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
            ← Back to Settings
          </Button>
          <GoogleDriveFolderBrowser
            caseId={caseId}
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
              Auto-Collection Settings
            </CardTitle>
            <CardDescription>
              Configure automatic evidence collection from your connected email accounts and Google Drive.
              The system will search for emails and files matching your keywords.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <Tabs defaultValue="keywords" className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="keywords">
                  <Search className="h-4 w-4 mr-2" />
                  Keywords
                </TabsTrigger>
                <TabsTrigger value="sources">
                  <Mail className="h-4 w-4 mr-2" />
                  Sources
                </TabsTrigger>
                <TabsTrigger value="options">
                  <Settings2 className="h-4 w-4 mr-2" />
                  Options
                </TabsTrigger>
              </TabsList>

              <TabsContent value="keywords" className="space-y-4 mt-4">
                {/* Keywords Section */}
                <div className="space-y-3">
                  <Label className="flex items-center gap-2">
                    <Search className="h-4 w-4" />
                    Keywords to Search
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Enter a keyword..."
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
                      <span className="text-sm text-muted-foreground">No keywords added yet</span>
                    )}
                  </div>
                </div>

                {/* Match Mode */}
                <div className="space-y-3">
                  <Label>Keyword Match Mode</Label>
                  <Select value={keywordMatchMode} onValueChange={(v: "all" | "any") => setKeywordMatchMode(v)}>
                    <SelectTrigger className="w-[200px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Match ANY keyword</SelectItem>
                      <SelectItem value="all">Match ALL keywords</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {keywordMatchMode === "any"
                      ? "Items containing at least one keyword will be collected"
                      : "Only items containing all keywords will be collected"}
                  </p>
                </div>

                {/* Date Range */}
                <div className="space-y-3">
                  <Label className="flex items-center gap-2">
                    <Calendar className="h-4 w-4" />
                    Date Range (Optional)
                  </Label>
                  <div className="flex gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">From</Label>
                      <Input
                        type="date"
                        value={dateRangeStart}
                        onChange={(e) => setDateRangeStart(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">To</Label>
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
                    Email Accounts to Search
                  </Label>
                  {emailAccounts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No email accounts connected. Go to Settings → Email to connect your accounts.
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
                    Google Drive Folders
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Select specific folders in Google Drive to monitor for evidence
                  </p>

                  {selectedDriveAccountId && (
                    <Badge variant="outline">
                      {googleAccounts.find((account) => account.id === selectedDriveAccountId)?.email || "Selected Google account"}
                    </Badge>
                  )}
                  
                  <div className="flex flex-wrap gap-2">
                    {selectedDriveFolderIds.map((folderId, index) => (
                      <Badge key={folderId} variant="secondary" className="gap-1 px-3 py-1">
                        <Folder className="h-3 w-3" />
                        {selectedDriveFolderNames[index] || folderId}
                        <button
                          onClick={() => handleRemoveDriveFolder(index)}
                          className="ml-1 hover:text-destructive"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                    {selectedDriveFolderIds.length === 0 && (
                      <span className="text-sm text-muted-foreground">No folders selected</span>
                    )}
                  </div>

                  <Button
                    variant="outline"
                    onClick={() => setShowFolderBrowser(true)}
                    disabled={googleAccounts.length === 0}
                  >
                    <Folder className="h-4 w-4 mr-2" />
                    Browse Google Drive
                  </Button>
                </div>
              </TabsContent>

              <TabsContent value="options" className="space-y-4 mt-4">
                {/* Options */}
                <div className="space-y-3">
                  <Label className="flex items-center gap-2">
                    <Settings2 className="h-4 w-4" />
                    Collection Options
                  </Label>
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <Switch
                        checked={autoDownloadAttachments}
                        onCheckedChange={setAutoDownloadAttachments}
                      />
                      <span className="text-sm">Automatically download email attachments</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <Switch
                        checked={autoDownloadGoogleDriveFiles}
                        onCheckedChange={setAutoDownloadGoogleDriveFiles}
                      />
                      <span className="text-sm">Automatically download Google Drive files</span>
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
                    Saving...
                  </>
                ) : (
                  "Save Settings"
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
                    Collecting...
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 mr-2" />
                    Run Collection Now
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
