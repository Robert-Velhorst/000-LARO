/**
 * Batch Operations Component
 * 
 * Perform bulk actions on selected items (cases, lawyers, etc.)
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { 
  CheckSquare, 
  Square, 
  Trash2, 
  Archive, 
  Mail, 
  Download,
  RefreshCw,
  MoreHorizontal
} from "lucide-react";

interface BatchOperationsProps {
  selectedIds: string[];
  totalCount: number;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onDelete?: (ids: string[]) => Promise<void>;
  onArchive?: (ids: string[]) => Promise<void>;
  onExport?: (ids: string[]) => void;
  onEmail?: (ids: string[]) => void;
  onRefresh?: (ids: string[]) => Promise<void>;
  entityType?: string; // "cases", "lawyers", etc.
}

export default function BatchOperations({
  selectedIds,
  totalCount,
  onSelectAll,
  onDeselectAll,
  onDelete,
  onArchive,
  onExport,
  onEmail,
  onRefresh,
  entityType = "items"
}: BatchOperationsProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const hasSelection = selectedIds.length > 0;
  const allSelected = selectedIds.length === totalCount && totalCount > 0;

  const handleDelete = async () => {
    if (!onDelete) return;
    setIsProcessing(true);
    try {
      await onDelete(selectedIds);
      setShowDeleteDialog(false);
      onDeselectAll();
    } catch (error) {
      console.error("Batch delete failed:", error);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleArchive = async () => {
    if (!onArchive) return;
    setIsProcessing(true);
    try {
      await onArchive(selectedIds);
      setShowArchiveDialog(false);
      onDeselectAll();
    } catch (error) {
      console.error("Batch archive failed:", error);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRefresh = async () => {
    if (!onRefresh) return;
    setIsProcessing(true);
    try {
      await onRefresh(selectedIds);
    } catch (error) {
      console.error("Batch refresh failed:", error);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-3 p-4 bg-card/50 border border-border/50 rounded-lg backdrop-blur-sm">
        {/* Selection Toggle */}
        <Button
          variant="ghost"
          size="sm"
          onClick={allSelected ? onDeselectAll : onSelectAll}
          className="gap-2"
        >
          {allSelected ? (
            <CheckSquare className="w-4 h-4 text-orange-500" />
          ) : (
            <Square className="w-4 h-4" />
          )}
          <span className="text-sm">
            {allSelected ? "Deselect All" : "Select All"}
          </span>
        </Button>

        {/* Selection Count */}
        {hasSelection && (
          <>
            <Badge variant="secondary" className="text-sm">
              {selectedIds.length} {entityType} selected
            </Badge>

            {/* Quick Actions */}
            <div className="flex items-center gap-2 ml-auto">
              {onExport && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onExport(selectedIds)}
                  disabled={isProcessing}
                  className="gap-2"
                >
                  <Download className="w-4 h-4" />
                  Export
                </Button>
              )}

              {onEmail && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onEmail(selectedIds)}
                  disabled={isProcessing}
                  className="gap-2"
                >
                  <Mail className="w-4 h-4" />
                  Email
                </Button>
              )}

              {onRefresh && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRefresh}
                  disabled={isProcessing}
                  className="gap-2"
                >
                  <RefreshCw className={`w-4 h-4 ${isProcessing ? 'animate-spin' : ''}`} />
                  Refresh
                </Button>
              )}

              {/* More Actions Dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={isProcessing}>
                    <MoreHorizontal className="w-4 h-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {onArchive && (
                    <>
                      <DropdownMenuItem onClick={() => setShowArchiveDialog(true)}>
                        <Archive className="w-4 h-4 mr-2" />
                        Archive Selected
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  {onDelete && (
                    <DropdownMenuItem 
                      onClick={() => setShowDeleteDialog(true)}
                      className="text-red-500 focus:text-red-500"
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Delete Selected
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.length} {entityType}?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the selected {entityType} 
              and remove their data from the system.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isProcessing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isProcessing}
              className="bg-red-500 hover:bg-red-600"
            >
              {isProcessing ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Archive Confirmation Dialog */}
      <AlertDialog open={showArchiveDialog} onOpenChange={setShowArchiveDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {selectedIds.length} {entityType}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will move the selected {entityType} to the archive. You can restore them later if needed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isProcessing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleArchive}
              disabled={isProcessing}
              className="bg-orange-500 hover:bg-orange-600"
            >
              {isProcessing ? "Archiving..." : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

