import { createServer, type Server } from 'http';
import { connect } from 'net';
import { once } from 'events';
import { Server as SocketIOServer } from 'socket.io';
import { afterEach, describe, expect, it } from 'vitest';
import { closeHttpServer, closeSharedHttpServer, listenHttpServer } from '../../server/listen';
import {
  isDesktopDevelopmentMode,
  resolveDesktopServerPort,
} from '../../src-main/desktopPort';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  })));
});

describe('HTTP server binding', () => {
  it('returns the OS-assigned port when port zero is requested', async () => {
    const server = createServer((_request, response) => response.end('ok'));
    servers.push(server);
    const port = await listenHttpServer(server, 0, '127.0.0.1');
    expect(port).toBeGreaterThan(0);
    expect(server.address()).toMatchObject({ address: '127.0.0.1', port });
  });

  it('rejects instead of hanging when the requested port is occupied', async () => {
    const first = createServer();
    const second = createServer();
    servers.push(first, second);
    const port = await listenHttpServer(first, 0, '127.0.0.1');
    await expect(listenHttpServer(second, port, '127.0.0.1')).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
  });

  it('closes a listening server idempotently', async () => {
    const server = createServer((_request, response) => response.end('ok'));
    servers.push(server);
    await listenHttpServer(server, 0, '127.0.0.1');
    await closeHttpServer(server);
    expect(server.listening).toBe(false);
    await expect(closeHttpServer(server)).resolves.toBeUndefined();
  });

  it.each(['preconnected', 'in-flight'] as const)('bounds Socket.IO shutdown with an open %s HTTP connection', async (kind) => {
    const server = createServer((_request, response) => response.write('still working'));
    servers.push(server);
    const realtime = new SocketIOServer(server, { serveClient: false });
    const port = await listenHttpServer(server, 0, '127.0.0.1');
    const connected = once(server, 'connection');
    const client = connect(port, '127.0.0.1');
    client.on('error', () => {});
    client.resume();
    await connected;
    if (kind === 'in-flight') {
      const requested = once(server, 'request');
      client.write('GET /unfinished HTTP/1.1\r\nHost: localhost\r\n\r\n');
      await requested;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const closed = closeSharedHttpServer(server, () => new Promise<void>(resolve => { void realtime.close(() => resolve()); }), 25);
      const completed = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2_000); }),
      ]);
      expect(completed, 'Socket.IO waited indefinitely before the HTTP drain deadline was armed').toBe(true);
      expect(server.listening).toBe(false);
    } finally {
      clearTimeout(timer);
      client.destroy();
      await realtime.close();
    }
  });
});

describe('packaged desktop port selection', () => {
  it('uses an ephemeral port when no loopback OAuth callback is configured', () => {
    expect(resolveDesktopServerPort(undefined)).toBe(0);
    expect(resolveDesktopServerPort('https://example.com/oauth/callback')).toBe(0);
  });

  it('preserves the port registered for a loopback OAuth callback', () => {
    expect(resolveDesktopServerPort('http://localhost:3000')).toBe(3000);
    expect(resolveDesktopServerPort('http://127.0.0.1:8768/api/oauth/callback')).toBe(8768);
  });
});

describe('desktop runtime mode', () => {
  it('honors development mode only for an unpackaged Electron process', () => {
    expect(isDesktopDevelopmentMode(false, 'development')).toBe(true);
    expect(isDesktopDevelopmentMode(false, 'production')).toBe(false);
  });

  it('never enables development behavior in a packaged executable', () => {
    expect(isDesktopDevelopmentMode(true, 'development')).toBe(false);
    expect(isDesktopDevelopmentMode(true, 'production')).toBe(false);
    expect(isDesktopDevelopmentMode(true, undefined)).toBe(false);
  });
});
