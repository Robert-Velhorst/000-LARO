import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { 
  MessageSquare, 
  RefreshCw, 
  CheckCircle2, 
  XCircle, 
  Hash, 
  Lock,
  Users,
  FileText,
  Loader2,
  AlertCircle,
  Unplug
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useSearchParams } from "wouter";

interface SlackSimpleProps {
  caseId: string;
}

interface Channel {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
  numMembers?: number;
  topic?: string;
  purpose?: string;
}

export default function SlackSimple({ caseId }: SlackSimpleProps) {
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set());
  const [isSyncing, setIsSyncing] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [searchParams] = useSearchParams();

  // Get Slack connection status
  const { data: statusData, isLoading: statusLoading, refetch: refetchStatus } = trpc.slackEnhanced.getStatus.useQuery(
    { caseId },
    { enabled: !!caseId }
  );

  // Get channels when connected
  const { data: channelsData, isLoading: channelsLoading, refetch: refetchChannels } = trpc.slackEnhanced.listChannels.useQuery(
    { caseId },
    { enabled: !!caseId && statusData?.connected }
  );

  // Connect mutation
  const connectMutation = trpc.slackEnhanced.connectWithBotToken.useMutation({
    onSuccess: (data) => {
      toast.success(data.message || "Connected to Slack!");
      refetchStatus();
      refetchChannels();
    },
    onError: (error) => {
      toast.error(`Failed to connect: ${error.message}`);
    },
  });

  // Get OAuth URL mutation
  const getOAuthUrlMutation = trpc.slackEnhanced.getOAuthUrl.useMutation({
    onSuccess: (data) => {
      // Open OAuth popup
      const width = 500;
      const height = 600;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      
      window.open(
        data.authUrl,
        'slack-oauth',
        `width=${width},height=${height},left=${left},top=${top}`
      );
    },
    onError: (error) => {
      toast.error(`Failed to get OAuth URL: ${error.message}`);
    },
  });

  // Sync mutation
  const syncMutation = trpc.slackEnhanced.startSync.useMutation({
    onSuccess: (data) => {
      toast.success(data.message || "Slack sync completed!");
      refetchStatus();
      setIsSyncing(false);
    },
    onError: (error) => {
      toast.error(`Sync failed: ${error.message}`);
      setIsSyncing(false);
    },
  });

  // Disconnect mutation
  const disconnectMutation = trpc.slackEnhanced.disconnect.useMutation({
    onSuccess: () => {
      toast.success("Slack disconnected");
      refetchStatus();
      setSelectedChannels(new Set());
    },
    onError: (error) => {
      toast.error(`Failed to disconnect: ${error.message}`);
    },
  });

  // Handle OAuth callback
  useEffect(() => {
    const slackConnected = searchParams.get('slack_connected');
    const slackError = searchParams.get('slack_error');

    if (slackConnected === 'true') {
      toast.success("Successfully connected to Slack!");
      refetchStatus();
      refetchChannels();
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    if (slackError) {
      toast.error(`Slack connection failed: ${slackError}`);
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [searchParams, refetchStatus, refetchChannels]);

  const handleConnectOAuth = async () => {
    setIsConnecting(true);
    try {
      await getOAuthUrlMutation.mutateAsync({ caseId });
    } finally {
      setIsConnecting(false);
    }
  };

  const handleConnectBotToken = async () => {
    setIsConnecting(true);
    try {
      await connectMutation.mutateAsync({ caseId });
    } finally {
      setIsConnecting(false);
    }
  };

  const handleSync = async () => {
    if (!statusData?.status?.id) {
      toast.error("Slack not connected");
      return;
    }

    setIsSyncing(true);
    await syncMutation.mutateAsync({
      caseId,
      sourceId: statusData.status.id,
      channelIds: selectedChannels.size > 0 ? Array.from(selectedChannels) : undefined,
    });
  };

  const handleDisconnect = async () => {
    if (!statusData?.status?.id) return;
    await disconnectMutation.mutateAsync({
      caseId,
      sourceId: statusData.status.id,
    });
  };

  const toggleChannel = (channelId: string) => {
    const newSelected = new Set(selectedChannels);
    if (newSelected.has(channelId)) {
      newSelected.delete(channelId);
    } else {
      newSelected.add(channelId);
    }
    setSelectedChannels(newSelected);
  };

  const selectAllChannels = () => {
    if (channelsData?.channels) {
      setSelectedChannels(new Set(channelsData.channels.map(c => c.id)));
    }
  };

  const deselectAllChannels = () => {
    setSelectedChannels(new Set());
  };

  const isConnected = statusData?.connected;
  const channels = channelsData?.channels || [];

  if (statusLoading) {
    return (
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-[#4A154B]/20">
              <MessageSquare className="w-6 h-6 text-[#4A154B]" />
            </div>
            <div>
              <CardTitle className="text-xl">Slack</CardTitle>
              <CardDescription>
                {isConnected 
                  ? `Connected to ${statusData?.status?.teamName || 'workspace'}`
                  : "Connect your Slack workspace to collect messages and files"
                }
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isConnected ? (
              <>
                <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/30">
                  <CheckCircle2 className="w-3 h-3 mr-1" />
                  Connected
                </Badge>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={handleDisconnect}
                  disabled={disconnectMutation.isPending}
                >
                  <Unplug className="w-4 h-4 mr-1" />
                  Disconnect
                </Button>
              </>
            ) : (
              <Badge variant="outline" className="bg-muted text-muted-foreground">
                <XCircle className="w-3 h-3 mr-1" />
                Not Connected
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {!isConnected ? (
          <div className="text-center py-8">
            <div className="mx-auto w-16 h-16 rounded-full bg-[#4A154B]/10 flex items-center justify-center mb-4">
              <MessageSquare className="w-8 h-8 text-[#4A154B]" />
            </div>
            <h3 className="text-lg font-semibold mb-2">Connect Slack</h3>
            <p className="text-muted-foreground mb-6 max-w-md mx-auto">
              Connect your Slack workspace to automatically collect messages, threads, and shared files as evidence.
            </p>
            <div className="flex flex-col gap-3 max-w-md mx-auto">
              <Button 
                onClick={handleConnectOAuth}
                disabled={isConnecting || getOAuthUrlMutation.isPending}
                className="bg-[#4A154B] hover:bg-[#4A154B]/90"
              >
                {isConnecting || getOAuthUrlMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Opening Slack...
                  </>
                ) : (
                  <>
                    <MessageSquare className="w-4 h-4 mr-2" />
                    Connect with OAuth
                  </>
                )}
              </Button>
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-muted" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">or</span>
                </div>
              </div>
              <Button 
                onClick={handleConnectBotToken}
                disabled={isConnecting || connectMutation.isPending}
                variant="outline"
              >
                {isConnecting || connectMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  <>
                    <MessageSquare className="w-4 h-4 mr-2" />
                    Use Bot Token
                  </>
                )}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* Status Info */}
            {statusData?.status && (
              <div className="flex items-center gap-4 p-3 rounded-lg bg-muted/50">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm">
                    <strong>{statusData.status.itemsCollected || 0}</strong> items collected
                  </span>
                </div>
                {statusData.status.lastSyncedAt && (
                  <div className="text-sm text-muted-foreground">
                    Last synced: {new Date(statusData.status.lastSyncedAt).toLocaleString()}
                  </div>
                )}
              </div>
            )}

            <Separator />

            {/* Channel Selection */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-medium flex items-center gap-2">
                  <Hash className="w-4 h-4" />
                  Select Channels to Sync
                </h4>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={selectAllChannels}>
                    Select All
                  </Button>
                  <Button variant="ghost" size="sm" onClick={deselectAllChannels}>
                    Deselect All
                  </Button>
                </div>
              </div>

              {channelsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : channels.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>No channels found. Make sure the bot is added to channels.</p>
                </div>
              ) : (
                <ScrollArea className="h-[300px] rounded-md border p-2">
                  <div className="space-y-2">
                    {channels.map((channel: Channel) => (
                      <div
                        key={channel.id}
                        className={`flex items-center gap-3 p-3 rounded-lg border transition-colors cursor-pointer ${
                          selectedChannels.has(channel.id)
                            ? "bg-primary/5 border-primary/30"
                            : "bg-card hover:bg-muted/50 border-border/50"
                        }`}
                        onClick={() => toggleChannel(channel.id)}
                      >
                        <Checkbox
                          checked={selectedChannels.has(channel.id)}
                          onCheckedChange={() => toggleChannel(channel.id)}
                        />
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          {channel.isPrivate ? (
                            <Lock className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                          ) : (
                            <Hash className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                          )}
                          <span className="font-medium truncate">{channel.name}</span>
                          {channel.isPrivate && (
                            <Badge variant="outline" className="text-xs">Private</Badge>
                          )}
                        </div>
                        {channel.numMembers && (
                          <div className="flex items-center gap-1 text-sm text-muted-foreground">
                            <Users className="w-3 h-3" />
                            {channel.numMembers}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </div>

            {/* Sync Button */}
            <div className="flex justify-end pt-2">
              <Button
                onClick={handleSync}
                disabled={isSyncing || channels.length === 0}
                className="bg-[#4A154B] hover:bg-[#4A154B]/90"
              >
                {isSyncing ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Syncing...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Sync {selectedChannels.size > 0 ? `${selectedChannels.size} Channels` : "All Channels"}
                  </>
                )}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
