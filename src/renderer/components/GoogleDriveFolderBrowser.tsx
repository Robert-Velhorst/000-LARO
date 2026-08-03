import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  Loader2, 
  Folder, 
  FolderOpen, 
  ChevronRight, 
  Check, 
  Cloud, 
  Search,
  FileText,
  Download,
  AlertCircle
} from "lucide-react";
import { toast } from "sonner";

interface GoogleDriveFolderBrowserProps {
  caseId: string;
  initialAccountId?: string;
  onFoldersSelected?: (folderIds: string[], folderNames: string[], accountId: string) => void;
  multiSelect?: boolean;
}

interface DriveFolder {
  id: string | null | undefined;
  name: string | null | undefined;
  modifiedTime?: string | null;
  parents?: string[] | null;
}

export function GoogleDriveFolderBrowser({ 
  caseId, 
  initialAccountId,
  onFoldersSelected,
  multiSelect = true 
}: GoogleDriveFolderBrowserProps) {
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const [selectedFolderNames, setSelectedFolderNames] = useState<Map<string, string>>(new Map());
  const [currentPath, setCurrentPath] = useState<Array<{ id: string; name: string }>>([]);
  const [parentId, setParentId] = useState<string | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState("");
  const [previewFolderId, setPreviewFolderId] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState(initialAccountId || "");

  // Check connection status
  const { data: connectionData, isLoading: isCheckingConnection } = trpc.googleDrive.checkConnection.useQuery();
  const connectedAccounts = connectionData?.accounts ?? [];

  useEffect(() => {
    if (connectedAccounts.length === 0) return;
    setSelectedAccountId((current) => {
      if (connectedAccounts.some((account) => account.id === current)) return current;
      if (initialAccountId && connectedAccounts.some((account) => account.id === initialAccountId)) {
        return initialAccountId;
      }
      return connectedAccounts.length === 1 ? connectedAccounts[0].id : "";
    });
  }, [connectionData, initialAccountId]);

  // List folders
  const { data: foldersData, isLoading: isLoadingFolders } = trpc.googleDrive.listFolders.useQuery(
    { parentId, accountId: selectedAccountId || undefined },
    { enabled: !!connectionData?.connected && !!selectedAccountId }
  );

  // Get file preview
  const { data: previewData, isLoading: isLoadingPreview } = trpc.googleDrive.getFilesInFolder.useQuery(
    { folderId: previewFolderId!, recursive: false, accountId: selectedAccountId || undefined },
    { enabled: !!previewFolderId && !!selectedAccountId }
  );

  // Import mutation
  const importFolderMutation = trpc.googleDrive.importFolder.useMutation({
    onSuccess: (data) => {
      toast.success(
        `Successfully imported ${data.imported} files${data.skipped > 0 ? ` (${data.skipped} skipped)` : ""}`,
        { description: data.errors.length > 0 ? `${data.errors.length} errors occurred` : undefined }
      );
    },
    onError: (error) => {
      toast.error(`Failed to import folder: ${error.message}`);
    },
  });

  const folders = foldersData?.folders || [];

  const handleFolderClick = (folder: DriveFolder) => {
    if (!folder.id) return;
    
    if (!multiSelect) {
      setSelectedFolders(new Set([folder.id]));
      setSelectedFolderNames(new Map([[folder.id, folder.name || "Unknown"]]));
    } else {
      const newSelected = new Set(selectedFolders);
      const newNames = new Map(selectedFolderNames);
      
      if (newSelected.has(folder.id)) {
        newSelected.delete(folder.id);
        newNames.delete(folder.id);
      } else {
        newSelected.add(folder.id);
        newNames.set(folder.id, folder.name || "Unknown");
      }
      
      setSelectedFolders(newSelected);
      setSelectedFolderNames(newNames);
    }
  };

  const handleFolderDoubleClick = (folder: DriveFolder) => {
    if (!folder.id || !folder.name) return;
    
    setParentId(folder.id);
    setCurrentPath([...currentPath, { id: folder.id, name: folder.name }]);
  };

  const handleBreadcrumbClick = (index: number) => {
    if (index === -1) {
      setParentId(undefined);
      setCurrentPath([]);
    } else {
      const newPath = currentPath.slice(0, index + 1);
      setCurrentPath(newPath);
      setParentId(newPath[newPath.length - 1].id);
    }
  };

  const handlePreview = (folderId: string | null | undefined) => {
    if (!folderId) return;
    setPreviewFolderId(folderId);
  };

  const handleImportFolder = (folderId: string | null | undefined, folderName: string | null | undefined) => {
    if (!folderId || !folderName) return;
    
    importFolderMutation.mutate({
      caseId,
      folderId,
      folderName,
      recursive: true,
      accountId: selectedAccountId,
    });
  };

  const handleConfirmSelection = () => {
    if (!selectedAccountId) {
      toast.error("Select the Google account to use");
      return;
    }
    if (selectedFolders.size === 0) {
      toast.error("Please select at least one folder");
      return;
    }

    const folderIds = Array.from(selectedFolders);
    const folderNames = folderIds.map(id => selectedFolderNames.get(id) || "Unknown");

    if (onFoldersSelected) {
      onFoldersSelected(folderIds, folderNames, selectedAccountId);
    }
  };

  const filteredFolders = searchQuery
    ? folders.filter(f => f.name?.toLowerCase().includes(searchQuery.toLowerCase()))
    : folders;
  
  // Type guard for folder operations
  const isFolderValid = (folder: DriveFolder): folder is { id: string; name: string; modifiedTime?: string | null; parents?: string[] | null } => {
    return !!folder.id && !!folder.name;
  };

  if (isCheckingConnection) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!connectionData?.connected) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-orange-500" />
            Google Drive Not Connected
          </CardTitle>
          <CardDescription>
            Please connect your Google account to access Google Drive folders.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Go to Settings → Email Accounts to connect your Google account. Once connected, you'll be able to browse and import files from Google Drive.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cloud className="h-5 w-5 text-primary" />
            Browse Google Drive
          </CardTitle>
          <CardDescription>
            Select folders to monitor for evidence collection. Files matching your keywords will be automatically imported.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="drive-account">Google account</Label>
            <Select
              value={selectedAccountId}
              onValueChange={(accountId) => {
                setSelectedAccountId(accountId);
                setParentId(undefined);
                setCurrentPath([]);
                setPreviewFolderId(null);
                setSelectedFolders(new Set());
                setSelectedFolderNames(new Map());
              }}
            >
              <SelectTrigger id="drive-account" className="max-w-md">
                <SelectValue placeholder="Select a Google account" />
              </SelectTrigger>
              <SelectContent>
                {connectedAccounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.email || account.displayName || "Google account"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Breadcrumb Navigation */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <button
              onClick={() => handleBreadcrumbClick(-1)}
              className="hover:text-foreground hover:underline"
            >
              My Drive
            </button>
            {currentPath.map((folder, index) => (
              <div key={folder.id} className="flex items-center gap-2">
                <ChevronRight className="h-4 w-4" />
                <button
                  onClick={() => handleBreadcrumbClick(index)}
                  className="hover:text-foreground hover:underline"
                >
                  {folder.name}
                </button>
              </div>
            ))}
          </div>

          {/* Search */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search folders..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>

          {/* Folder List */}
          <ScrollArea className="h-[400px] border rounded-md">
            {isLoadingFolders ? (
              <div className="flex items-center justify-center p-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : filteredFolders.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-8 text-center">
                <Folder className="h-12 w-12 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">
                  {searchQuery ? "No folders found matching your search" : "No folders in this location"}
                </p>
              </div>
            ) : (
              <div className="p-2 space-y-1">
                {filteredFolders.map((folder) => {
                  // Type guard check
                  if (!folder.id || !folder.name) return null;
                  
                  const folderId = folder.id;
                  const folderName = folder.name;
                  const isSelected = selectedFolders.has(folderId);
                  
                  const validFolder: DriveFolder = {
                    id: folderId,
                    name: folderName,
                    modifiedTime: folder.modifiedTime,
                    parents: folder.parents,
                  };
                  
                  return (
                    <div
                      key={folderId}
                      className={`flex items-center gap-3 p-3 rounded-md cursor-pointer hover:bg-accent transition-colors ${
                        isSelected ? "bg-accent" : ""
                      }`}
                      onClick={() => handleFolderClick(validFolder)}
                      onDoubleClick={() => handleFolderDoubleClick(validFolder)}
                    >
                      <div className="flex items-center gap-2 flex-1">
                        {isSelected ? (
                          <FolderOpen className="h-5 w-5 text-primary" />
                        ) : (
                          <Folder className="h-5 w-5 text-muted-foreground" />
                        )}
                        <span className="text-sm font-medium">{folderName}</span>
                      </div>

                      <div className="flex items-center gap-2">
                        {isSelected && <Check className="h-4 w-4 text-primary" />}
                        
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handlePreview(folderId);
                          }}
                        >
                          <FileText className="h-4 w-4" />
                        </Button>
                        
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleImportFolder(folderId, folderName);
                          }}
                          disabled={importFolderMutation.isPending}
                        >
                          <Download className="h-4 w-4" />
                        </Button>

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleFolderDoubleClick(validFolder);
                          }}
                        >
                          <ChevronRight className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>

          {/* Selected Folders Summary */}
          {selectedFolders.size > 0 && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">Selected Folders ({selectedFolders.size})</Label>
              <div className="flex flex-wrap gap-2">
                {Array.from(selectedFolders).map((folderId) => (
                  <Badge key={folderId} variant="secondary" className="gap-1">
                    <Folder className="h-3 w-3" />
                    {selectedFolderNames.get(folderId) || "Unknown"}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-4 border-t">
            <Button
              onClick={handleConfirmSelection}
              disabled={selectedFolders.size === 0}
            >
              Confirm Selection
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* File Preview Panel */}
      {previewFolderId && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Folder Preview
            </CardTitle>
            <CardDescription>
              Files in this folder (non-recursive view)
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingPreview ? (
              <div className="flex items-center justify-center p-4">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  {previewData?.count || 0} files found
                </p>
                <ScrollArea className="h-[200px]">
                  <div className="space-y-1">
                    {previewData?.files.slice(0, 10).map((file) => (
                      <div key={file.id} className="flex items-center gap-2 p-2 text-sm">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span className="truncate">{file.name}</span>
                      </div>
                    ))}
                    {(previewData?.count || 0) > 10 && (
                      <p className="text-xs text-muted-foreground p-2">
                        ... and {(previewData?.count || 0) - 10} more files
                      </p>
                    )}
                  </div>
                </ScrollArea>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default GoogleDriveFolderBrowser;
