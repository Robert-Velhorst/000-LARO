/**
 * Case Status Workflow Component
 * 
 * Visual workflow showing case progression through different statuses
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { 
  FileEdit, 
  Send, 
  Clock, 
  CheckCircle2, 
  XCircle,
  ArrowRight
} from "lucide-react";

interface CaseStatusWorkflowProps {
  currentStatus: string;
  onStatusChange?: (newStatus: string) => void;
  canEdit?: boolean;
}

export default function CaseStatusWorkflow({ 
  currentStatus, 
  onStatusChange,
  canEdit = false 
}: CaseStatusWorkflowProps) {
  const statuses = [
    {
      key: "draft",
      label: "Draft",
      icon: FileEdit,
      color: "text-gray-500",
      bg: "bg-gray-500/10",
      border: "border-gray-500/30",
      description: "Case details being prepared"
    },
    {
      key: "active",
      label: "Active",
      icon: Send,
      color: "text-blue-500",
      bg: "bg-blue-500/10",
      border: "border-blue-500/30",
      description: "Searching for lawyers"
    },
    {
      key: "pending_response",
      label: "Pending Response",
      icon: Clock,
      color: "text-yellow-500",
      bg: "bg-yellow-500/10",
      border: "border-yellow-500/30",
      description: "Waiting for lawyer replies"
    },
    {
      key: "matched",
      label: "Matched",
      icon: CheckCircle2,
      color: "text-green-500",
      bg: "bg-green-500/10",
      border: "border-green-500/30",
      description: "Lawyer found and accepted"
    },
    {
      key: "closed",
      label: "Closed",
      icon: XCircle,
      color: "text-gray-500",
      bg: "bg-gray-500/10",
      border: "border-gray-500/30",
      description: "Case completed or cancelled"
    }
  ];

  // Normalize DB status to workflow key
  const normalizeStatus = (s: string): string => {
    const lower = (s ?? "").toLowerCase().replace(/\s+/g, "_");
    const map: Record<string, string> = {
      draft: "draft",
      new: "draft",
      active: "active",
      matching: "active",
      open: "active",
      outreach: "pending_response",
      pending_response: "pending_response",
      pending: "pending_response",
      waiting: "pending_response",
      waiting_for_lawyer: "pending_response",
      matched: "matched",
      resolved: "closed",
      closed: "closed",
      complete: "closed",
    };
    return map[lower] ?? "draft";
  };

  const normalizedStatus = normalizeStatus(currentStatus);
  const currentIndex = Math.max(0, statuses.findIndex(s => s.key === normalizedStatus));

  const getNextStatus = () => {
    if (currentIndex < statuses.length - 1) {
      return statuses[currentIndex + 1];
    }
    return null;
  };

  const getPreviousStatus = () => {
    if (currentIndex > 0) {
      return statuses[currentIndex - 1];
    }
    return null;
  };

  const nextStatus = getNextStatus();
  const previousStatus = getPreviousStatus();

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-xs">
      <CardHeader>
        <CardTitle className="text-lg">Case Status Workflow</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Status Timeline */}
        <div className="relative">
          <div className="flex items-center justify-between">
            {statuses.map((status, index) => {
              const Icon = status.icon;
              const isActive = status.key === currentStatus;
              const isPast = index < currentIndex;
              const isFuture = index > currentIndex;

              return (
                <div key={status.key} className="flex flex-col items-center flex-1">
                  {/* Status Icon */}
                  <div
                    className={`
                      relative z-10 p-3 rounded-full border-2 transition-all
                      ${isActive ? `${status.bg} ${status.border} scale-110` : ''}
                      ${isPast ? 'bg-green-500/10 border-green-500/30' : ''}
                      ${isFuture ? 'bg-gray-500/10 border-gray-500/30' : ''}
                    `}
                  >
                    <Icon 
                      className={`w-5 h-5 ${
                        isActive ? status.color : 
                        isPast ? 'text-green-500' : 
                        'text-gray-500'
                      }`} 
                    />
                  </div>

                  {/* Status Label */}
                  <div className="mt-2 text-center">
                    <p className={`text-sm font-medium ${
                      isActive ? status.color : 
                      isPast ? 'text-green-500' : 
                      'text-muted-foreground'
                    }`}>
                      {status.label}
                    </p>
                    {isActive && (
                      <Badge className={`mt-1 text-xs ${status.bg} ${status.color} border-0`}>
                        Current
                      </Badge>
                    )}
                  </div>

                  {/* Connector Line */}
                  {index < statuses.length - 1 && (
                    <div 
                      className={`
                        absolute top-6 h-0.5 transition-all
                        ${index < currentIndex ? 'bg-green-500' : 'bg-gray-500/30'}
                      `}
                      style={{
                        left: `${(index / (statuses.length - 1)) * 100 + 8}%`,
                        width: `${100 / (statuses.length - 1) - 16}%`
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Current Status Description */}
        <div className={`p-4 rounded-lg ${statuses[currentIndex].bg} border ${statuses[currentIndex].border}`}>
          <p className="text-sm text-muted-foreground">
            {statuses[currentIndex].description}
          </p>
        </div>

        {/* Status Transition Actions */}
        {canEdit && (
          <div className="flex gap-2">
            {previousStatus && (
              <Button
                variant="outline"
                onClick={() => onStatusChange?.(previousStatus.key)}
                className="flex-1"
              >
                <ArrowRight className="w-4 h-4 mr-2 rotate-180" />
                Back to {previousStatus.label}
              </Button>
            )}
            {nextStatus && (
              <Button
                onClick={() => onStatusChange?.(nextStatus.key)}
                className="flex-1 bg-orange-500 hover:bg-orange-600"
              >
                Move to {nextStatus.label}
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

