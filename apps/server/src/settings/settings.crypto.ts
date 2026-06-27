import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * AES-256-GCM encryption for secret-typed settings values.
 *
 * Ciphertext format: `v1:<ivHex>:<authTagCiphertextHex>` where the auth tag is
 * appended to the ciphertext (node:crypto's default GCM layout). The `v1:`
 * prefix lets us swap algorithms later without migrating existing rows.
 */

const VERSION = 'v1';
const IV_LENGTH = 12; // 96-bit IV is the GCM recommendation
const KEY_LENGTH = 32; // AES-256

/** Prefix marker for ciphertext stored in the `settings.value` column. */
export const CIPHERTEXT_PREFIX = `${VERSION}:`;

export function isEncrypted(value: string): boolean {
  return value.startsWith(CIPHERTEXT_PREFIX);
}

export function encryptValue(plaintext: string, key: Buffer): string {
  assertKeyLength(key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('hex')}:${Buffer.concat([authTag, ciphertext]).toString('hex')}`;
}

export function decryptValue(stored: string, key: Buffer): string {
  assertKeyLength(key);
  const parts = stored.split(':');
  if (parts.length < 3) throw new Error('malformed ciphertext: missing segments');
  const [version, ivHex, payloadHex] = parts;
  if (version !== VERSION) throw new Error(`unsupported ciphertext version: ${version}`);
  const iv = Buffer.from(ivHex, 'hex');
  const payload = Buffer.from(payloadHex, 'hex');
  // node:crypto GCM auth tag is 16 bytes; we appended it before the ciphertext.
  const authTag = payload.subarray(0, 16);
  const ciphertext = payload.subarray(16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Mask a secret for API responses. Returns `••••<last4>` for values >= 4 chars,
 * all-bullets for shorter non-empty values, and null for empty/null.
 */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return '•'.repeat(value.length);
  return '••••' + value.slice(-4);
}

/**
 * Load the 32-byte settings encryption key.
 *
 * Resolution:
 *   1. `NUNCIO_SETTINGS_KEY` env (hex or base64) — operator-provided, never persisted by us.
 *   2. `<dataDir>/settings.key` file — generated once per install, mode 0600.
 *
 * Boot-only: this must run after `NUNCIO_DATA_DIR` is resolved but before any
 * secret setting is read/written.
 */
export function loadSettingsKey(dataDir: string): Buffer {
  const envKey = process.env.NUNCIO_SETTINGS_KEY?.trim();
  if (envKey) {
    const buf = Buffer.from(envKey, envKey.match(/^[0-9a-fA-F]+$/i) ? 'hex' : 'base64');
    assertKeyLength(buf);
    return buf;
  }
  const keyPath = join(dataDir, 'settings.key');
  if (existsSync(keyPath)) {
    const buf = readFileSync(keyPath);
    assertKeyLength(buf);
    return buf;
  }
  const generated = randomBytes(KEY_LENGTH);
  writeFileSync(keyPath, generated, { mode: 0o600 });
  return generated;
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`settings key must be exactly 32 bytes (got ${key.length})`);
  }
}
