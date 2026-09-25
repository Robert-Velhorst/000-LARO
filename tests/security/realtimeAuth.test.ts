import { createServer, type Server as HttpServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV } from '../../server/_core/env';
import {
  closeRealtimeServer,
  emitRealtimeNotification,
  initializeRealtimeServer,
} from '../../server/realtime';
import { SESSION_COOKIE_NAME } from '../../server/sessionCookie';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildUser } from '../factories';

const suite = sqliteAvailable ? describe : describe.skip;

function connect(url: string, token: string): Socket {
  return io(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    extraHeaders: { Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` },
  });
}

function connected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
}

function rejected(socket: Socket): Promise<Error> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => reject(new Error('Unexpected realtime connection')));
    socket.once('connect_error', (error) => resolve(error));
  });
}

suite('realtime session authorization', () => {
  let app: TestApp;
  let server: HttpServer;
  let origin: string;
  const owner = buildUser({ id: 'REALTIME_OWNER', email: 'realtime-owner@example.com' });
  const other = buildUser({ id: 'REALTIME_OTHER', email: 'realtime-other@example.com' });
  const sockets: Socket[] = [];

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([owner, other]);
    server = createServer();
    initializeRealtimeServer(server);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await closeRealtimeServer();
    if (server.listening) await new Promise<void>((resolve) => {
      server.close(() => { resolve(); });
    });
    app?.cleanup();
  });

  it('rejects a legacy scanner-scoped JWT before it can join an owner room', async () => {
    const scannerToken = jwt.sign(
      { userId: owner.id, scope: 'evidence-scanner' },
      ENV.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '15m' },
    );
    const scanner = connect(origin, scannerToken);
    sockets.push(scanner);

    const error = await rejected(scanner);
    expect(error.message).toBe('UNAUTHORIZED');
    expect(scanner.connected).toBe(false);
  });

  it('delivers owner events only to a valid session for that owner', async () => {
    const ownerSocket = connect(origin, jwt.sign(
      { userId: owner.id },
      ENV.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '15m' },
    ));
    const otherSocket = connect(origin, jwt.sign(
      { userId: other.id, scope: 'session' },
      ENV.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '15m' },
    ));
    sockets.push(ownerSocket, otherSocket);
    await Promise.all([connected(ownerSocket), connected(otherSocket)]);

    const ownerEvent = new Promise<unknown>((resolve) => {
      ownerSocket.once('notification', resolve);
    });
    let leaked = false;
    otherSocket.once('notification', () => { leaked = true; });
    emitRealtimeNotification(owner.id, { title: 'Owner-only event' });

    await expect(ownerEvent).resolves.toMatchObject({ title: 'Owner-only event' });
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(leaked).toBe(false);
  });
});
