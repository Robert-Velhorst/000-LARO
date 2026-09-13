import http from 'node:http';

// A dedicated loopback callback, not a general proxy or a second LARO API.
export async function startGoogleCallbackBridge(redirectBase, targetPort) {
  const redirect = new URL(redirectBase);
  if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port
    || redirect.pathname !== '/' || redirect.search || redirect.hash || redirect.username || redirect.password
    || !Number.isInteger(targetPort) || targetPort < 1024 || targetPort > 65535) {
    throw new Error('Google callback bridge requires explicit loopback ports');
  }
  if (Number(redirect.port) === targetPort) return null;
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const callbackPath = '/api/oauth/gmail/callback';
    if (req.method !== 'GET' || req.headers.host !== redirect.host || !req.url
      || req.url.length > 16384 || (req.url !== callbackPath && !req.url.startsWith(`${callbackPath}?`))) {
      res.writeHead(404).end('Not found');
      return;
    }
    const upstream = http.request({
      hostname: '127.0.0.1', port: targetPort, method: 'GET', path: req.url,
      headers: { Accept: 'text/html' }, timeout: 60000,
    }, (response) => {
      res.writeHead(response.statusCode || 502, response.headers);
      response.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('LARO is unavailable. Return to LARO and reconnect Google.');
    });
    res.on('close', () => upstream.destroy());
    upstream.end();
  });
  server.requestTimeout = 65000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(redirect.port), '127.0.0.1', resolve);
  });
  return server;
}
