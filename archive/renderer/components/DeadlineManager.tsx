import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertCircle,
  Calendar as CalendarIcon,
  CheckCircle2,
  Clock,
  Plus,
  AlertTriangle
} from "lucide-react";
import { format, formatDistanceToNow, isPast, differenceInDays } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface DeadlineManagerProps {
  caseId: number;
}

const priorityConfig = {
  low: {
    label: "Low",
    color: "text-blue-500",
    bg: "bg-blue-500/10",
    icon: Clock
  },
  medium: {
    label: "Medium",
    color: "text-yellow-500",
    bg: "bg-yellow-500/10",
    icon: AlertCircle
  },
  high: {
    label: "High",
    color: "text-orange-500",
    bg: "bg-orange-500/10",
    icon: AlertTriangle
  },
  critical: {
    label: "Critical",
    color: "text-red-500",
    bg: "bg-red-500/10",
    icon: AlertTriangle
  }
};

export default function DeadlineManager({ caseId }: DeadlineManagerProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState<Date>();
  const [priority, setPriority] = useState<"low" | "medium" | "high" | "critical">("medium");

  const utils = trpc.useUtils();

  const { data: deadlines = [], isLoading } = trpc.caseManagement.getUpcomingDeadlines.useQuery({
    caseId
  });

  const addDeadlineMutation = trpc.caseManagement.addDeadline.useMutation({
    onSuccess: () => {
      toast.success("Deadline added successfully");
      setOpen(false);
      resetForm();
      utils.caseManagement.getUpcomingDeadlines.invalidate({ caseId });
    },
    onError: (error) => {
      toast.error(`Failed to add deadline: ${error.message}`);
    }
  });

  const completeDeadlineMutation = trpc.caseManagement.completeDeadline.useMutation({
    onSuccess: () => {
      toast.success("Deadline marked as complete");
      utils.caseManagement.getUpcomingDeadlines.invalidate({ caseId });
    },
    onError: (error) => {
      toast.error(`Failed to complete deadline: ${error.message}`);
    }
  });

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setDueDate(undefined);
    setPriority("medium");
  };

  const handleAddDeadline = () => {
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (!dueDate) {
      toast.error("Due date is required");
      return;
    }

    addDeadlineMutation.mutate({
      caseId,
      title,
      description: description || undefined,
      dueDate,
      priority
    });
  };

  const handleCompleteDeadline = (deadlineId: number) => {
    completeDeadlineMutation.mutate({
      caseId: String(caseId),
      deadlineId: String(deadlineId),
    });
  };

  const getDeadlineStatus = (deadline: any) => {
    if (deadline.completed) return "completed";
    const daysUntil = differenceInDays(new Date(deadline.dueDate), new Date());
    if (daysUntil < 0) return "overdue";
    if (daysUntil <= 3) return "urgent";
    if (daysUntil <= 7) return "upcoming";
    return "future";
  };

  const activeDeadlines = deadlines.filter((d: any) => !d.completed);
  const completedDeadlines = deadlines.filter((d: any) => d.completed);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Deadlines</CardTitle>
          <CardDescription>Loading deadlines...</CardDescription>
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
            <CardTitle>Deadlines</CardTitle>
            <CardDescription>
              {activeDeadlines.length} active deadline{activeDeadlines.length !== 1 ? 's' : ''}
            </CardDescription>
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-2" />
                Add Deadline
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add Deadline</DialogTitle>
                <DialogDescription>
                  Create a new deadline for this case
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="title">Title *</Label>
                  <Input
                    id="title"
                    placeholder="e.g., Submit evidence to court"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Description (Optional)</Label>
                  <Textarea
                    id="description"
                    placeholder="Additional details..."
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Due Date *</Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          className={cn(
                            "w-full justify-start text-left font-normal",
                            !dueDate && "text-muted-foreground"
                          )}
                        >
                          <CalendarIcon className="mr-2 h-4 w-4" />
                          {dueDate ? format(dueDate, "PPP") : "Pick a date"}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0">
                        <Calendar
                          mode="single"
                          selected={dueDate}
                          onSelect={setDueDate}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="priority">Priority</Label>
                    <Select value={priority} onValueChange={(v: any) => setPriority(v)}>
                      <SelectTrigger id="priority">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(priorityConfig).map(([key, config]) => {
                          const Icon = config.icon;
                          return (
                            <SelectItem key={key} value={key}>
                              <div className="flex items-center gap-2">
                                <Icon className={`h-4 w-4 ${config.color}`} />
                                {config.label}
                              </div>
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button 
                  onClick={handleAddDeadline}
                  disabled={addDeadlineMutation.isLoading}
                >
                  {addDeadlineMutation.isLoading ? "Adding..." : "Add Deadline"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Active Deadlines */}
        {activeDeadlines.length > 0 && (
          <div className="space-y-3">
            <h4 className="font-medium text-sm">Active Deadlines</h4>
            <div className="space-y-2">
              {activeDeadlines.map((deadline: any) => {
                const status = getDeadlineStatus(deadline);
                const config = priorityConfig[deadline.priority as keyof typeof priorityConfig];
                const Icon = config.icon;
                const daysUntil = differenceInDays(new Date(deadline.dueDate), new Date());

                return (
                  <div
                    key={deadline.id}
                    className={cn(
                      "flex items-start gap-3 p-4 rounded-lg border transition-all",
                      status === "overdue" && "border-red-500 bg-red-500/5",
                      status === "urgent" && "border-orange-500 bg-orange-500/5",
                      status === "upcoming" && "border-yellow-500 bg-yellow-500/5",
                      status === "future" && "border-border bg-card"
                    )}
                  >
                    <div className={`p-2 rounded-full bg-background border ${config.color}`}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <h5 className="font-medium">{deadline.title}</h5>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleCompleteDeadline(deadline.id)}
                          disabled={completeDeadlineMutation.isLoading}
                        >
                          <CheckCircle2 className="h-4 w-4" />
                        </Button>
                      </div>
                      {deadline.description && (
                        <p className="text-sm text-muted-foreground mb-2">
                          {deadline.description}
                        </p>
                      )}
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant={status === "overdue" ? "destructive" : "secondary"} className="text-xs">
                          {config.label}
                        </Badge>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <CalendarIcon className="h-3 w-3" />
                          {format(new Date(deadline.dueDate), "PPP")}
                        </div>
                        {status === "overdue" && (
                          <Badge variant="destructive" className="text-xs">
                            Overdue by {Math.abs(daysUntil)} day{Math.abs(daysUntil) !== 1 ? 's' : ''}
                          </Badge>
                        )}
                        {status === "urgent" && (
                          <Badge variant="destructive" className="text-xs">
                            Due in {daysUntil} day{daysUntil !== 1 ? 's' : ''}
                          </Badge>
                        )}
                        {status === "upcoming" && (
                          <Badge className="text-xs bg-yellow-500/10 text-yellow-700 dark:text-yellow-400">
                            Due in {daysUntil} days
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Completed Deadlines */}
        {completedDeadlines.length > 0 && (
          <div className="space-y-3">
            <h4 className="font-medium text-sm text-muted-foreground">
              Completed ({completedDeadlines.length})
            </h4>
            <div className="space-y-2">
              {completedDeadlines.map((deadline: any) => {
                const config = priorityConfig[deadline.priority as keyof typeof priorityConfig];

                return (
                  <div
                    key={deadline.id}
                    className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card/50 opacity-60"
                  >
                    <CheckCircle2 className="h-5 w-5 text-green-500" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm line-through">{deadline.title}</p>
                      <p className="text-xs text-muted-foreground">
                        Completed {formatDistanceToNow(new Date(deadline.completedAt), { addSuffix: true })}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Empty State */}
        {deadlines.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <CalendarIcon className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No deadlines set</p>
            <p className="text-sm text-muted-foreground mt-2">
              Add deadlines to track important dates
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

