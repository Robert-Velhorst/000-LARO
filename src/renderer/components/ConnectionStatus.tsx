import { useWebSocket } from "@/contexts/WebSocketContext";
import { Badge } from "@/components/ui/badge";
import { Wifi, WifiOff } from "lucide-react";
import { useI18n } from "@/contexts/I18nContext";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function ConnectionStatus() {
  const { isConnected } = useWebSocket();
  const { locale } = useI18n();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant={isConnected ? "outline" : "destructive"}
          role="status"
        >
          {isConnected ? (
            <>
              <Wifi className="w-3 h-3 mr-1" />
              <span className="hidden sm:inline">{locale === "nl" ? "Live bijgewerkt" : "Live updates"}</span>
            </>
          ) : (
            <>
              <WifiOff className="w-3 h-3 mr-1" />
              <span className="hidden sm:inline">{locale === "nl" ? "Live verbinding verbroken" : "Live updates offline"}</span>
            </>
          )}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        <p>
          {isConnected
            ? "Real-time updates active"
            : "Real-time updates unavailable"}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

