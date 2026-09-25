import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";
import {
  MoreHorizontal,
  Archive,
  Trash2,
  Download,
  Mail,
  CheckCircle2,
  XCircle,
  FolderOpen
} from "lucide-react";

interface BulkCaseActionsProps {
  selectedCases: string[];
  onSelectionChange: (caseIds: string[]) => void;
  onActionComplete: () => void;
}

export default function BulkCaseActions({
  selectedCases,
  onSelectionChange,
  onActionComplete
}: BulkCaseActionsProps) {
  const [confirmAction, setConfirmAction] = useState<{
    type: string;
    title: string;
    description: string;
  } | null>(null);

  const utils = trpc.useUtils();

  const updateStatusMutation = trpc.caseManagement.updateStatus.useMutation({
    onSuccess: () => {
      utils.cases.list.invalidate();
      toast.success("Cases updated successfully");
      onSelectionChange([]);
      onActionComplete();
    },
    onError: (error) => {
      toast.error(`Failed to update cases: ${error.message}`);
    }
  });

  const exportMutation = trpc.caseManagement.exportCase.useMutation({
    onSuccess: (data) => {
      // Download the markdown file
      const blob = new Blob([data.markdown], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = data.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Case exported successfully");
    },
    onError: (error) => {
      toast.error(`Export failed: ${error.message}`);
    }
  });

  const handleBulkAction = async (action: string) => {
    if (selectedCases.length === 0) {
      toast.error("No cases selected");
      return;
    }

    switch (action) {
      case "archive":
        setConfirmAction({
          type: "archive",
          title: "Archive Cases",
          description: `Are you sure you want to archive ${selectedCases.length} case(s)? They will be moved to archived status.`
        });
        break;

      case "close":
        setConfirmAction({
          type: "close",
          title: "Close Cases",
          description: `Are you sure you want to close ${selectedCases.length} case(s)? This action can be reversed later.`
        });
        break;

      case "delete":
        setConfirmAction({
          type: "delete",
          title: "Delete Cases",
          description: `Are you sure you want to delete ${selectedCases.length} case(s)? This action cannot be undone.`
        });
        break;

      case "export":
        // Export all selected cases
        for (const caseId of selectedCases) {
          await exportMutation.mutateAsync({ caseId: parseInt(caseId) });
        }
        break;

      case "activate":
        for (const caseId of selectedCases) {
          await updateStatusMutation.mutateAsync({
            caseId: parseInt(caseId),
            newStatus: "active",
            note: "Bulk activation"
          });
        }
        break;

      default:
        toast.error("Unknown action");
    }
  };

  const confirmBulkAction = async () => {
    if (!confirmAction) return;

    try {
      switch (confirmAction.type) {
        case "archive":
          for (const caseId of selectedCases) {
            await updateStatusMutation.mutateAsync({
              caseId: parseInt(caseId),
              newStatus: "archived",
              note: "Bulk archive"
            });
          }
          break;

        case "close":
          for (const caseId of selectedCases) {
            await updateStatusMutation.mutateAsync({
              caseId: parseInt(caseId),
              newStatus: "closed",
              note: "Bulk closure"
            });
          }
          break;

        case "delete":
          // Note: You'll need to add a delete mutation to your backend
          toast.info("Delete functionality requires backend implementation");
          break;
      }
    } catch (error) {
      console.error("Bulk action failed:", error);
    } finally {
      setConfirmAction(null);
    }
  };

  if (selectedCases.length === 0) {
    return null;
  }

  return (
    <>
      <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50">
        <div className="bg-card border border-border rounded-lg shadow-lg p-4 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Checkbox
              checked={true}
              onCheckedChange={() => onSelectionChange([])}
            />
            <span className="font-medium">
              {selectedCases.length} case{selectedCases.length !== 1 ? 's' : ''} selected
            </span>
          </div>

          <div className="h-6 w-px bg-border" />

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleBulkAction("activate")}
              disabled={updateStatusMutation.isPending}
            >
              <CheckCircle2 className="h-4 w-4 mr-2" />
              Activate
            </Button>

            <Button
              size="sm"
              variant="outline"
              onClick={() => handleBulkAction("close")}
              disabled={updateStatusMutation.isPending}
            >
              <XCircle className="h-4 w-4 mr-2" />
              Close
            </Button>

            <Button
              size="sm"
              variant="outline"
              onClick={() => handleBulkAction("export")}
              disabled={exportMutation.isPending}
            >
              <Download className="h-4 w-4 mr-2" />
              Export
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>More Actions</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => handleBulkAction("archive")}>
                  <Archive className="h-4 w-4 mr-2" />
                  Archive Cases
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleBulkAction("delete")} className="text-red-600">
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Cases
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              size="sm"
              variant="ghost"
              onClick={() => onSelectionChange([])}
            >
              Cancel
            </Button>
          </div>
        </div>
      </div>

      <AlertDialog open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAction?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmBulkAction}>
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

