import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle, Check, ChevronRight, Cloud, Folder, FolderOpen, Loader2, Search } from "lucide-react";
import { toast } from "sonner";

interface GoogleDriveSourceSelectorProps {
  initialAccountId?: string;
  onFoldersSelected?: (folderIds: string[], folderNames: string[], accountId: string) => void;
  multiSelect?: boolean;
}

interface DriveFolder {
  id: string | null | undefined;
  name: string | null | undefined;
}

export function GoogleDriveSourceSelector({
  initialAccountId,
  onFoldersSelected,
  multiSelect = true,
}: GoogleDriveSourceSelectorProps) {
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const [selectedFolderNames, setSelectedFolderNames] = useState<Map<string, string>>(new Map());
  const [currentPath, setCurrentPath] = useState<Array<{ id: string; name: string }>>([]);
  const [parentId, setParentId] = useState<string | undefined>();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState(initialAccountId || "");

  const { data: connectionData, isLoading: isCheckingConnection } =
    trpc.providerConnections.list.useQuery({ provider: "gmail" });
  const connectedAccounts = (connectionData ?? []).filter((account) => account.status === "connected");

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

  const {
    data: foldersData,
    isLoading: isLoadingFolders,
    error: foldersError,
    refetch: retryFolders,
  } = trpc.autoCollection.listDriveFolders.useQuery(
    { parentId, accountId: selectedAccountId },
    { enabled: connectedAccounts.length > 0 && Boolean(selectedAccountId) },
  );

  const folders = (foldersData?.folders ?? []).filter(
    (folder): folder is DriveFolder & { id: string; name: string } => Boolean(folder.id && folder.name),
  );
  const filteredFolders = searchQuery
    ? folders.filter((folder) => folder.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : folders;

  const resetSelection = () => {
    setParentId(undefined);
    setCurrentPath([]);
    setSelectedFolders(new Set());
    setSelectedFolderNames(new Map());
  };

  const toggleFolder = (folder: { id: string; name: string }) => {
    if (!multiSelect) {
      setSelectedFolders(new Set([folder.id]));
      setSelectedFolderNames(new Map([[folder.id, folder.name]]));
      return;
    }
    setSelectedFolders((current) => {
      const next = new Set(current);
      if (next.has(folder.id)) next.delete(folder.id);
      else next.add(folder.id);
      return next;
    });
    setSelectedFolderNames((current) => {
      const next = new Map(current);
      if (next.has(folder.id)) next.delete(folder.id);
      else next.set(folder.id, folder.name);
      return next;
    });
  };

  const openFolder = (folder: { id: string; name: string }) => {
    setParentId(folder.id);
    setCurrentPath((path) => [...path, folder]);
    setSearchQuery("");
  };

  const openBreadcrumb = (index: number) => {
    if (index < 0) {
      setParentId(undefined);
      setCurrentPath([]);
      return;
    }
    const nextPath = currentPath.slice(0, index + 1);
    setCurrentPath(nextPath);
    setParentId(nextPath.at(-1)?.id);
  };

  const confirmSelection = () => {
    if (!selectedAccountId || selectedFolders.size === 0) {
      toast.error("Select a Google account and at least one folder");
      return;
    }
    const folderIds = [...selectedFolders];
    onFoldersSelected?.(
      folderIds,
      folderIds.map((id) => selectedFolderNames.get(id) || id),
      selectedAccountId,
    );
  };

  if (isCheckingConnection) {
    return <div className="flex items-center justify-center p-8"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  if (connectedAccounts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><AlertCircle className="h-5 w-5 text-orange-500" />Google Drive Not Connected</CardTitle>
          <CardDescription>Connect a Google account before selecting Drive sources.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Go to Settings → Google accounts, connect the account, then return here.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Cloud className="h-5 w-5 text-primary" />Select Google Drive Sources</CardTitle>
        <CardDescription>
          Choose folders for the maintained auto-collection path. Files are collected only when you save or run the configured keyword collection.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="drive-account">Google account</Label>
          <Select value={selectedAccountId} onValueChange={(accountId) => { setSelectedAccountId(accountId); resetSelection(); }}>
            <SelectTrigger id="drive-account" className="max-w-md"><SelectValue placeholder="Select a Google account" /></SelectTrigger>
            <SelectContent>
              {connectedAccounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>{account.email || account.displayName || "Google account"}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          variant="outline"
          disabled={!selectedAccountId}
          onClick={() => onFoldersSelected?.(["root"], ["My Drive (all folders)"], selectedAccountId)}
        >
          <Cloud className="mr-2 h-4 w-4" />Select all of My Drive
        </Button>

        <nav aria-label="Google Drive folder path" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <button type="button" onClick={() => openBreadcrumb(-1)} className="hover:text-foreground hover:underline">My Drive</button>
          {currentPath.map((folder, index) => (
            <span key={folder.id} className="flex items-center gap-2">
              <ChevronRight className="h-4 w-4" />
              <button type="button" onClick={() => openBreadcrumb(index)} className="hover:text-foreground hover:underline">{folder.name}</button>
            </span>
          ))}
        </nav>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search Drive folders" placeholder="Search folders..." value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} className="pl-10" />
        </div>

        <ScrollArea className="h-[400px] rounded-md border">
          {foldersError ? (
            <div role="alert" className="space-y-3 p-4 text-sm">
              <p>Folders could not be loaded for this Google account.</p>
              <Button variant="outline" onClick={() => void retryFolders()}>Retry</Button>
            </div>
          ) : isLoadingFolders ? (
            <div className="flex items-center justify-center p-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : filteredFolders.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-8 text-center">
              <Folder className="mb-2 h-12 w-12 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{searchQuery ? "No folders match this search" : "No folders in this location"}</p>
            </div>
          ) : (
            <div className="space-y-1 p-2">
              {filteredFolders.map((folder) => {
                const selected = selectedFolders.has(folder.id);
                return (
                  <div key={folder.id} className={`flex items-center gap-2 rounded-md p-2 transition-colors hover:bg-accent ${selected ? "bg-accent" : ""}`}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      aria-label={`${selected ? "Deselect" : "Select"} folder ${folder.name}`}
                      onClick={() => toggleFolder(folder)}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded p-1 text-left"
                    >
                      {selected ? <FolderOpen className="h-5 w-5 shrink-0 text-primary" /> : <Folder className="h-5 w-5 shrink-0 text-muted-foreground" />}
                      <span className="truncate text-sm font-medium">{folder.name}</span>
                      {selected && <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />}
                    </button>
                    <Button variant="ghost" size="sm" aria-label={`Open folder ${folder.name}`} onClick={() => openFolder(folder)}>
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>

        {selectedFolders.size > 0 && (
          <div className="space-y-2">
            <Label>Selected Folders ({selectedFolders.size})</Label>
            <div className="flex flex-wrap gap-2">
              {[...selectedFolders].map((folderId) => (
                <Badge key={folderId} variant="secondary" className="gap-1"><Folder className="h-3 w-3" />{selectedFolderNames.get(folderId) || folderId}</Badge>
              ))}
            </div>
          </div>
        )}

        <div className="border-t pt-4">
          <Button onClick={confirmSelection} disabled={selectedFolders.size === 0}>Confirm Selection</Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default GoogleDriveSourceSelector;
