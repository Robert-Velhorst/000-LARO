/**
 * Timeline View Component
 * 
 * Chronological visualization of case events and evidence
 */

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { 
  Calendar, 
  Mail, 
  FileText, 
  MessageSquare, 
  Upload, 
  UserPlus, 
  AlertCircle,
  CheckCircle,
  Clock
} from "lucide-react";

export interface TimelineEvent {
  id: string;
  date: Date;
  type: "case_created" | "evidence_added" | "lawyer_contacted" | "response_received" | "meeting_scheduled" | "status_changed" | "note_added";
  title: string;
  description?: string;
  metadata?: Record<string, any>;
}

interface TimelineViewProps {
  events: TimelineEvent[];
  compact?: boolean;
}

export default function TimelineView({ events, compact = false }: TimelineViewProps) {
  const getEventIcon = (type: TimelineEvent["type"]) => {
    switch (type) {
      case "case_created":
        return { icon: AlertCircle, color: "text-blue-500", bg: "bg-blue-500/10" };
      case "evidence_added":
        return { icon: Upload, color: "text-green-500", bg: "bg-green-500/10" };
      case "lawyer_contacted":
        return { icon: Mail, color: "text-purple-500", bg: "bg-purple-500/10" };
      case "response_received":
        return { icon: MessageSquare, color: "text-orange-500", bg: "bg-orange-500/10" };
      case "meeting_scheduled":
        return { icon: Calendar, color: "text-pink-500", bg: "bg-pink-500/10" };
      case "status_changed":
        return { icon: CheckCircle, color: "text-green-500", bg: "bg-green-500/10" };
      case "note_added":
        return { icon: FileText, color: "text-gray-500", bg: "bg-gray-500/10" };
      default:
        return { icon: Clock, color: "text-muted-foreground", bg: "bg-muted" };
    }
  };

  const formatEventType = (type: TimelineEvent["type"]) => {
    return type.split("_").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  };

  const formatDate = (date: Date) => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return `Today at ${date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`;
    } else if (diffDays === 1) {
      return `Yesterday at ${date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`;
    } else if (diffDays < 7) {
      return `${diffDays} days ago`;
    } else {
      return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
  };

  // Sort events by date (most recent first)
  const sortedEvents = [...events].sort((a, b) => b.date.getTime() - a.date.getTime());

  if (sortedEvents.length === 0) {
    return (
      <Card className="border-border/50 bg-card/50">
        <CardContent className="py-12 text-center">
          <Clock className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
          <p className="text-muted-foreground">No timeline events yet</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {sortedEvents.map((event, index) => {
        const { icon: Icon, color, bg } = getEventIcon(event.type);
        const isLast = index === sortedEvents.length - 1;

        return (
          <div key={event.id} className="relative">
            {/* Timeline Line */}
            {!isLast && (
              <div className="absolute left-6 top-12 bottom-0 w-0.5 bg-border" />
            )}

            {/* Event Card */}
            <div className="flex gap-4">
              {/* Icon */}
              <div className={`shrink-0 w-12 h-12 rounded-full ${bg} flex items-center justify-center z-10`}>
                <Icon className={`w-6 h-6 ${color}`} />
              </div>

              {/* Content */}
              <Card className={`flex-1 border-border/50 bg-card/50 backdrop-blur-xs hover:bg-card/80 transition-all ${compact ? "p-3" : "p-4"}`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className={`font-semibold ${compact ? "text-sm" : "text-base"}`}>
                        {event.title}
                      </h4>
                      <Badge variant="outline" className="text-xs">
                        {formatEventType(event.type)}
                      </Badge>
                    </div>
                    
                    {event.description && (
                      <p className={`text-muted-foreground ${compact ? "text-xs" : "text-sm"} mb-2`}>
                        {event.description}
                      </p>
                    )}

                    {event.metadata && Object.keys(event.metadata).length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        {Object.entries(event.metadata).map(([key, value]) => (
                          <Badge key={key} variant="secondary" className="text-xs">
                            {key}: {String(value)}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock className="w-3 h-3" />
                    {formatDate(event.date)}
                  </div>
                </div>
              </Card>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Example usage:
// const events: TimelineEvent[] = [
//   {
//     id: "1",
//     date: new Date("2025-01-15"),
//     type: "case_created",
//     title: "Case Created",
//     description: "Employment dispute case opened",
//     metadata: { caseType: "Employment Law", urgency: "High" }
//   },
//   {
//     id: "2",
//     date: new Date("2025-01-16"),
//     type: "evidence_added",
//     title: "Evidence Uploaded",
//     description: "3 documents added to case",
//     metadata: { fileCount: 3 }
//   },
//   {
//     id: "3",
//     date: new Date("2025-01-17"),
//     type: "lawyer_contacted",
//     title: "Lawyers Contacted",
//     description: "Outreach sent to 5 matched lawyers",
//     metadata: { lawyerCount: 5 }
//   },
// ];

