/**
 * Bulk File Operations Component
 * Displays uploaded files with checkboxes for bulk operations
 */

import React, { useState, useEffect } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import FilePreviewModal from '@/components/FilePreviewModal';
import {
  Trash2,
  Tag,
  Star,
  CheckSquare,
  Square,
  FileText,
  Image as ImageIcon,
  Music,
  Video,
  Archive,
  Loader2,
} from 'lucide-react';

interface BulkFileOperationsProps {
  caseId: string;
  onOperationComplete?: () => void;
}

interface FileItem {
  id: string;
  fileName: string;
  fileSize: string;
  itemType: string;
  relevanceScore: string;
  tags: string;
  timestamp: Date;
  fileUrl: string;
}

export default function BulkFileOperations({ caseId, onOperationComplete }: BulkFileOperationsProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [newTags, setNewTags] = useState('');
  const [relevanceScore, setRelevanceScore] = useState('50');
  const [showTagInput, setShowTagInput] = useState(false);
  const [showScoreInput, setShowScoreInput] = useState(false);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  // Fetch case items
  const { data: itemsData, isLoading, refetch } = trpc.bulkFileOperations.getCaseItems.useQuery({
    caseId,
  });

  const items: FileItem[] = (itemsData || []).map((item: any) => ({
    id: item.id,
    fileName: item.fileName || item.title || "Untitled evidence",
    fileSize: item.size || "",
    itemType: item.type || item.sourceType || "document",
    relevanceScore: String(item.relevanceScore ?? 0),
    tags: item.tags || "[]",
    timestamp: item.timestamp || item.uploadedAt || item.createdAt || new Date(),
    fileUrl: "",
  }));

  // Mutations
  const deleteMutation = trpc.bulkFileOperations.deleteItems.useMutation();
  const addTagsMutation = trpc.bulkFileOperations.addTags.useMutation();
  const setScoreMutation = trpc.bulkFileOperations.setRelevanceScore.useMutation();

  /**
   * Toggle item selection
   */
  const toggleSelection = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  /**
   * Select all items
   */
  const selectAll = () => {
    setSelectedIds(new Set(items.map((item) => item.id)));
  };

  /**
   * Deselect all items
   */
  const deselectAll = () => {
    setSelectedIds(new Set());
  };

  /**
   * Handle bulk delete
   */
  const handleDelete = async () => {
    if (selectedIds.size === 0) {
      toast.error('Please select at least one file');
      return;
    }

    if (!confirm(`Delete ${selectedIds.size} file(s)? This cannot be undone.`)) {
      return;
    }

    try {
      const result = await deleteMutation.mutateAsync({
        ids: Array.from(selectedIds),
      });

      if (result.deleted > 0) {
        toast.success(`Deleted ${result.deleted} file(s)`);
        setSelectedIds(new Set());
        await refetch();
        if (onOperationComplete) {
          onOperationComplete();
        }
      } else {
        toast.error("No selected files were deleted");
      }
    } catch (error) {
      toast.error('Failed to delete files');
    }
  };

  /**
   * Handle bulk add tags
   */
  const handleAddTags = async () => {
    if (selectedIds.size === 0) {
      toast.error('Please select at least one file');
      return;
    }

    if (!newTags.trim()) {
      toast.error('Please enter at least one tag');
      return;
    }

    try {
      const tags = newTags
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);

      const result = await addTagsMutation.mutateAsync({
        ids: Array.from(selectedIds),
        tags,
      });

      if (result.updated > 0) {
        toast.success(`Tagged ${result.updated} file(s)`);
        setNewTags('');
        setShowTagInput(false);
        await refetch();
      } else {
        toast.error("No selected files were tagged");
      }
    } catch (error) {
      toast.error('Failed to tag files');
    }
  };

  /**
   * Handle bulk set relevance score
   */
  const handleSetScore = async () => {
    if (selectedIds.size === 0) {
      toast.error('Please select at least one file');
      return;
    }

    try {
      const score = parseInt(relevanceScore);
      if (isNaN(score) || score < 0 || score > 100) {
        toast.error('Score must be between 0 and 100');
        return;
      }

      const result = await setScoreMutation.mutateAsync({
        ids: Array.from(selectedIds),
        score,
      });

      if (result.updated > 0) {
        toast.success(`Set relevance score to ${score} for ${result.updated} file(s)`);
        setShowScoreInput(false);
        await refetch();
      } else {
        toast.error("No selected files were updated");
      }
    } catch (error) {
      toast.error('Failed to set relevance score');
    }
  };

  /**
   * Get file icon based on type
   */
  const getFileIcon = (itemType: string) => {
    switch (itemType) {
      case 'Image':
        return <ImageIcon className="w-4 h-4" />;
      case 'Video':
        return <Video className="w-4 h-4" />;
      case 'Audio':
        return <Music className="w-4 h-4" />;
      case 'Document':
        return <FileText className="w-4 h-4" />;
      default:
        return <FileText className="w-4 h-4" />;
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Action Toolbar */}
      {items.length > 0 && (
        <Card className="bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800">
          <CardContent className="pt-6">
            <div className="space-y-4">
              {/* Selection Summary */}
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">
                  {selectedIds.size > 0 ? (
                    <span>
                      {selectedIds.size} of {items.length} file(s) selected
                    </span>
                  ) : (
                    <span>{items.length} file(s) available</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={selectAll}
                    className="text-xs"
                  >
                    Select All
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={deselectAll}
                    className="text-xs"
                  >
                    Deselect All
                  </Button>
                </div>
              </div>

              {/* Action Buttons */}
              {selectedIds.size > 0 && (
                <div className="flex flex-wrap gap-2">
                  {/* Delete Button */}
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={handleDelete}
                    disabled={deleteMutation.isPending}
                    className="gap-2"
                  >
                    {deleteMutation.isPending ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Deleting...
                      </>
                    ) : (
                      <>
                        <Trash2 className="w-4 h-4" />
                        Delete ({selectedIds.size})
                      </>
                    )}
                  </Button>

                  {/* Tag Button */}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowTagInput(!showTagInput)}
                    className="gap-2"
                  >
                    <Tag className="w-4 h-4" />
                    Add Tags
                  </Button>

                  {/* Relevance Score Button */}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowScoreInput(!showScoreInput)}
                    className="gap-2"
                  >
                    <Star className="w-4 h-4" />
                    Set Score
                  </Button>
                </div>
              )}

              {/* Tag Input */}
              {showTagInput && (
                <div className="space-y-2 p-3 bg-white dark:bg-gray-900 rounded border">
                  <Label htmlFor="tags" className="text-sm">
                    Tags (comma-separated)
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="tags"
                      placeholder="e.g., important, contract, evidence"
                      value={newTags}
                      onChange={(e) => setNewTags(e.target.value)}
                      className="text-sm"
                    />
                    <Button
                      size="sm"
                      onClick={handleAddTags}
                      disabled={addTagsMutation.isPending}
                    >
                      {addTagsMutation.isPending ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        'Add'
                      )}
                    </Button>
                  </div>
                </div>
              )}

              {/* Relevance Score Input */}
              {showScoreInput && (
                <div className="space-y-2 p-3 bg-white dark:bg-gray-900 rounded border">
                  <Label htmlFor="score" className="text-sm">
                    Relevance Score (0-100)
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="score"
                      type="number"
                      min="0"
                      max="100"
                      value={relevanceScore}
                      onChange={(e) => setRelevanceScore(e.target.value)}
                      className="text-sm"
                    />
                    <Button
                      size="sm"
                      onClick={handleSetScore}
                      disabled={setScoreMutation.isPending}
                    >
                      {setScoreMutation.isPending ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        'Set'
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Files List */}
      <div className="space-y-2">
        {items.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <p className="text-muted-foreground">No files uploaded yet</p>
            </CardContent>
          </Card>
        ) : (
          items.map((item) => (
            <Card
              key={item.id}
              className={`transition-all ${
                selectedIds.has(item.id)
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
                  : 'hover:border-gray-400'
              }`}
            >
              <CardContent className="p-4">
                <div className="flex items-center gap-4">
                  {/* Checkbox */}
                  <Checkbox
                    checked={selectedIds.has(item.id)}
                    onCheckedChange={() => toggleSelection(item.id)}
                    className="mt-1"
                  />

                  {/* File Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {getFileIcon(item.itemType)}
                      <p className="font-medium truncate">{item.fileName}</p>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 space-y-1">
                      <p>
                        Size: {(parseInt(item.fileSize) / 1024).toFixed(2)} KB • Type:{' '}
                        {item.itemType}
                      </p>
                      <p>
                        Relevance: <span className="font-semibold">{item.relevanceScore}%</span>
                      </p>
                      {item.tags && item.tags !== '[]' && (
                        <p>
                          Tags:{' '}
                          {JSON.parse(item.tags)
                            .join(', ')
                            .substring(0, 50)}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Quick Actions */}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setPreviewFile(item);
                        setShowPreview(true);
                      }}
                    >
                      Preview
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* File Preview Modal */}
      <FilePreviewModal
        isOpen={showPreview}
        onClose={() => {
          setShowPreview(false);
          setPreviewFile(null);
        }}
        file={previewFile || undefined}
        caseId={caseId}
      />
    </div>
  );
}
