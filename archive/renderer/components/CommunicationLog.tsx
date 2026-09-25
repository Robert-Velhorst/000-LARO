import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  Mail,
  Phone,
  Video,
  FileText,
  Plus,
  ArrowDownRight,
  ArrowUpRight,
  Clock
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { toast } from "sonner";

interface CommunicationLogProps {
  caseId: number;
}

const communicationIcons = {
  email: Mail,
  phone: Phone,
  meeting: Video,
  note: FileText
};

const communicationColors = {
  email: "text-blue-500",
  phone: "text-green-500",
  meeting: "text-purple-500",
  note: "text-orange-500"
};

export default function CommunicationLog({ caseId }: CommunicationLogProps) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"email" | "phone" | "meeting" | "note">("note");
  const [direction, setDirection] = useState<"inbound" | "outbound">("outbound");
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [participants, setParticipants] = useState("");

  const utils = trpc.useUtils();

  const { data: communications = [], isLoading } = trpc.caseManagement.getCommunicationHistory.useQuery({
    caseId
  });

  const addCommunicationMutation = trpc.caseManagement.addCommunication.useMutation({
    onSuccess: () => {
      toast.success("Communication logged successfully");
      setOpen(false);
      resetForm();
      utils.caseManagement.getCommunicationHistory.invalidate({ caseId });
    },
    onError: (error) => {
      toast.error(`Failed to log communication: ${error.message}`);
    }
  });

  const resetForm = () => {
    setType("note");
    setDirection("outbound");
    setSubject("");
    setContent("");
    setParticipants("");
  };

  const handleAddCommunication = () => {
    if (!content.trim()) {
      toast.error("Content is required");
      return;
    }

    const participantList = participants
      .split(',')
      .map(p => p.trim())
      .filter(p => p.length > 0);

    addCommunicationMutation.mutate({
      caseId,
      type,
      direction,
      subject: subject || undefined,
      content,
      participants: participantList,
      timestamp: new Date()
    });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Communication History</CardTitle>
          <CardDescription>Loading communications...</CardDescription>
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
            <CardTitle>Communication History</CardTitle>
            <CardDescription>
              {communications.length} communication{communications.length !== 1 ? 's' : ''} logged
            </CardDescription>
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-2" />
                Log Communication
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Log Communication</DialogTitle>
                <DialogDescription>
                  Record a communication related to this case
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="type">Type</Label>
                    <Select value={type} onValueChange={(v: any) => setType(v)}>
                      <SelectTrigger id="type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="email">
                          <div className="flex items-center gap-2">
                            <Mail className="h-4 w-4" />
                            Email
                          </div>
                        </SelectItem>
                        <SelectItem value="phone">
                          <div className="flex items-center gap-2">
                            <Phone className="h-4 w-4" />
                            Phone Call
                          </div>
                        </SelectItem>
                        <SelectItem value="meeting">
                          <div className="flex items-center gap-2">
                            <Video className="h-4 w-4" />
                            Meeting
                          </div>
                        </SelectItem>
                        <SelectItem value="note">
                          <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4" />
                            Note
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="direction">Direction</Label>
                    <Select value={direction} onValueChange={(v: any) => setDirection(v)}>
                      <SelectTrigger id="direction">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="outbound">
                          <div className="flex items-center gap-2">
                            <ArrowUpRight className="h-4 w-4" />
                            Outbound
                          </div>
                        </SelectItem>
                        <SelectItem value="inbound">
                          <div className="flex items-center gap-2">
                            <ArrowDownRight className="h-4 w-4" />
                            Inbound
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="subject">Subject (Optional)</Label>
                  <Input
                    id="subject"
                    placeholder="e.g., Follow-up on case details"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="participants">Participants</Label>
                  <Input
                    id="participants"
                    placeholder="e.g., John Doe, Jane Smith (comma-separated)"
                    value={participants}
                    onChange={(e) => setParticipants(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="content">Content *</Label>
                  <Textarea
                    id="content"
                    placeholder="Describe the communication..."
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    rows={5}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button 
                  onClick={handleAddCommunication}
                  disabled={addCommunicationMutation.isLoading}
                >
                  {addCommunicationMutation.isLoading ? "Logging..." : "Log Communication"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[500px]">
          {communications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Mail className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground">No communications logged yet</p>
              <p className="text-sm text-muted-foreground mt-2">
                Start logging emails, calls, and meetings
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {communications.map((comm: any, index: number) => {
                const Icon = communicationIcons[comm.type as keyof typeof communicationIcons] || FileText;
                const color = communicationColors[comm.type as keyof typeof communicationColors] || "text-gray-500";
                const DirectionIcon = comm.direction === "inbound" ? ArrowDownRight : ArrowUpRight;

                return (
                  <div
                    key={comm.id || index}
                    className="flex gap-4 p-4 rounded-lg border border-border bg-card hover:bg-accent transition-all"
                  >
                    {/* Icon & Timeline */}
                    <div className="flex flex-col items-center gap-2">
                      <div className={`p-2 rounded-full bg-background border border-border ${color}`}>
                        <Icon className="h-5 w-5" />
                      </div>
                      {index < communications.length - 1 && (
                        <div className="w-px h-full bg-border" />
                      )}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="text-xs">
                            {comm.type}
                          </Badge>
                          <div className="flex items-center gap-1">
                            <DirectionIcon className="h-3 w-3 text-muted-foreground" />
                            <span className="text-xs text-muted-foreground">
                              {comm.direction}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {formatDistanceToNow(new Date(comm.timestamp), { addSuffix: true })}
                        </div>
                      </div>

                      {comm.subject && (
                        <h4 className="font-medium text-sm mb-2">{comm.subject}</h4>
                      )}

                      <p className="text-sm text-muted-foreground mb-2 whitespace-pre-wrap">
                        {comm.content}
                      </p>

                      {comm.participants && comm.participants.length > 0 && (
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-muted-foreground">Participants:</span>
                          {comm.participants.map((participant: string, i: number) => (
                            <Badge key={i} variant="outline" className="text-xs">
                              {participant}
                            </Badge>
                          ))}
                        </div>
                      )}

                      <div className="text-xs text-muted-foreground mt-2">
                        {format(new Date(comm.timestamp), 'PPpp')}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

