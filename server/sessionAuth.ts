import jwt, { type JwtPayload } from 'jsonwebtoken';
import { ENV } from './_core/env';
import { isTokenRevoked } from './sessionRevocation';

export type SessionClaims = {
  userId: string;
  iat?: number;
};

function isSessionClaims(payload: string | JwtPayload): payload is JwtPayload & SessionClaims {
  if (typeof payload === 'string') return false;
  if (typeof payload.userId !== 'string' || payload.userId.trim() === '') return false;
  if (payload.iat !== undefined && !Number.isSafeInteger(payload.iat)) return false;
  // Current session cookies have no explicit scope. Accept an explicit session
  // scope for forward compatibility, but reject scanner/integration/purpose JWTs.
  if (payload.scope !== undefined && payload.scope !== 'session') return false;
  if (payload.purpose !== undefined) return false;
  return true;
}

export async function verifySessionToken(token: string): Promise<SessionClaims | null> {
  try {
    const payload = jwt.verify(token, ENV.JWT_SECRET, { algorithms: ['HS256'] });
    if (!isSessionClaims(payload)) return null;
    if (await isTokenRevoked(payload.userId, payload.iat)) return null;
    return { userId: payload.userId, iat: payload.iat };
  } catch {
    return null;
  }
}
