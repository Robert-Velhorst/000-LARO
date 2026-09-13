import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { startGoogleCallbackBridge } from '../scripts/local-google-callback.mjs';

test('Google callback bridge is loopback-only, narrowly routed, strips credentials and closes', async () => {
  const received = [];
  const upstream = http.createServer((req, res) => {
    received.push({ path: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization });
    res.writeHead(400, { 'Content-Type': 'text/html', 'Cross-Origin-Opener-Policy': 'unsafe-none' }).end('Controlled callback');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const bridge = await startGoogleCallbackBridge(origin, upstream.address().port);
  try {
    assert.equal(bridge.address().address, '127.0.0.1');
    const response = await fetch(`${origin}/api/oauth/gmail/callback?error=access_denied`, { headers: { Cookie: 'private=example', Authorization: 'Bearer example' } });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'unsafe-none');
    assert.equal(await response.text(), 'Controlled callback');
    assert.deepEqual(received, [{ path: '/api/oauth/gmail/callback?error=access_denied', cookie: undefined, authorization: undefined }]);
    assert.equal((await fetch(`${origin}/api/health`)).status, 404);
    assert.equal((await fetch(`${origin}/api/oauth/gmail/callback`, { method: 'POST' })).status, 404);
    const wrongHostStatus = await new Promise((resolve, reject) => {
      const request = http.get(`${origin}/api/oauth/gmail/callback`, { headers: { Host: 'untrusted.example' } }, (response) => {
        response.resume(); resolve(response.statusCode);
      });
      request.on('error', reject);
    });
    assert.equal(wrongHostStatus, 404);
    await assert.rejects(startGoogleCallbackBridge('https://example.com:8768', 5184));
    await assert.rejects(startGoogleCallbackBridge(origin, upstream.address().port), /EADDRINUSE/);
    assert.equal(received.length, 1);
  } finally {
    await new Promise(resolve => bridge.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
  }
});
