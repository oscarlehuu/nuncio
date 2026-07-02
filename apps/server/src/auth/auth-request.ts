import { isLoopbackAddress } from '../terminal/loopback';

export const AUTH_COOKIE_NAME = 'nuncio_token';

/** Minimal structural view of an HTTP/upgrade request — keeps this usable from both the Nest guard and the raw WS upgrade handler. */
export interface AuthRequestLike {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

export interface TokenValidator {
  isValidToken(candidate: unknown): boolean;
}

export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : null;
}

export function cookieToken(cookieHeader: string | string[] | undefined): string | null {
  const value = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  if (typeof value !== 'string' || !value) {
    return null;
  }
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      continue;
    }
    if (part.slice(0, eq).trim() !== AUTH_COOKIE_NAME) {
      continue;
    }
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/**
 * The single authorization predicate: loopback connections are always trusted
 * (local desktop app / dev need zero config); everything else must present the
 * server token as a Bearer header or the auth cookie.
 */
export function isAuthorizedRequest(req: AuthRequestLike, tokens: TokenValidator): boolean {
  if (isLoopbackAddress(req.socket?.remoteAddress)) {
    return true;
  }
  const bearer = bearerToken(req.headers?.authorization);
  if (bearer && tokens.isValidToken(bearer)) {
    return true;
  }
  const cookie = cookieToken(req.headers?.cookie);
  return cookie !== null && tokens.isValidToken(cookie);
}
