import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { 
  Mail, 
  Cloud, 
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink
} from "lucide-react";
import { toast } from "sonner";
import { useEffect, useRef, useState } from "react";
import { isElectron } from "@/lib/electronApiShim";

const OAUTH_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const OAUTH_WINDOW_CHECK_INTERVAL_MS = 750;

// Get current user context (adjust based on your auth implementation)
const useCurrentUser = () => {
  const { data: user } = trpc.auth.me.useQuery();
  return user;
};

/**
 * Evidence Connections Card
 * Displays the shared Google evidence grant as Gmail and Drive capabilities.
 */

interface PlatformConnection {
  id: string;
  name: string;
  icon: React.ReactNode;
  description: string;
  color: string;
  connected: boolean;
  lastSync?: Date;
  itemCount?: number;
}

export default function EvidenceConnectionsCard() {
  // Get current user
  const currentUser = useCurrentUser();
  const utils = trpc.useContext();
  const [connectingPlatform, setConnectingPlatform] = useState<"gmail" | "google-drive" | null>(null);
  const oauthWindowRef = useRef<Window | null>(null);
  const oauthCallbackOriginRef = useRef<string | null>(null);
  
  // Query both capabilities because they share one owner-scoped Google grant.
  const { data: gmailStatus, isLoading: gmailLoading, refetch: refetchGmailStatus } = trpc.gmailEnhanced.getStatus.useQuery(undefined, {
    enabled: !!currentUser,
    refetchOnWindowFocus: true,
    refetchInterval: connectingPlatform === "gmail" ? 1_500 : false,
  });
  const { data: driveStatus, isLoading: driveLoading, refetch: refetchDriveStatus } = trpc.googleDrive.checkConnection.useQuery(undefined, {
    enabled: !!currentUser,
    refetchOnWindowFocus: true,
    refetchInterval: connectingPlatform === "google-drive" ? 1_500 : false,
  });
  // OAuth URL mutations
  const gmailOAuthMutation = trpc.gmailEnhanced.getOAuthUrl.useMutation();
  const driveOAuthMutation = trpc.googleDriveEnhanced.getOAuthUrl.useMutation();

  // Disconnect mutations
  const gmailDisconnectMutation = trpc.gmailEnhanced.disconnect.useMutation();
  const driveDisconnectMutation = trpc.googleDriveEnhanced.disconnect.useMutation();

  useEffect(() => {
    if (connectingPlatform === "gmail" && gmailStatus?.connected) {
      oauthWindowRef.current?.close();
      oauthWindowRef.current = null;
      toast.success("Gmail successfully connected");
      setConnectingPlatform(null);
    }
    if (connectingPlatform === "google-drive" && driveStatus?.connected) {
      oauthWindowRef.current?.close();
      oauthWindowRef.current = null;
      toast.success("Google Drive successfully connected");
      setConnectingPlatform(null);
    }
  }, [connectingPlatform, driveStatus?.connected, gmailStatus?.connected]);

  useEffect(() => {
    if (!connectingPlatform) return;
    const handleOAuthComplete = (event: MessageEvent) => {
      if (
        event.origin !== oauthCallbackOriginRef.current ||
        event.data?.type !== 'laro:oauth-complete'
      ) return;

      oauthWindowRef.current?.close();
      oauthWindowRef.current = null;
      if (event.data.success === true) {
        // The callback is emitted only after the account was saved. Finish the
        // waiting state immediately, then refresh both capabilities in place.
        setConnectingPlatform(null);
        toast.success('Google successfully connected');
        void Promise.all([
          refetchGmailStatus(),
          refetchDriveStatus(),
          utils.gmailEnhanced.getStatus.invalidate(),
          utils.googleDrive.checkConnection.invalidate(),
        ]);
      } else {
        setConnectingPlatform(null);
        toast.error('The Google connection was not completed.');
      }
    };
    window.addEventListener('message', handleOAuthComplete);
    return () => window.removeEventListener('message', handleOAuthComplete);
  }, [connectingPlatform, refetchDriveStatus, refetchGmailStatus, utils]);

  useEffect(() => {
    if (!connectingPlatform) return;

    let checkingClosedWindow = false;
    const refreshConnection = async () => {
      const [gmailResult, driveResult] = await Promise.all([
        refetchGmailStatus(),
        refetchDriveStatus(),
      ]);
      return Boolean(gmailResult.data?.connected || driveResult.data?.connected);
    };
    const refreshOnReturn = () => {
      if (document.visibilityState === "visible") void refreshConnection();
    };
    const windowCheck = window.setInterval(() => {
      if (!oauthWindowRef.current?.closed || checkingClosedWindow) return;
      oauthWindowRef.current = null;
      checkingClosedWindow = true;
      void refreshConnection()
        .then((connected) => {
          if (!connected) {
            setConnectingPlatform(null);
            toast.error("Google authorization closed before the connection completed.");
          }
        })
        .finally(() => {
          checkingClosedWindow = false;
        });
    }, OAUTH_WINDOW_CHECK_INTERVAL_MS);
    const timeout = window.setTimeout(() => {
      oauthWindowRef.current?.close();
      oauthWindowRef.current = null;
      setConnectingPlatform(null);
      toast.error("Google authorization timed out. Please try again.");
    }, OAUTH_WAIT_TIMEOUT_MS);

    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.clearInterval(windowCheck);
      window.clearTimeout(timeout);
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [connectingPlatform, refetchDriveStatus, refetchGmailStatus]);

  const platforms: PlatformConnection[] = [
    {
      id: 'gmail',
      name: 'Gmail',
      icon: <Mail className="w-5 h-5" />,
      description: 'Connect your Gmail account to collect email evidence',
      color: 'bg-red-500',
      connected: gmailStatus?.connected || false,
      lastSync: gmailStatus?.lastSync ? new Date(gmailStatus.lastSync) : undefined,
      itemCount: gmailStatus?.itemCount,
    },    
    {
      id: 'google-drive',
      name: 'Google Drive',
      icon: <Cloud className="w-5 h-5" />,
      description: 'Connect Google Drive to collect document evidence',
      color: 'bg-yellow-500',
      connected: driveStatus?.connected || false,
      lastSync: undefined,
      itemCount: driveStatus?.accounts?.length || 0,
    },
  ];

  const handleConnect = async (platformId: string) => {
    if (!currentUser?.id) {
      toast.error('Please sign in to connect accounts');
      return;
    }

    try {
      // Google OAuth covers both Gmail and Drive; request the protected URL from tRPC.
      if (platformId === 'gmail' || platformId === 'google-drive') {
        const result = platformId === 'gmail'
          ? await gmailOAuthMutation.mutateAsync()
          : await driveOAuthMutation.mutateAsync();
        if (!result.success || !result.authUrl) {
          toast.error(result.reason || 'Google OAuth is unavailable.');
          return;
        }
        // Electron opens provider URLs in a sandboxed child window; the web build uses a browser tab.
        const authorizationUrl = new URL(result.authUrl);
        const redirectUri = authorizationUrl.searchParams.get('redirect_uri');
        if (!redirectUri) throw new Error('OAuth callback URL is missing');
        oauthCallbackOriginRef.current = new URL(redirectUri).origin;
        const oauthWindow = window.open(result.authUrl, 'laro-google-oauth', 'popup,width=520,height=720');
        // Electron's main process denies the renderer popup and opens its own sandboxed window.
        if (!oauthWindow && !isElectron()) {
          toast.error('Your browser blocked the Google authorization window. Allow popups for LARO and try again.');
          return;
        }
        oauthWindowRef.current = oauthWindow;
        setConnectingPlatform(platformId);
        toast.info('Opening authorization window. Please complete the OAuth flow.');
        return;
      }

      toast.error('Unknown platform');
    } catch (error) {
      toast.error(`Failed to connect: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleDisconnect = async (platformId: string) => {
    try {
      switch (platformId) {
        case 'gmail':
          await gmailDisconnectMutation.mutateAsync();
          break;        
        case 'google-drive':
          await driveDisconnectMutation.mutateAsync();
          break;        
        default:
          toast.error('Unknown platform');
          return;
      }

      await Promise.all([
        utils.gmailEnhanced.getStatus.invalidate(),
        utils.googleDrive.checkConnection.invalidate(),
      ]);
      toast.success(`Disconnected from ${platformId}`);
    } catch (error) {
      toast.error(`Failed to disconnect: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const formatLastSync = (date?: Date) => {
    if (!date) return 'Never';
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  };

  const isLoading = gmailLoading || driveLoading;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">Evidence Collection Sources</CardTitle>
        <CardDescription>
          Connect Google once to collect selected Gmail and Drive evidence
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {platforms.map((platform) => {
              const isConnecting = connectingPlatform === platform.id;
              return (
                <div
                  key={platform.id}
                  className="border rounded-lg p-4 space-y-3 hover:border-primary/50 transition-colors"
                >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${platform.color} text-white`}>
                      {platform.icon}
                    </div>
                    <div>
                      <h3 className="font-semibold">{platform.name}</h3>
                      <p className="text-sm text-muted-foreground">
                        {platform.description}
                      </p>
                    </div>
                  </div>
                  {platform.connected ? (
                    <Badge variant="default" className="bg-green-500">
                      <CheckCircle2 className="w-3 h-3 mr-1" />
                      Connected
                    </Badge>
                  ) : (
                    <Badge variant="secondary">
                      <XCircle className="w-3 h-3 mr-1" />
                      Not Connected
                    </Badge>
                  )}
                </div>

                {platform.connected && (
                  <div className="text-sm text-muted-foreground space-y-1">
                    <div className="flex justify-between">
                      <span>Last Sync:</span>
                      <span className="font-medium">{formatLastSync(platform.lastSync)}</span>
                    </div>
                    {platform.itemCount !== undefined && (
                      <div className="flex justify-between">
                        <span>Items Collected:</span>
                        <span className="font-medium">{platform.itemCount}</span>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex gap-2">
                  {platform.connected ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => handleDisconnect(platform.id)}
                    >
                      Disconnect
                    </Button>
                  ) : (
                    <Button
                      variant="default"
                      size="sm"
                      className="flex-1"
                      disabled={connectingPlatform !== null}
                      onClick={() => handleConnect(platform.id)}
                    >
                      {isConnecting ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <ExternalLink className="w-4 h-4 mr-2" />
                      )}
                      {isConnecting ? "Finishing Google connection..." : "Connect"}
                    </Button>
                  )}
                </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
