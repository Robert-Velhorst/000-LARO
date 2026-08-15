import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { isElectron } from '@/lib/electronApiShim';

const OAUTH_WAIT_TIMEOUT_MS = 3 * 60 * 1_000;
const OAUTH_STATUS_POLL_INTERVAL_MS = 1_500;
const OAUTH_WINDOW_CHECK_INTERVAL_MS = 750;

interface GoogleOAuthConnectionOptions {
  connected: boolean;
  refreshConnection: () => Promise<boolean>;
  onConnected?: () => void;
}

export function useGoogleOAuthConnection({
  connected,
  refreshConnection,
  onConnected,
}: GoogleOAuthConnectionOptions) {
  const [connecting, setConnecting] = useState(false);
  const connectingRef = useRef(false);
  const refreshPromiseRef = useRef<Promise<boolean | null> | null>(null);
  const oauthWindowRef = useRef<Window | null>(null);
  const oauthCallbackOriginRef = useRef<string | null>(null);
  const refreshConnectionRef = useRef(refreshConnection);
  const onConnectedRef = useRef(onConnected);

  useEffect(() => {
    refreshConnectionRef.current = refreshConnection;
    onConnectedRef.current = onConnected;
  }, [onConnected, refreshConnection]);

  const reset = useCallback(() => {
    connectingRef.current = false;
    refreshPromiseRef.current = null;
    oauthWindowRef.current = null;
    oauthCallbackOriginRef.current = null;
    setConnecting(false);
  }, []);

  const finishConnected = useCallback(() => {
    if (!connectingRef.current) return;
    oauthWindowRef.current?.close();
    reset();
    toast.success('Google successfully connected');
    onConnectedRef.current?.();
  }, [reset]);

  const stopWithError = useCallback((message: string) => {
    if (!connectingRef.current) return;
    oauthWindowRef.current?.close();
    reset();
    toast.error(message);
  }, [reset]);

  const refreshAndFinish = useCallback((): Promise<boolean | null> => {
    if (!connectingRef.current) return Promise.resolve(false);
    if (refreshPromiseRef.current) return refreshPromiseRef.current;

    const refreshPromise = refreshConnectionRef.current()
      .then((isConnected) => {
        if (isConnected) finishConnected();
        return isConnected;
      })
      .catch(() => null)
      .finally(() => {
        refreshPromiseRef.current = null;
      });
    refreshPromiseRef.current = refreshPromise;
    return refreshPromise;
  }, [finishConnected]);

  useEffect(() => {
    if (connecting && connected) finishConnected();
  }, [connected, connecting, finishConnected]);

  useEffect(() => {
    if (!connecting) return;

    const handleOAuthComplete = (event: MessageEvent) => {
      if (
        event.origin !== oauthCallbackOriginRef.current ||
        event.data?.type !== 'laro:oauth-complete'
      ) return;
      if (event.data.success === true) {
        void refreshAndFinish();
      } else {
        stopWithError('The Google connection was not completed.');
      }
    };
    const refreshOnReturn = () => {
      if (document.visibilityState === 'visible') void refreshAndFinish();
    };
    const statusPoll = window.setInterval(() => {
      void refreshAndFinish();
    }, OAUTH_STATUS_POLL_INTERVAL_MS);
    const windowCheck = window.setInterval(() => {
      if (!oauthWindowRef.current?.closed) return;
      oauthWindowRef.current = null;
      void refreshAndFinish().then((isConnected) => {
        if (isConnected === false) {
          stopWithError('Google authorization closed before the connection completed.');
        }
      });
    }, OAUTH_WINDOW_CHECK_INTERVAL_MS);
    const timeout = window.setTimeout(() => {
      stopWithError('Google authorization timed out. Please try again.');
    }, OAUTH_WAIT_TIMEOUT_MS);

    window.addEventListener('message', handleOAuthComplete);
    window.addEventListener('focus', refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.clearInterval(statusPoll);
      window.clearInterval(windowCheck);
      window.clearTimeout(timeout);
      window.removeEventListener('message', handleOAuthComplete);
      window.removeEventListener('focus', refreshOnReturn);
      document.removeEventListener('visibilitychange', refreshOnReturn);
    };
  }, [connecting, refreshAndFinish, stopWithError]);

  const beginConnection = useCallback((authUrl: string): boolean => {
    if (connectingRef.current) return false;
    const authorizationUrl = new URL(authUrl);
    const redirectUri = authorizationUrl.searchParams.get('redirect_uri');
    if (!redirectUri) throw new Error('OAuth callback URL is missing');

    const oauthWindow = window.open(authUrl, 'laro-google-oauth', 'popup,width=520,height=720');
    if (!oauthWindow && !isElectron()) {
      toast.error('Your browser blocked the Google authorization window. Allow popups for LARO and try again.');
      return false;
    }

    oauthWindowRef.current = oauthWindow;
    oauthCallbackOriginRef.current = new URL(redirectUri).origin;
    connectingRef.current = true;
    setConnecting(true);
    toast.info('Google sign-in opened in your browser. Return to LARO when finished.');
    return true;
  }, []);

  const cancelConnection = useCallback(() => {
    if (!connectingRef.current) return;
    oauthWindowRef.current?.close();
    reset();
    toast.message('Google connection cancelled');
  }, [reset]);

  return { connecting, beginConnection, cancelConnection };
}
