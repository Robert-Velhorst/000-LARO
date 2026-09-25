import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LucideIcon, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { useState } from "react";

export interface DataSourceConfig {
  id: string;
  name: string;
  description: string;
  icon: LucideIcon;
  color: string;
  isConnected: boolean;
  itemsCollected?: number;
  lastSyncedAt?: Date;
  onConnect: () => Promise<void>;
  onDisconnect: () => Promise<void>;
}

export function DataSourceConnector({
  config,
}: {
  config: DataSourceConfig;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Icon = config.icon;

  const handleConnect = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await config.onConnect();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDisconnect = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await config.onDisconnect();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Disconnection failed");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="relative p-6 rounded-xl border border-border/50 bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-all duration-300 hover:shadow-lg hover:shadow-orange-500/10 group">
      {/* Header with icon and status */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-start gap-4 flex-1">
          <div className={`p-3 rounded-lg ${config.color} text-white`}>
            <Icon className="h-6 w-6" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-lg text-foreground">
              {config.name}
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              {config.description}
            </p>
          </div>
        </div>

        {/* Status badge */}
        {config.isConnected ? (
          <Badge variant="default" className="ml-2 bg-green-500/20 text-green-600 border-green-500/30">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Connected
          </Badge>
        ) : (
          <Badge variant="outline" className="ml-2">
            Disconnected
          </Badge>
        )}
      </div>

      {/* Error message */}
      {error && (
        <div className="mb-4 p-3 rounded-lg bg-destructive/10 border border-destructive/20 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Stats when connected */}
      {config.isConnected && (
        <div className="mb-4 grid grid-cols-2 gap-3">
          {config.itemsCollected !== undefined && (
            <div className="p-3 rounded-lg bg-accent/50 border border-border/50">
              <p className="text-xs text-muted-foreground">Items Collected</p>
              <p className="text-lg font-semibold text-foreground">
                {config.itemsCollected}
              </p>
            </div>
          )}
          {config.lastSyncedAt && (
            <div className="p-3 rounded-lg bg-accent/50 border border-border/50">
              <p className="text-xs text-muted-foreground">Last Synced</p>
              <p className="text-sm font-medium text-foreground">
                {config.lastSyncedAt.toLocaleDateString()}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-3">
        {config.isConnected ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={handleConnect}
              disabled={isLoading}
              className="flex-1"
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Syncing...
                </>
              ) : (
                "Sync Now"
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDisconnect}
              disabled={isLoading}
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
            >
              Disconnect
            </Button>
          </>
        ) : (
          <Button
            onClick={handleConnect}
            disabled={isLoading}
            className="w-full bg-orange-500 hover:bg-orange-600 text-white"
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Connecting...
              </>
            ) : (
              `Connect ${config.name}`
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
