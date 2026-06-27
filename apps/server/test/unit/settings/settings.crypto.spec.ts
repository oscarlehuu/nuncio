import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  encryptValue,
  decryptValue,
  maskSecret,
  loadSettingsKey,
} from '../../../src/settings/settings.crypto';

describe('settings.crypto', () => {
  const key = Buffer.alloc(32, 7); // deterministic 32-byte key for round-trip tests

  describe('encryptValue / decryptValue', () => {
    it('round-trips a plaintext value', () => {
      const ct = encryptValue('sk-cursor-abc123', key);
      expect(ct).not.toBe('sk-cursor-abc123');
      expect(decryptValue(ct, key)).toBe('sk-cursor-abc123');
    });

    it('produces ciphertext with a v1: prefix and an IV component', () => {
      const ct = encryptValue('hello', key);
      expect(ct.startsWith('v1:')).toBe(true);
      const parts = ct.split(':');
      // v1 : <ivHex> : <authTag+ciphertextHex>
      expect(parts).toHaveLength(3);
      expect(parts[1].length).toBeGreaterThan(0);
      expect(parts[2].length).toBeGreaterThan(0);
    });

    it('uses a fresh random IV per encryption (same plaintext → different ciphertext)', () => {
      const a = encryptValue('same', key);
      const b = encryptValue('same', key);
      expect(a).not.toBe(b);
      expect(decryptValue(a, key)).toBe('same');
      expect(decryptValue(b, key)).toBe('same');
    });

    it('throws on tampered ciphertext (GCM auth tag mismatch)', () => {
      const ct = encryptValue('secret', key);
      const flipped = ct.slice(0, -2) + (ct.slice(-2) === '00' ? '01' : '00');
      expect(() => decryptValue(flipped, key)).toThrow();
    });

    it('throws on an unsupported version prefix', () => {
      expect(() => decryptValue('v2:deadbeef:cafe', key)).toThrow(/version/i);
    });

    it('throws on malformed ciphertext (missing segments)', () => {
      expect(() => decryptValue('v1:onlyonepart', key)).toThrow();
    });
  });

  describe('maskSecret', () => {
    it('masks all but the last 4 characters for values >= 4 chars', () => {
      expect(maskSecret('sk-cursor-abc12345')).toBe('••••2345');
    });

    it('masks fully when value is shorter than 4 chars', () => {
      expect(maskSecret('abc')).toBe('•••');
      expect(maskSecret('ab')).toBe('••');
      expect(maskSecret('a')).toBe('•');
    });

    it('returns null for empty/null input', () => {
      expect(maskSecret('')).toBeNull();
      expect(maskSecret(null as unknown as string)).toBeNull();
    });
  });

  describe('loadSettingsKey', () => {
    let dataDir: string;

    beforeEach(() => {
      dataDir = mkdtempSync(join(tmpdir(), 'nuncio-crypto-key-'));
      delete process.env.NUNCIO_SETTINGS_KEY;
    });

    afterEach(() => {
      rmSync(dataDir, { recursive: true, force: true });
      delete process.env.NUNCIO_SETTINGS_KEY;
    });

    it('uses NUNCIO_SETTINGS_KEY (hex) when present', () => {
      const hex = Buffer.alloc(32, 9).toString('hex');
      process.env.NUNCIO_SETTINGS_KEY = hex;
      const loaded = loadSettingsKey(dataDir);
      expect(loaded).toEqual(Buffer.alloc(32, 9));
    });

    it('uses NUNCIO_SETTINGS_KEY (base64) when present', () => {
      const b64 = Buffer.alloc(32, 11).toString('base64');
      process.env.NUNCIO_SETTINGS_KEY = b64;
      const loaded = loadSettingsKey(dataDir);
      expect(loaded).toEqual(Buffer.alloc(32, 11));
    });

    it('generates and persists a key file when env is absent', () => {
      const loaded = loadSettingsKey(dataDir);
      expect(loaded.length).toBe(32);
      const keyPath = join(dataDir, 'settings.key');
      const fromDisk = readFileSync(keyPath);
      expect(fromDisk).toEqual(loaded);
    });

    it('reuses the persisted key file on subsequent loads', () => {
      const first = loadSettingsKey(dataDir);
      const second = loadSettingsKey(dataDir);
      expect(second).toEqual(first);
    });

    it('writes the key file with mode 0600', () => {
      loadSettingsKey(dataDir);
      const stat = statSync(join(dataDir, 'settings.key'));
      // POSIX mode bits — 0o600 = owner read/write only
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it('rejects an env key of the wrong length', () => {
      process.env.NUNCIO_SETTINGS_KEY = 'tooshort';
      expect(() => loadSettingsKey(dataDir)).toThrow(/32.*byte/i);
    });

    it('reuses an existing key file when env is unset (no regeneration)', () => {
      const preExisting = Buffer.alloc(32, 5);
      writeFileSync(join(dataDir, 'settings.key'), preExisting, { mode: 0o600 });
      const loaded = loadSettingsKey(dataDir);
      expect(loaded).toEqual(preExisting);
    });
  });
});
