import { useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  MapPin,
  Phone,
  Mail,
  Globe,
  Briefcase,
  Clock,
  Target,
  Send,
  CheckCircle2,
  XCircle,
} from "lucide-react";

interface CaseDetailsDialogProps {
  caseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function CaseDetailsDialog({
  caseId,
  open,
  onOpenChange,
}: CaseDetailsDialogProps) {
  const [selectedDistance, setSelectedDistance] = useState(50);
  
  const { data: caseData, isLoading: caseLoading } = trpc.cases.byId.useQuery(caseId, {
    enabled: open && !!caseId,
  });

  const { data: matchedLawyers, isLoading: matchingLoading, refetch } = trpc.matching.findLawyers.useQuery(
    {
      caseId,
      maxDistance: selectedDistance,
      maxResults: 10,
    },
    {
      enabled: open && !!caseId,
    }
  );

  const initiateOutreachMutation = trpc.workflow.initiateOutreach.useMutation({
    onSuccess: (result) => {
      if (!result.success) {
        toast.error(result.reason || "No matching lawyer is available for an outreach draft.");
      } else {
        toast.success(result.created ? `${result.created} outreach draft(s) prepared for review` : "Outreach is up to date");
      }
      refetch();
    },
    onError: (error) => {
      toast.error(`Failed to initiate outreach: ${error.message}`);
    },
  });

  const handleInitiateOutreach = () => {
    if (!caseId) return;
    initiateOutreachMutation.mutate({ caseId });
  };

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto bg-card border-border/50">
        <DialogHeader>
          <DialogTitle className="text-2xl bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
            Case Details & Lawyer Matching
          </DialogTitle>
          <DialogDescription>
            View case details and find matching lawyers based on proximity and expertise
          </DialogDescription>
        </DialogHeader>

        {caseLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : caseData ? (
          <div className="space-y-6">
            {/* Case Information */}
            <Card className="border-border/50 bg-card/50">
              <CardContent className="pt-6 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Client Name</p>
                    <p className="font-medium">{caseData.clientName}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Case Type</p>
                    <p className="font-medium">{caseData.caseType}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Status</p>
                    <Badge variant="secondary">{caseData.status}</Badge>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Priority</p>
                    <Badge
                      variant="outline"
                      className={
                        caseData.urgency === "High"
                          ? "border-red-500/50 text-red-400"
                          : caseData.urgency === "Medium"
                          ? "border-yellow-500/50 text-yellow-400"
                          : "border-green-500/50 text-green-400"
                      }
                    >
                      {caseData.urgency}
                    </Badge>
                  </div>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground mb-2">Case Summary</p>
                  <p className="text-sm">{caseData.caseSummary}</p>
                </div>
              </CardContent>
            </Card>

            {/* Matching Controls */}
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <label className="text-sm text-muted-foreground mb-2 block">
                  Search Radius: {selectedDistance} km
                </label>
                <input
                  type="range"
                  min="10"
                  max="200"
                  step="10"
                  value={selectedDistance}
                  onChange={(e) => setSelectedDistance(parseInt(e.target.value))}
                  className="w-full"
                />
              </div>
              <Button
                onClick={() => refetch()}
                variant="outline"
                className="border-purple-500/30 hover:bg-purple-500/10"
              >
                <Target className="w-4 h-4 mr-2" />
                Refresh Matches
              </Button>
            </div>

            {/* Matched Lawyers */}
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold">
                  Matched Lawyers ({matchedLawyers?.length || 0})
                </h3>
                {matchedLawyers && matchedLawyers.length > 0 && (
                  <Button
                    onClick={handleInitiateOutreach}
                    disabled={initiateOutreachMutation.isPending}
                    className="bg-gradient-to-r from-green-500 to-blue-500 hover:from-green-600 hover:to-blue-600"
                  >
                    <Send className="w-4 h-4 mr-2" />
                    {initiateOutreachMutation.isPending ? "Initiating..." : "Start Outreach"}
                  </Button>
                )}
              </div>

              {matchingLoading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-40 w-full" />
                  ))}
                </div>
              ) : matchedLawyers && matchedLawyers.length > 0 ? (
                <div className="space-y-4 max-h-96 overflow-y-auto">
                  {matchedLawyers.map((lawyer: any, index: number) => (
                    <Card
                      key={lawyer.id}
                      className="border-border/50 bg-card/50 hover:bg-card/80 transition-all"
                    >
                      <CardContent className="pt-6">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-3 mb-3">
                              <div className="w-10 h-10 rounded-full bg-gradient-to-r from-purple-500 to-pink-500 flex items-center justify-center text-white font-bold">
                                #{index + 1}
                              </div>
                              <div>
                                <h4 className="font-semibold text-lg">{lawyer.name}</h4>
                                <p className="text-sm text-muted-foreground flex items-center gap-1">
                                  <MapPin className="w-3 h-3" />
                                  {lawyer.distance} km away
                                </p>
                              </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4 mb-3">
                              {lawyer.email && (
                                <div className="flex items-center gap-2 text-sm">
                                  <Mail className="w-4 h-4 text-muted-foreground" />
                                  <span>{lawyer.email}</span>
                                </div>
                              )}
                              {lawyer.phone && (
                                <div className="flex items-center gap-2 text-sm">
                                  <Phone className="w-4 h-4 text-muted-foreground" />
                                  <span>{lawyer.phone}</span>
                                </div>
                              )}
                            </div>

                            <div className="flex flex-wrap gap-2 mb-3">
                              {lawyer.legalAreas?.map((area: string, i: number) => (
                                <Badge
                                  key={i}
                                  variant="secondary"
                                  className="bg-blue-500/20 text-blue-300 border-blue-500/30"
                                >
                                  {area}
                                </Badge>
                              ))}
                            </div>

                            <div className="flex flex-wrap gap-2">
                              {lawyer.matchReasons?.map((reason: string, i: number) => (
                                <Badge
                                  key={i}
                                  variant="outline"
                                  className="text-xs border-green-500/30 text-green-400"
                                >
                                  <CheckCircle2 className="w-3 h-3 mr-1" />
                                  {reason}
                                </Badge>
                              ))}
                            </div>
                          </div>

                          <div className="text-right">
                            <div className="text-2xl font-bold bg-gradient-to-r from-green-400 to-blue-400 bg-clip-text text-transparent">
                              {lawyer.matchScore}
                            </div>
                            <p className="text-xs text-muted-foreground">Match Score</p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : (
                <Card className="border-border/50 bg-card/50">
                  <CardContent className="pt-6 text-center">
                    <XCircle className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
                    <p className="text-muted-foreground">
                      No matching lawyers found within {selectedDistance} km radius.
                    </p>
                    <p className="text-sm text-muted-foreground mt-2">
                      Try increasing the search radius or check case requirements.
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        ) : (
          <div className="text-center py-8">
            <p className="text-muted-foreground">Case not found</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

