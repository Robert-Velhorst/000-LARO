import jwt from 'jsonwebtoken';
import type { Request } from 'express';

export function verifyLocalTestTicket(req: Request, ticket: string, env: NodeJS.ProcessEnv = process.env) {
  const origin = `http://127.0.0.1:${env.PORT}`;
  if (env.LARO_LOCAL_TEST_ACCESS !== 'true' || env.LARO_WORKSPACE_KIND !== 'local'
      || env.LARO_RUNTIME_MODE !== 'local' || env.HOST !== '127.0.0.1'
      || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')
      || req.headers.origin !== origin || req.headers.host !== `127.0.0.1:${env.PORT}`
      || req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']) {
    throw new Error('Local test access is not available for this request');
  }
  const value = jwt.verify(ticket, env.JWT_SECRET!, {
    algorithms: ['HS256'], audience: 'laro-local-test', issuer: 'laro-local-operator', maxAge: '5m',
  });
  if (typeof value === 'string' || value.purpose !== 'local-test-access'
      || typeof value.sub !== 'string' || typeof value.jti !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.jti) || typeof value.exp !== 'number'
      || typeof value.iat !== 'number' || value.exp - value.iat > 300 || value.userId) {
    throw new Error('Invalid local test ticket');
  }
  return { userId: value.sub, nonce: value.jti };
}
