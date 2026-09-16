/**
 * Closing Partial phases with real, tested code:
 *   007/030/D4 — authenticated token crypto
 *   080/D5    — CSRF origin guard + strict CORS
 *   015       — evidence content hashing (provenance)
 *   023       — real ZIP evidence export
 *   027       — reminder sweep (idempotent)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildUser, buildCase } from '../factories';
import { encryptSecret, decryptSecret, isCurrentScheme } from '../../server/crypto';
import { isAllowedOrigin, corsMiddleware, csrfGuard } from '../../server/_core/csrf';

const suite = sqliteAvailable ? describe : describe.skip;

// ---- Pure security units (no DB) ----
describe('007/030 (D4) — authenticated token crypto', () => {
  it('round-trips and uses the authenticated (gcm) scheme', () => {
    const token = 'ya29.super-secret-oauth-token-value';
    const enc = encryptSecret(token);
    expect(isCurrentScheme(enc)).toBe(true);      // AES-256-GCM, versioned prefix
    expect(enc).not.toContain(token);             // ciphertext, not plaintext
    expect(decryptSecret(enc)).toBe(token);       // round-trips
  });

  it('detects tampering (GCM auth tag) instead of returning garbage', () => {
    const enc = encryptSecret('secret');
    // Flip a hex char in the ciphertext segment.
    const parts = enc.split(':');
    parts[3] = parts[3].replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    const tampered = parts.join(':');
    expect(decryptSecret(tampered)).toBe('');     // fails closed, not silently wrong
  });
});

describe('080 (D5) — CSRF origin guard', () => {
  const run = (method: string, headers: Record<string, string>) => {
    let status = 200; let body: any = null; let nexted = false;
    const req: any = {
      method,
      headers,
      protocol: 'http',
      get: (name: string) => name.toLowerCase() === 'host' ? headers.host : undefined,
      socket: {},
    };
    const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { body = b; return res; } };
    csrfGuard(req, res, () => { nexted = true; });
    return { status, body, nexted };
  };

  const runCors = (method: string, headers: Record<string, string>) => {
    let status = 200; let nexted = false;
    const responseHeaders: Record<string, string> = {};
    const req: any = {
      method,
      headers,
      protocol: 'http',
      get: (name: string) => name.toLowerCase() === 'host' ? headers.host : undefined,
      socket: {},
    };
    const res: any = {
      setHeader: (name: string, value: string) => { responseHeaders[name] = value; },
      sendStatus: (value: number) => { status = value; return res; },
    };
    corsMiddleware(req, res, () => { nexted = true; });
    return { status, nexted, responseHeaders };
  };

  const withOriginEnvironment = <T>(
    values: { nodeEnv: string; allowedOrigins?: string },
    callback: () => T,
  ): T => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousAllowedOrigins = process.env.ALLOWED_ORIGINS;
    process.env.NODE_ENV = values.nodeEnv;
    if (values.allowedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = values.allowedOrigins;
    try {
      return callback();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousAllowedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
      else process.env.ALLOWED_ORIGINS = previousAllowedOrigins;
    }
  };

  it('allows documented development origins only in development', () => {
    withOriginEnvironment({ nodeEnv: 'development' }, () => {
      expect(isAllowedOrigin('http://localhost:3000')).toBe(true);
      expect(run('POST', { origin: 'http://localhost:3000' }).nexted).toBe(true);
    });
    withOriginEnvironment({ nodeEnv: 'production' }, () => {
      expect(isAllowedOrigin('http://localhost:3000')).toBe(false);
    });
  });
  it('rejects a cross-site origin on mutations', () => {
    const r = run('POST', { origin: 'http://evil.example', host: '127.0.0.1:45678' });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });
  it('allows the exact same origin on an ephemeral desktop port', () => {
    withOriginEnvironment({ nodeEnv: 'production' }, () => {
      const origin = 'http://127.0.0.1:45678';
      const mutation = run('POST', { origin, host: '127.0.0.1:45678' });
      const cors = runCors('OPTIONS', { origin, host: '127.0.0.1:45678' });
      expect(mutation.nexted).toBe(true);
      expect(cors.status).toBe(200);
      expect(cors.responseHeaders['Access-Control-Allow-Credentials']).toBe('true');
    });
  });
  it('denies another loopback port credentialed CORS and mutation access in production', () => {
    withOriginEnvironment({ nodeEnv: 'production' }, () => {
      const headers = { origin: 'http://localhost:5173', host: '127.0.0.1:45678' };
      const mutation = run('POST', headers);
      const cors = runCors('OPTIONS', headers);
      expect(mutation.nexted).toBe(false);
      expect(mutation.status).toBe(403);
      expect(cors.status).toBe(403);
      expect(cors.responseHeaders['Access-Control-Allow-Origin']).toBeUndefined();
      expect(cors.responseHeaders['Access-Control-Allow-Credentials']).toBeUndefined();
    });
  });
  it('allows the explicitly configured public reverse-proxy origin', () => {
    withOriginEnvironment({
      nodeEnv: 'production',
      allowedOrigins: 'https://laro.example.test',
    }, () => {
      const headers = { origin: 'https://laro.example.test', host: 'laro.internal:3000' };
      const mutation = run('POST', headers);
      const cors = runCors('OPTIONS', headers);
      expect(mutation.nexted).toBe(true);
      expect(cors.status).toBe(200);
      expect(cors.responseHeaders['Access-Control-Allow-Origin']).toBe('https://laro.example.test');
    });
  });
  it('allows same-origin/native requests with no Origin/Referer', () => {
    expect(run('POST', {}).nexted).toBe(true);
  });
  it('never guards safe methods', () => {
    expect(run('GET', { origin: 'http://evil.example' }).nexted).toBe(true);
  });
});

// ---- DB-backed features ----
suite('015 / 023 / 027 — evidence provenance, zip export, reminders', () => {
  let app: TestApp;
  const U = { id: 'USR_H1', name: 'H', role: 'user', email: 'h1@example.com' };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser({ id: U.id, email: U.email }));
  });
  afterAll(() => app?.cleanup());

  it('015 — createEvidenceFile stores a sha256 content hash in metadata', async () => {
    await app.db.insert(app.schema.cases).values(buildCase({ id: 'CASE_H', userId: U.id }));
    const { createEvidenceFile } = await import('../../server/evidence');
    const id = await createEvidenceFile(U.id, { caseId: 'CASE_H', title: 'Contract', type: 'document', content: 'hello evidence' });
    const [row] = await app.db.select().from(app.schema.evidence).where(
      (await import('drizzle-orm')).eq(app.schema.evidence.id, id)
    );
    const meta = JSON.parse(row.metadata);
    expect(meta.hashAlgo).toBe('sha256');
    expect(meta.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('023 — cases.exportZip returns a real, non-empty zip package', async () => {
    const res = await app.makeCaller(U).cases.exportZip({ caseId: 'CASE_H' });
    expect(res.format).toBe('laro-case-zip/v2');
    expect(res.url).toMatch(/^\/api\/case-export\/[A-Za-z0-9_-]{43}\.zip$/);
    const { createCaseZipStream } = await import('../../server/evidenceExport');
    const streamed = await createCaseZipStream(U.id, 'CASE_H');
    const chunks: Buffer[] = [];
    for await (const chunk of streamed.stream) chunks.push(Buffer.from(chunk));
    await streamed.completion;
    const buf = Buffer.concat(chunks);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.slice(0, 2).toString('latin1')).toBe('PK'); // ZIP magic bytes
  });

  it('007 — session revocation invalidates tokens issued before the revoke', async () => {
    const { revokeUserSessions, isTokenRevoked } = await import('../../server/sessionRevocation');
    const nowSec = Math.floor(Date.now() / 1000);
    const oldToken = nowSec - 60;   // issued a minute ago
    const futureToken = nowSec + 60; // issued after the revoke instant

    expect(await isTokenRevoked(U.id, oldToken)).toBe(false); // nothing revoked yet
    await revokeUserSessions(U.id);
    expect(await isTokenRevoked(U.id, oldToken)).toBe(true);    // old session killed
    expect(await isTokenRevoked(U.id, futureToken)).toBe(false); // a fresh login still works
  });

  it('027 — reminders create notifications and are idempotent per day', async () => {
    // High-urgency case with no evidence → an "urgent-no-evidence" reminder.
    await app.db.insert(app.schema.cases).values(buildCase({ id: 'CASE_REM', userId: U.id, urgency: 'High', legalAreas: JSON.stringify(['Employment Law']) }));
    const first = await app.makeCaller(U).notifications.runReminders();
    expect(first.created).toBeGreaterThan(0);
    const second = await app.makeCaller(U).notifications.runReminders();
    expect(second.created).toBe(0); // idempotent — no duplicate the same day
    const notes = await app.makeCaller(U).notifications.list({});
    expect(notes.some((n: any) => /Reminder/i.test(n.title))).toBe(true);
  });
});
