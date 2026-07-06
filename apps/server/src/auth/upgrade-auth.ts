import { isLoopbackAddress } from '../terminal/loopback';
import { isAuthorizedRequest, type AuthRequestLike, type TokenValidator } from './auth-request';
import { deviceAuthDecision, type DeviceValidator } from './device-token';

export interface RemoteTrust {
  isTrustedRemote(remoteAddress: unknown): Promise<boolean>;
}

/**
 * The outcome of a WS upgrade check. `deviceId` is set only when the connection
 * was authorized by an `nd1.` device bearer — callers use it to tag the socket
 * so a later revoke of that device can sever the live connection, not just block
 * future upgrades.
 */
export interface UpgradeAuthorization {
  authorized: boolean;
  deviceId?: string;
}

/**
 * WebSocket upgrade authorization — the same rule the HTTP AuthGuard enforces
 * on /api routes: loopback always passes; remote clients need the access token
 * (auth cookie or Bearer header), a valid device bearer, or a trusted tailnet
 * identity. Without a token validator/trust checker (tests, callers that opt
 * out) remote is refused. Reports the device principal when one authorized.
 *
 * Precedence invariant: a presented device credential DECIDES the outcome — once
 * an `nd1.` bearer is parseable, its verification result stands and never falls
 * back to the broader global-token/cookie or tailnet branches. This keeps REST
 * and WS agreeing and, on success, guarantees the socket is tagged for revocation.
 */
export async function authorizeUpgrade(
  req: AuthRequestLike,
  authTokens?: TokenValidator,
  trust?: RemoteTrust,
  devices?: DeviceValidator,
): Promise<UpgradeAuthorization> {
  if (isLoopbackAddress(req.socket?.remoteAddress)) {
    return { authorized: true };
  }
  const device = deviceAuthDecision(req, devices);
  if (device.kind === 'accept') {
    return { authorized: true, deviceId: device.deviceId };
  }
  if (device.kind === 'reject') {
    return { authorized: false };
  }
  if (authTokens && isAuthorizedRequest(req, authTokens)) {
    return { authorized: true };
  }
  if (trust) {
    try {
      return { authorized: await trust.isTrustedRemote(req.socket?.remoteAddress) };
    } catch {
      return { authorized: false };
    }
  }
  return { authorized: false };
}

/** Boolean-only view of {@link authorizeUpgrade} for call sites that ignore the principal. */
export async function isAuthorizedUpgrade(
  req: AuthRequestLike,
  authTokens?: TokenValidator,
  trust?: RemoteTrust,
  devices?: DeviceValidator,
): Promise<boolean> {
  return (await authorizeUpgrade(req, authTokens, trust, devices)).authorized;
}
