import { randomBytes } from 'crypto';
import { Router, type Request, type Response } from 'express';
import {
  consumeOAuthState,
  exchangeCodeForTokens,
  getAccountInfo,
  isRetryableOAuthNetworkError,
  saveEmailAccount,
} from './oauth2';

const router = Router();
type OAuthProvider = 'gmail' | 'outlook';

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character] as string);
}

function sendCallbackPage(
  res: Response,
  options: { success: boolean; title: string; message: string; status?: number; retry?: boolean }
): void {
  const nonce = randomBytes(18).toString('base64');
  res.status(options.status ?? 200);
  res.setHeader('Cache-Control', 'no-store');
  // This minimal callback page must retain its opener long enough to report
  // completion after returning from a cross-origin identity provider.
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`
  );
  res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(options.title)}</title>
    <style>
      body { font-family: Arial, sans-serif; min-height: 100vh; margin: 0; display: grid; place-items: center; background: #f4f6f8; color: #18212b; }
      main { width: min(420px, calc(100% - 32px)); padding: 32px; box-sizing: border-box; background: #fff; border: 1px solid #d8dee5; border-radius: 8px; text-align: center; }
      .status { width: 48px; height: 48px; margin: 0 auto 16px; display: grid; place-items: center; border-radius: 50%; background: ${options.success ? '#e8f5ec' : '#fdeceb'}; color: ${options.success ? '#247a3d' : '#b42318'}; font-size: 28px; font-weight: 700; }
      h1 { margin: 0 0 10px; font-size: 24px; }
      p { margin: 0 0 24px; color: #52606d; line-height: 1.5; }
      button { border: 0; border-radius: 6px; padding: 11px 20px; background: #1769aa; color: white; font: inherit; cursor: pointer; }
    </style>
  </head>
  <body>
    <main>
      <div class="status" aria-hidden="true">${options.success ? '&#10003;' : '!'}</div>
      <h1>${escapeHtml(options.title)}</h1>
      <p id="message">${escapeHtml(options.message)}</p>
      <button id="action" type="button">${options.retry ? 'Retry connection' : 'Close'}</button>
    </main>
    <script nonce="${nonce}">
      const action = document.getElementById('action');
      const notifyOpener = () => {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({ type: 'laro:oauth-complete', success: ${options.success} }, '*');
        }
      };
      const closePage = () => {
        notifyOpener();
        window.close();
        window.setTimeout(() => {
          document.getElementById('message').textContent = 'You can now close this browser tab and return to LARO.';
          action.textContent = 'Close this tab';
        }, 250);
      };
      ${options.retry
        ? "action.addEventListener('click', () => window.location.reload());"
        : "action.addEventListener('click', closePage); notifyOpener(); window.setTimeout(closePage, 750);"}
    </script>
  </body>
</html>`);
}

function callbackHandler(provider: OAuthProvider) {
  return async (req: Request, res: Response) => {
    let tokenExchangeCompleted = false;
    try {
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      if (!code || !state) {
        sendCallbackPage(res, {
          success: false,
          title: 'Connection failed',
          message: 'The provider did not return the required authorization details.',
          status: 400,
        });
        return;
      }

      const oauthState = consumeOAuthState(state, provider);
      const tokens = await exchangeCodeForTokens(provider, code, oauthState.codeVerifier);
      tokenExchangeCompleted = true;
      const accountInfo = await getAccountInfo(provider, tokens.accessToken);
      if (!accountInfo.email) throw new Error('Provider profile did not include an email address');
      await saveEmailAccount(oauthState.userId, provider, tokens, accountInfo);

      const providerName = provider === 'gmail' ? 'Google' : 'Microsoft';
      sendCallbackPage(res, {
        success: true,
        title: `${providerName} connected`,
        message: `${accountInfo.email} is connected to LARO.`,
      });
    } catch (error) {
      console.error(`[OAuth2] ${provider} callback failed:`, error);
      const retryable = !tokenExchangeCompleted && isRetryableOAuthNetworkError(error);
      sendCallbackPage(res, {
        success: false,
        title: 'Connection failed',
        message: retryable
          ? 'The provider could not be reached temporarily. Retry this connection without starting over.'
          : 'The connection could not be completed. Return to LARO and try again.',
        status: retryable ? 503 : 500,
        retry: retryable,
      });
    }
  };
}

router.get('/api/oauth/gmail/callback', callbackHandler('gmail'));
router.get('/api/oauth/outlook/callback', callbackHandler('outlook'));
router.get('/api/oauth/trello/callback', (_req, res) => {
  sendCallbackPage(res, {
    success: false,
    title: 'Trello unavailable',
    message: 'Trello connection is disabled until secure server-side token storage is available.',
    status: 410,
  });
});

export default router;
