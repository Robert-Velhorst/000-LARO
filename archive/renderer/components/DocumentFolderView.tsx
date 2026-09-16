import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Folder,
  FolderOpen,
  FileText,
  File,
  Image,
  FileSpreadsheet,
  Mail,
  Download,
  Move,
  ChevronRight
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

interface DocumentFolderViewProps {
  caseId: number;
}

const folderIcons = {
  "Contracts": Folder,
  "Correspondence": Mail,
  "Termination Documents": FileText,
  "Financial Records": FileSpreadsheet,
  "Other": File
};

const getFileIcon = (filename: string) => {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext || '')) return Image;
  if (['xls', 'xlsx', 'csv'].includes(ext || '')) return FileSpreadsheet;
  if (['pdf', 'doc', 'docx'].includes(ext || '')) return FileText;
  return File;
};

export default function DocumentFolderView({ caseId }: DocumentFolderViewProps) {
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [movingDocId, setMovingDocId] = useState<number | null>(null);

  const utils = trpc.useUtils();

  const { data: documentsByFolder = {}, isLoading } = trpc.caseManagement.getDocumentsByFolder.useQuery({
    caseId
  });

  const moveDocumentMutation = trpc.caseManagement.organizeDocument.useMutation({
    onSuccess: () => {
      toast.success("Document moved successfully");
      setMovingDocId(null);
      utils.caseManagement.getDocumentsByFolder.invalidate({ caseId });
    },
    onError: (error) => {
      toast.error(`Failed to move document: ${error.message}`);
    }
  });

  const handleMoveDocument = (documentId: number, newFolder: string) => {
    moveDocumentMutation.mutate({
      caseId,
      documentId,
      folder: newFolder
    });
  };

  const folders = Object.keys(documentsByFolder);
  const totalDocuments = Object.values(documentsByFolder).reduce(
    (sum: number, docs: any) => sum + docs.length,
    0
  );

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Documents</CardTitle>
          <CardDescription>Loading documents...</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Documents</CardTitle>
            <CardDescription>
              {totalDocuments} document{totalDocuments !== 1 ? 's' : ''} organized in {folders.length} folder{folders.length !== 1 ? 's' : ''}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setSelectedFolder(null)}>
            View All
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Folder List */}
          <div className="md:col-span-1 space-y-2">
            <h4 className="font-medium text-sm mb-3">Folders</h4>
            {folders.map((folder) => {
              const FolderIcon = folderIcons[folder as keyof typeof folderIcons] || Folder;
              const docs = documentsByFolder[folder] || [];
              const isSelected = selectedFolder === folder;

              return (
                <button
                  key={folder}
                  onClick={() => setSelectedFolder(folder)}
                  className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all ${
                    isSelected
                      ? 'bg-primary/10 border-primary'
                      : 'bg-card border-border hover:bg-accent'
                  }`}
                >
                  <FolderIcon className={`h-5 w-5 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                  <div className="flex-1 text-left">
                    <p className={`text-sm font-medium ${isSelected ? 'text-primary' : ''}`}>
                      {folder}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {docs.length} file{docs.length !== 1 ? 's' : ''}
                    </p>
                  </div>
                  {isSelected && <ChevronRight className="h-4 w-4 text-primary" />}
                </button>
              );
            })}
          </div>

          {/* Document List */}
          <div className="md:col-span-3">
            <ScrollArea className="h-[500px]">
              {selectedFolder ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 mb-4">
                    <FolderOpen className="h-5 w-5 text-primary" />
                    <h4 className="font-medium">{selectedFolder}</h4>
                    <Badge variant="secondary">
                      {documentsByFolder[selectedFolder]?.length || 0} files
                    </Badge>
                  </div>
                  {(documentsByFolder[selectedFolder] || []).map((doc: any) => {
                    const FileIcon = getFileIcon(doc.fileName || '');
                    const isMoving = movingDocId === doc.id;

                    return (
                      <div
                        key={doc.id}
                        className="flex items-center gap-3 p-4 rounded-lg border border-border bg-card hover:bg-accent transition-all"
                      >
                        <FileIcon className="h-8 w-8 text-primary" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">{doc.fileName}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <Badge variant="outline" className="text-xs">
                              {doc.fileType || 'Unknown'}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {formatDistanceToNow(new Date(doc.uploadedAt), { addSuffix: true })}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {isMoving ? (
                            <Select
                              value={selectedFolder}
                              onValueChange={(newFolder) => handleMoveDocument(doc.id, newFolder)}
                            >
                              <SelectTrigger className="w-[180px]">
                                <SelectValue placeholder="Move to..." />
                              </SelectTrigger>
                              <SelectContent>
                                {folders.filter(f => f !== selectedFolder).map((folder) => (
                                  <SelectItem key={folder} value={folder}>
                                    {folder}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setMovingDocId(doc.id)}
                            >
                              <Move className="h-4 w-4" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => window.open(doc.fileUrl, '_blank')}
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                  {(documentsByFolder[selectedFolder] || []).length === 0 && (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <Folder className="h-12 w-12 text-muted-foreground mb-4" />
                      <p className="text-muted-foreground">No documents in this folder</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  {folders.map((folder) => {
                    const FolderIcon = folderIcons[folder as keyof typeof folderIcons] || Folder;
                    const docs = documentsByFolder[folder] || [];

                    if (docs.length === 0) return null;

                    return (
                      <div key={folder} className="space-y-2">
                        <button
                          onClick={() => setSelectedFolder(folder)}
                          className="flex items-center gap-2 hover:text-primary transition-colors"
                        >
                          <FolderIcon className="h-5 w-5" />
                          <h4 className="font-medium">{folder}</h4>
                          <Badge variant="secondary">{docs.length}</Badge>
                          <ChevronRight className="h-4 w-4 ml-auto" />
                        </button>
                        <div className="grid grid-cols-1 gap-2 pl-7">
                          {docs.slice(0, 3).map((doc: any) => {
                            const FileIcon = getFileIcon(doc.fileName || '');
                            return (
                              <div
                                key={doc.id}
                                className="flex items-center gap-2 p-2 rounded border border-border bg-card/50 text-sm"
                              >
                                <FileIcon className="h-4 w-4 text-muted-foreground" />
                                <span className="truncate flex-1">{doc.fileName}</span>
                              </div>
                            );
                          })}
                          {docs.length > 3 && (
                            <button
                              onClick={() => setSelectedFolder(folder)}
                              className="text-sm text-primary hover:underline text-left pl-6"
                            >
                              +{docs.length - 3} more files
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

