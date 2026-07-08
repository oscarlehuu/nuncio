/** API client for mobile device pairing + paired-device management. */

/** Result of minting a pairing code — the QR encodes { v, code, urls }. */
export interface PairingStart {
  code: string;
  /** Absolute epoch ms; the countdown is derived from this, never a local decrement. */
  expiresAt: number;
  urls: string[];
  hints: string[];
}

/** A paired mobile device, as shown in the settings list. */
export interface Device {
  id: string;
  name: string;
  platform: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  revoked: boolean;
}

/**
 * Mints a single-use pairing code (5 min TTL) plus candidate URLs and hints.
 * Minting invalidates any prior code, so callers should treat each result as
 * the only live code.
 */
export async function startPairing(): Promise<PairingStart> {
  const res = await fetch('/api/pairing/start', { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to start pairing (${res.status})`);
  return (await res.json()) as PairingStart;
}

export async function listDevices(): Promise<Device[]> {
  const res = await fetch('/api/devices');
  if (!res.ok) throw new Error(`Failed to load devices (${res.status})`);
  return (await res.json()) as Device[];
}

/** Revokes a device — the phone is locked out on its next request or WS upgrade. */
export async function revokeDevice(id: string): Promise<void> {
  const res = await fetch(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to revoke device (${res.status})`);
}
