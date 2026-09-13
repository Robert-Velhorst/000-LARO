import { COOKIE_NAME } from '../shared/const';

export function sessionCookieName(): string {
  const name = process.env.LARO_SESSION_COOKIE_NAME || COOKIE_NAME;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) throw new Error('Invalid session cookie name');
  return name;
}

// Cookies are host-scoped, not port-scoped. Local workspaces need distinct names.
export const SESSION_COOKIE_NAME = sessionCookieName();
