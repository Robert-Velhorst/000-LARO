import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { io, Socket } from "socket.io-client";
import { useAuth } from "@/_core/hooks/useAuth";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

interface WebSocketContextType {
  socket: Socket | null;
  isConnected: boolean;
}

const WebSocketContext = createContext<WebSocketContextType>({
  socket: null,
  isConnected: false,
});

export function useWebSocket() {
  return useContext(WebSocketContext);
}

// Buffer high-frequency event toasts so a burst (e.g. 50 evidence files added
// in a few seconds by auto-collection) collapses into a single summary toast
// instead of flooding the corner and hiding any error toast under the stack.
const TOAST_BURST_WINDOW_MS = 1500;

function useBurstToaster() {
  const buffers = useRef<Record<string, { count: number; lastDetail?: string; timer: ReturnType<typeof setTimeout> | null }>>({});

  const flush = useCallback((key: string, render: (count: number, lastDetail?: string) => void) => {
    const buf = buffers.current[key];
    if (!buf || buf.count === 0) return;
    render(buf.count, buf.lastDetail);
    buf.count = 0;
    buf.lastDetail = undefined;
    buf.timer = null;
  }, []);

  const push = useCallback((
    key: string,
    detail: string | undefined,
    render: (count: number, lastDetail?: string) => void
  ) => {
    const existing = buffers.current[key];
    if (existing) {
      existing.count += 1;
      existing.lastDetail = detail;
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = setTimeout(() => flush(key, render), TOAST_BURST_WINDOW_MS);
      return;
    }
    buffers.current[key] = {
      count: 1,
      lastDetail: detail,
      timer: setTimeout(() => flush(key, render), TOAST_BURST_WINDOW_MS),
    };
  }, [flush]);

  useEffect(() => () => {
    for (const buffer of Object.values(buffers.current)) {
      if (buffer.timer) clearTimeout(buffer.timer);
    }
  }, []);

  return { push };
}

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const { user } = useAuth();
  const userId = user?.id;
  const { push } = useBurstToaster();
  const utils = trpc.useUtils();
  const invalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleInvalidate = useCallback(() => {
    if (invalidateTimer.current) clearTimeout(invalidateTimer.current);
    invalidateTimer.current = setTimeout(() => {
      invalidateTimer.current = null;
      void utils.invalidate();
    }, 250);
  }, [utils]);

  useEffect(() => {
    if (!userId) return;

    // Connect to WebSocket server
    // Keep Socket.IO's polling-first negotiation so restrictive proxies can
    // establish the authenticated session before attempting a WebSocket upgrade.
    const socketInstance = io(window.location.origin);

    socketInstance.on("connect", () => {
      console.log("[WebSocket] Connected");
      setIsConnected(true);

    });

    socketInstance.on("disconnect", () => {
      console.log("[WebSocket] Disconnected");
      setIsConnected(false);
    });

    // Listen for real-time events. All high-frequency events go through the
    // burst toaster — only one toast per ~1.5s window, regardless of how many
    // events arrived. Error toasts elsewhere stay visible because they're not
    // drowned under a flood of info toasts.
    socketInstance.on("new_message", (message) => {
      console.log("[WebSocket] New message received:", message);
      push("new_message", message.subject, (count, lastDetail) => {
        toast.info(count === 1 ? "New message received" : `${count} new messages received`, {
          description: count === 1 ? lastDetail || "You have a new message" : undefined,
        });
      });
    });

    socketInstance.on("case_update", (caseUpdate) => {
      console.log("[WebSocket] Case update received:", caseUpdate);
      push("case_update", caseUpdate.caseId, (count, lastDetail) => {
        toast.info(count === 1 ? "Case updated" : `${count} cases updated`, {
          description: count === 1 && lastDetail ? `Case ${lastDetail} has been updated` : undefined,
        });
      });
    });

    socketInstance.on("evidence_update", (evidenceUpdate) => {
      console.log("[WebSocket] Evidence update received:", evidenceUpdate);
      push("evidence_update", evidenceUpdate.caseId, (count, lastDetail) => {
        toast.success(
          count === 1 ? "New evidence added" : `${count} new evidence items added`,
          {
            description: count === 1 && lastDetail ? `Added to case ${lastDetail}` : undefined,
          }
        );
      });
    });

    socketInstance.on("notification", (notification) => {
      console.log("[WebSocket] Notification received:", notification);
      // Generic notifications keep per-event behavior so distinct titles stay
      // distinct — they're not the spam source.
      toast(notification.title, {
        description: notification.message,
      });
    });

    socketInstance.on("data_change", scheduleInvalidate);

    setSocket(socketInstance);

    return () => {
      socketInstance.disconnect();
      if (invalidateTimer.current) clearTimeout(invalidateTimer.current);
    };
  }, [userId, push, scheduleInvalidate]);

  return (
    <WebSocketContext.Provider value={{ socket, isConnected }}>
      {children}
    </WebSocketContext.Provider>
  );
}

