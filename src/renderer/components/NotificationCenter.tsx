/**
 * Notification Center Component
 * 
 * Displays case updates, lawyer responses, and system notifications
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Bell,
  Check,
  CheckCheck,
  Mail,
  UserPlus,
  FileText,
  AlertCircle,
  Calendar,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useWebSocket } from "@/contexts/WebSocketContext";
import { useLocation } from "wouter";

export interface Notification {
  id: string;
  type: "lawyer_response" | "case_status_change" | "evidence_uploaded" | "new_match" | "deadline_reminder" | "system_announcement";
  title: string;
  message: string;
  createdAt: Date | string;
  isRead: boolean;
  actionUrl?: string;
  metadata?: Record<string, any>;
  caseId?: string | null;
  lawyerId?: string | null;
  evidenceFileId?: string | null;
}

export default function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();
  
  const utils = trpc.useUtils();
  const { socket, isConnected } = useWebSocket();
  
  // Fetch notifications from API
  const { data: notifications = [], refetch } = trpc.notifications.list.useQuery(
    { limit: 50 },
    { enabled: open }
  );
  
  const { data: unreadCountData = 0, refetch: refetchCount } = trpc.notifications.unreadCount.useQuery(undefined, {
    refetchInterval: isConnected ? false : 60_000,
    refetchOnWindowFocus: true,
  });
  
  const markAsReadMutation = trpc.notifications.markAsRead.useMutation({
    onSuccess: () => {
      refetch();
      refetchCount();
    }
  });

  // WebSocket listener for real-time notifications
  useEffect(() => {
    if (!socket) return;

    const handleNotification = () => {
      // WebSocketContext owns the user-facing toast. This listener only refreshes
      // persisted notification state so one event cannot produce duplicate toasts.
      refetch();
      refetchCount();
    };

    socket.on("notification", handleNotification);

    return () => {
      socket.off("notification", handleNotification);
    };
  }, [socket, refetch, refetchCount]);
  
  const markAllAsReadMutation = trpc.notifications.markAllAsRead.useMutation({
    onSuccess: () => {
      refetch();
      refetchCount();
      toast.success("All notifications marked as read");
    }
  });

  const unreadCount = unreadCountData;

  const getNotificationIcon = (type: Notification["type"]) => {
    switch (type) {
      case "lawyer_response":
        return { icon: Mail, color: "text-green-500", bg: "bg-green-500/10" };
      case "case_status_change":
        return { icon: AlertCircle, color: "text-blue-500", bg: "bg-blue-500/10" };
      case "evidence_uploaded":
        return { icon: FileText, color: "text-orange-500", bg: "bg-orange-500/10" };
      case "new_match":
        return { icon: UserPlus, color: "text-purple-500", bg: "bg-purple-500/10" };
      case "deadline_reminder":
        return { icon: Calendar, color: "text-red-500", bg: "bg-red-500/10" };
      case "system_announcement":
        return { icon: Bell, color: "text-gray-500", bg: "bg-gray-500/10" };
      default:
        return { icon: Bell, color: "text-gray-500", bg: "bg-gray-500/10" };
    }
  };

  const formatTimeAgo = (date: Date) => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const handleMarkAsRead = (notificationId: string) => {
    markAsReadMutation.mutate({ notificationId });
  };

  const handleMarkAllAsRead = () => {
    markAllAsReadMutation.mutate();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={unreadCount > 0 ? `Open notifications, ${unreadCount} unread` : "Open notifications"}
          className="relative"
        >
          <Bell className="w-5 h-5" />
          {unreadCount > 0 && (
            <Badge
              className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 bg-red-500 text-white text-xs"
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[calc(100vw-1rem)] p-0 sm:w-96" align="end">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div>
            <h3 className="font-semibold">Notifications</h3>
            <p className="text-xs text-muted-foreground">
              {unreadCount} unread
            </p>
          </div>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleMarkAllAsRead}
              className="text-xs"
            >
              <CheckCheck className="w-4 h-4 mr-1" />
              Mark all read
            </Button>
          )}
        </div>

        {/* Notifications List */}
        <ScrollArea className="h-[400px]">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Bell className="w-12 h-12 text-muted-foreground opacity-50 mb-3" />
              <p className="text-sm text-muted-foreground">No notifications</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {notifications.map((notification) => {
                const { icon: Icon, color, bg } = getNotificationIcon(notification.type);
                
                return (
                  <div
                    key={notification.id}
                    className={`p-4 hover:bg-accent/50 transition-colors ${
                      !notification.isRead ? "bg-accent/20" : ""
                    }`}
                  >
                    <div className="flex gap-3">
                      {/* Icon */}
                      <div className={`flex-shrink-0 w-10 h-10 rounded-full ${bg} flex items-center justify-center`}>
                        <Icon className={`w-5 h-5 ${color}`} />
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <h4 className="font-medium text-sm truncate">
                            {notification.title}
                          </h4>
                          {!notification.isRead && (
                            <div className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 mt-1" />
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                          {notification.message}
                        </p>
                        <div className="flex items-center gap-2 mt-2">
                          <span className="text-xs text-muted-foreground">
                            {formatTimeAgo(notification.createdAt)}
                          </span>
                          {notification.actionUrl && (
                            <>
                              <span className="text-xs text-muted-foreground">•</span>
                              <Button
                                variant="link"
                                size="sm"
                                className="h-auto p-0 text-xs"
                                onClick={() => {
                                  if (notification.actionUrl?.startsWith("/") && !notification.actionUrl.startsWith("//")) {
                                    navigate(notification.actionUrl);
                                  }
                                  setOpen(false);
                                }}
                              >
                                View
                              </Button>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex flex-col gap-1">
                        {!notification.isRead && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => handleMarkAsRead(notification.id)}
                            aria-label={`Mark ${notification.title} as read`}
                          >
                            <Check className="w-3 h-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>

      </PopoverContent>
    </Popover>
  );
}

