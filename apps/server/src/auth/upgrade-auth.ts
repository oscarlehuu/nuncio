import { isLoopbackAddress } from '../terminal/loopback';
import { isAuthorizedRequest, type AuthRequestLike, type TokenValidator } from './auth-request';

export interface RemoteTrust {
  isTrustedRemote(remoteAddress: unknown): Promise<boolean>;
}

/**
 * WebSocket upgrade authorization — the same rule the HTTP AuthGuard enforces
 * on /api routes: loopback always passes; remote clients need the access token
 * (auth cookie or Bearer header) or a trusted tailnet identity. Without a
 * token validator/trust checker (tests, callers that opt out) remote is refused.
 */
export async function isAuthorizedUpgrade(
  req: AuthRequestLike,
  authTokens?: TokenValidator,
  trust?: RemoteTrust,
): Promise<boolean> {
  if (isLoopbackAddress(req.socket?.remoteAddress)) {
    return true;
  }
  if (authTokens && isAuthorizedRequest(req, authTokens)) {
    return true;
  }
  if (trust) {
    try {
      return await trust.isTrustedRemote(req.socket?.remoteAddress);
    } catch {
      return false;
    }
  }
  return false;
}
