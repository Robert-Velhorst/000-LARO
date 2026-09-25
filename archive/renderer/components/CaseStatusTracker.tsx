import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { 
  FileText, 
  Clock, 
  CheckCircle2, 
  XCircle, 
  Archive,
  MessageSquare,
  ArrowRight
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

interface CaseStatusTrackerProps {
  caseId: number;
  currentStatus: string;
}

const statusConfig = {
  draft: {
    label: "Draft",
    icon: FileText,
    color: "text-gray-500",
    bg: "bg-gray-500/10",
    description: "Case is being prepared"
  },
  active: {
    label: "Active",
    icon: Clock,
    color: "text-blue-500",
    bg: "bg-blue-500/10",
    description: "Actively searching for lawyers"
  },
  awaiting_response: {
    label: "Awaiting Response",
    icon: MessageSquare,
    color: "text-orange-500",
    bg: "bg-orange-500/10",
    description: "Waiting for lawyer responses"
  },
  in_negotiation: {
    label: "In Negotiation",
    icon: ArrowRight,
    color: "text-purple-500",
    bg: "bg-purple-500/10",
    description: "Negotiating with lawyers"
  },
  closed: {
    label: "Closed",
    icon: CheckCircle2,
    color: "text-green-500",
    bg: "bg-green-500/10",
    description: "Case successfully closed"
  },
  archived: {
    label: "Archived",
    icon: Archive,
    color: "text-gray-400",
    bg: "bg-gray-400/10",
    description: "Case archived"
  }
};

export default function CaseStatusTracker({ caseId, currentStatus }: CaseStatusTrackerProps) {
  const [open, setOpen] = useState(false);
  const [newStatus, setNewStatus] = useState(currentStatus);
  const [note, setNote] = useState("");

  const utils = trpc.useUtils();

  const { data: statusHistory = [] } = trpc.caseManagement.getStatusHistory.useQuery({
    caseId
  });

  const updateStatusMutation = trpc.caseManagement.updateStatus.useMutation({
    onSuccess: () => {
      toast.success("Case status updated successfully");
      setOpen(false);
      setNote("");
      utils.caseManagement.getStatusHistory.invalidate({ caseId });
      utils.cases.byId.invalidate();
    },
    onError: (error) => {
      toast.error(`Failed to update status: ${error.message}`);
    }
  });

  const handleUpdateStatus = () => {
    if (newStatus === currentStatus) {
      toast.info("Status unchanged");
      setOpen(false);
      return;
    }

    updateStatusMutation.mutate({
      caseId,
      newStatus: newStatus as any,
      note: note || undefined
    });
  };

  const currentConfig = statusConfig[currentStatus as keyof typeof statusConfig] || statusConfig.draft;
  const CurrentIcon = currentConfig.icon;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Case Status</CardTitle>
            <CardDescription>Track and update case progress</CardDescription>
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                Update Status
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Update Case Status</DialogTitle>
                <DialogDescription>
                  Change the current status of this case and add an optional note.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="status">New Status</Label>
                  <Select value={newStatus} onValueChange={setNewStatus}>
                    <SelectTrigger id="status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(statusConfig).map(([key, config]) => (
                        <SelectItem key={key} value={key}>
                          <div className="flex items-center gap-2">
                            <config.icon className={`h-4 w-4 ${config.color}`} />
                            {config.label}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="note">Note (Optional)</Label>
                  <Textarea
                    id="note"
                    placeholder="Add a note about this status change..."
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={3}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button 
                  onClick={handleUpdateStatus}
                  disabled={updateStatusMutation.isLoading}
                >
                  {updateStatusMutation.isLoading ? "Updating..." : "Update Status"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Current Status */}
        <div className={`p-4 rounded-lg ${currentConfig.bg} border border-border`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-full bg-background ${currentConfig.color}`}>
              <CurrentIcon className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">{currentConfig.label}</h3>
                <Badge variant="secondary" className="text-xs">
                  Current
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {currentConfig.description}
              </p>
            </div>
          </div>
        </div>

        {/* Status History */}
        {statusHistory.length > 0 && (
          <div className="space-y-3">
            <h4 className="font-medium text-sm">Status History</h4>
            <div className="space-y-2">
              {statusHistory.map((entry: any, index: number) => {
                const fromConfig = statusConfig[entry.from as keyof typeof statusConfig];
                const toConfig = statusConfig[entry.to as keyof typeof statusConfig];
                const FromIcon = fromConfig?.icon || FileText;
                const ToIcon = toConfig?.icon || FileText;

                return (
                  <div
                    key={index}
                    className="flex items-start gap-3 p-3 rounded-lg border border-border bg-card/50"
                  >
                    <div className="flex items-center gap-2 mt-1">
                      <div className={`${fromConfig?.color || 'text-gray-500'}`}>
                        <FromIcon className="h-4 w-4" />
                      </div>
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      <div className={`${toConfig?.color || 'text-gray-500'}`}>
                        <ToIcon className="h-4 w-4" />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">
                          {fromConfig?.label || entry.from} → {toConfig?.label || entry.to}
                        </span>
                      </div>
                      {entry.note && (
                        <p className="text-sm text-muted-foreground mt-1">
                          {entry.note}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground mt-1">
                        {formatDistanceToNow(new Date(entry.changedAt), { addSuffix: true })}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Status Flow Visualization */}
        <div className="space-y-3">
          <h4 className="font-medium text-sm">Typical Status Flow</h4>
          <div className="flex items-center gap-2 flex-wrap">
            {Object.entries(statusConfig).slice(0, 5).map(([key, config], index) => {
              const Icon = config.icon;
              const isCurrent = key === currentStatus;
              
              return (
                <div key={key} className="flex items-center gap-2">
                  <div
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${
                      isCurrent
                        ? `${config.bg} border-primary`
                        : 'border-border bg-card/30'
                    }`}
                  >
                    <Icon className={`h-4 w-4 ${isCurrent ? config.color : 'text-muted-foreground'}`} />
                    <span className={`text-xs font-medium ${isCurrent ? '' : 'text-muted-foreground'}`}>
                      {config.label}
                    </span>
                  </div>
                  {index < 4 && (
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

