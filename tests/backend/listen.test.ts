import { createServer, type Server } from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { closeHttpServer, listenHttpServer } from '../../server/listen';
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
