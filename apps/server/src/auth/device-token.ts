import { bearerToken, type AuthRequestLike } from './auth-request';

export interface DeviceBearer {
  deviceId: string;
  secret: string;
}

export interface DeviceValidator {
  /**
   * Verifies a device id + secret against the stored hashes. Returns true only
   * for a live (non-revoked) device whose current or one-generation-prev secret
   * matches. Implementations may mutate state on success (rotation confirm,
   * last-seen touch), so this is a single-shot authorization check.
   */
  verifyDevice(deviceId: string, secret: string): boolean;
}

/**
 * A {@link DeviceValidator} that also notifies on revocation, so a WS server can
 * sever the live connections a now-revoked device opened. `onRevoke` returns an
 * unsubscribe the server calls on teardown to avoid leaking the listener.
 */
export interface RevocableDeviceValidator extends DeviceValidator {
  onRevoke(listener: (deviceId: string) => void): () => void;
}

const DEVICE_PREFIX = 'nd1';
// base64url alphabet only — no dots — so the secret can never smuggle an extra
// separator and split() always yields exactly the three expected parts.
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Parses `Bearer nd1.<deviceId>.<deviceSecret>` into its parts, or null if the
 * header is absent, not the device scheme, or malformed. The global server
 * token carries no dots, so it never collides with this branch.
 */
export function parseDeviceBearer(header: string | string[] | undefined): DeviceBearer | null {
  const raw = bearerToken(header);
  if (!raw) {
    return null;
  }
  const parts = raw.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [prefix, deviceId, secret] = parts;
  if (prefix !== DEVICE_PREFIX) {
    return null;
  }
  if (!deviceId || !secret || !BASE64URL.test(deviceId) || !BASE64URL.test(secret)) {
    return null;
  }
  return { deviceId, secret };
}

/**
 * Whether a Bearer value claims the device scheme, i.e. starts with the `nd1.`
 * prefix — regardless of whether the rest is well-formed. Collision-safe: the
 * global server token is base64url (no dots), so no legitimate non-device
 * credential can start with `nd1.`.
 */
function claimsDeviceScheme(header: string | string[] | undefined): boolean {
  const raw = bearerToken(header);
  return raw !== null && raw.startsWith(`${DEVICE_PREFIX}.`);
}

/**
 * Outcome of the device-credential branch:
 * - `none`   — the caller presented no device credential at all (no Authorization
 *              header, a non-Bearer scheme, or a Bearer token not prefixed `nd1.`);
 *              the caller runs its other branches (global token/cookie, tailnet).
 * - `accept` — a valid device bearer; authorized as `deviceId`.
 * - `reject` — a Bearer value that claims the `nd1.` scheme but is either
 *              malformed (bad grammar/charset) or fails verification (wrong secret
 *              or revoked device). It must NOT fall back to broader credentials.
 */
export type DeviceAuthDecision =
  | { kind: 'none' }
  | { kind: 'accept'; deviceId: string }
  | { kind: 'reject' };

/**
 * A presented device credential DECIDES the outcome — it never falls back to
 * broader credentials. The moment a Bearer value claims the `nd1.` scheme, this
 * returns `accept` (valid) or `reject` (malformed, wrong secret, or revoked); a
 * caller cannot deliberately malform the header to slip onto the cookie/tailnet
 * path. `none` is reserved for requests carrying no device credential at all.
 */
export function deviceAuthDecision(req: AuthRequestLike, devices?: DeviceValidator): DeviceAuthDecision {
  if (!devices) {
    return { kind: 'none' };
  }
  const bearer = parseDeviceBearer(req.headers?.authorization);
  if (!bearer) {
    // A header that claims the device scheme but is malformed must reject, not
    // fall through — otherwise malforming it becomes a way to pick the fallback.
    return claimsDeviceScheme(req.headers?.authorization) ? { kind: 'reject' } : { kind: 'none' };
  }
  return devices.verifyDevice(bearer.deviceId, bearer.secret)
    ? { kind: 'accept', deviceId: bearer.deviceId }
    : { kind: 'reject' };
}

/**
 * Boolean view of {@link deviceAuthDecision} — true only for an accepted device
 * bearer. Kept for call sites that only need "did the device branch authorize".
 */
export function isAuthorizedDevice(req: AuthRequestLike, devices?: DeviceValidator): boolean {
  return deviceAuthDecision(req, devices).kind === 'accept';
}
