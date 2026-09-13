import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import type { Request } from 'express';
import { verifyLocalTestTicket } from '../../server/localTestAccess';

const env = { HOST: '127.0.0.1', PORT: '5184', LARO_RUNTIME_MODE: 'local', LARO_WORKSPACE_KIND: 'local',
  LARO_LOCAL_TEST_ACCESS: 'true', JWT_SECRET: randomBytes(32).toString('hex') };
const request = () => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { origin: 'http://127.0.0.1:5184', host: '127.0.0.1:5184' } }) as Request;
const ticket = (expiresIn: number = 300) => jwt.sign({ purpose: 'local-test-access' }, env.JWT_SECRET,
  { subject: 'owner', jwtid: randomBytes(32).toString('hex'), issuer: 'laro-local-operator', audience: 'laro-local-test', expiresIn });

describe('explicit local test access', () => {
  it('accepts a short-lived owner ticket without turning the ticket itself into a session', () => {
    const token = ticket();
    expect(verifyLocalTestTicket(request(), token, env).userId).toBe('owner');
    expect(jwt.decode(token)).not.toHaveProperty('userId');
  });
  it.each(['LARO_LOCAL_TEST_ACCESS', 'LARO_RUNTIME_MODE', 'LARO_WORKSPACE_KIND', 'HOST'])('requires the local opt-in: %s', key => {
    expect(() => verifyLocalTestTicket(request(), ticket(), { ...env, [key]: '' })).toThrow();
  });
  it.each(['origin', 'host', 'x-forwarded-for', 'x-forwarded-host'])('rejects foreign/proxied %s', header => {
    const req = request(); req.headers[header] = 'https://foreign.example';
    expect(() => verifyLocalTestTicket(req, ticket(), env)).toThrow();
  });
  it('rejects non-loopback callers', () => {
    const req = { ...request(), socket: { remoteAddress: '192.0.2.10' } } as Request;
    expect(() => verifyLocalTestTicket(req, ticket(), env)).toThrow();
  });
  it.each([-1, 301])('rejects expired or overlong tickets (%s seconds)', expiry => {
    expect(() => verifyLocalTestTicket(request(), ticket(expiry), env)).toThrow();
  });
  it('rejects tampered tickets', () => {
    expect(() => verifyLocalTestTicket(request(), ticket() + 'x', env)).toThrow();
  });
});
