import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { SettingsRepository } from './persistence/settings.repository';
import { SETTING_DEFINITIONS, getSettingDefinition, isSecretSetting } from './settings.registry';
import {
  decryptValue,
  encryptValue,
  isEncrypted,
  maskSecret,
} from './settings.crypto';
import type { SettingDto, SettingDefinition } from './settings.types';

/** DI token for the 32-byte AES-256-GCM key used to encrypt secret settings. */
export const SETTINGS_KEY = Symbol('SETTINGS_KEY');

type ChangeListener = (key: string) => void;

/**
 * Core settings facade. Owns the resolution chain (DB → env → default),
 * transparent encryption of secret-typed values, and change notification
 * (so AgentRegistry can bust provider caches when a credential flips).
 *
 * The repository stores raw strings; this service encrypts before `set` and
 * decrypts after `get` for secrets. Env vars are honoured as fallback so
 * existing deployments keep working without any DB writes (back-compat).
 */
@Injectable()
export class SettingsService {
  private readonly listeners = new Set<ChangeListener>();
  private readonly key: Buffer;

  constructor(
    private readonly repo: SettingsRepository,
    @Inject(SETTINGS_KEY) key: unknown,
  ) {
    this.key = key as Buffer;
  }

  /** All registered setting keys (for diagnostics / health). */
  keys(): string[] {
    return SETTING_DEFINITIONS.map((d) => d.key);
  }

  /** Register a listener fired (with the key) whenever a setting changes. Returns an unsubscribe. */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Resolve a setting value: DB row → env var → registry default → undefined.
   * For secrets, the DB value is decrypted before return.
   */
  resolve(key: string): string | undefined {
    return this.resolveSource(key).value;
  }

  /** Like resolve() but also reports which source provided the value (or null). */
  resolveSource(key: string): { value: string | undefined; source: 'db' | 'env' | 'default' | null } {
    const def = this.requireDefinition(key);
    const dbRow = this.repo.get(key);
    if (dbRow) {
      const decoded = this.tryDecode(key, dbRow.value);
      if (decoded !== undefined) {
        return { value: decoded, source: 'db' };
      }
      // Corrupt ciphertext or wrong SETTINGS_KEY — fall through to env/default.
    }
    const envValue = this.readEnv(def);
    if (envValue !== undefined) return { value: envValue, source: 'env' };
    if (def.default !== undefined) return { value: def.default, source: 'default' };
    return { value: undefined, source: null };
  }

  /** Persist a value. Secrets are encrypted at rest. Fires onChange. */
  set(key: string, value: string): void {
    this.requireDefinition(key);
    const stored = isSecretSetting(key) ? encryptValue(value, this.key) : value;
    this.repo.set(key, stored);
    this.emit(key);
  }

  /** Remove the DB row so resolve falls back to env/default. Fires onChange. */
  clear(key: string): void {
    this.requireDefinition(key);
    this.repo.delete(key);
    this.emit(key);
  }

  /** All settings as DTOs (secrets masked, never raw). */
  list(): SettingDto[] {
    return SETTING_DEFINITIONS.map((def) => this.toDto(def));
  }

  /** One setting as a DTO, or null for an unknown key. */
  get(key: string): SettingDto | null {
    const def = getSettingDefinition(key);
    return def ? this.toDto(def) : null;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private toDto(def: SettingDefinition): SettingDto {
    const { value, source } = this.resolveSource(def.key);
    const hasValue = value !== undefined;
    if (def.type === 'secret') {
      return {
        key: def.key,
        category: def.category,
        providerId: def.providerId,
        type: def.type,
        label: def.label,
        description: def.description,
        hasValue,
        source,
        value: hasValue ? maskSecret(value!) : null,
        readOnly: def.readOnly ?? false,
      };
    }
    return {
      key: def.key,
      category: def.category,
      providerId: def.providerId,
      type: def.type,
      label: def.label,
      description: def.description,
      hasValue,
      source,
      value: hasValue ? value! : null,
      readOnly: def.readOnly ?? false,
    };
  }

  private decode(key: string, stored: string): string {
    if (!isSecretSetting(key)) return stored;
    // Guard against double-decryption: only decrypt if it looks like our ciphertext.
    if (!isEncrypted(stored)) return stored;
    return decryptValue(stored, this.key);
  }

  /** Returns undefined when a secret row cannot be decrypted (corrupt / wrong key). */
  private tryDecode(key: string, stored: string): string | undefined {
    try {
      return this.decode(key, stored);
    } catch {
      return undefined;
    }
  }

  private readEnv(def: SettingDefinition): string | undefined {
    const primary = def.envVar ? process.env[def.envVar]?.trim() : undefined;
    if (primary) return primary;
    const alt = def.altEnvVar ? process.env[def.altEnvVar]?.trim() : undefined;
    return alt || undefined;
  }

  private requireDefinition(key: string): SettingDefinition {
    const def = getSettingDefinition(key);
    if (!def) throw new BadRequestException(`unknown setting key: ${key}`);
    return def;
  }

  private emit(key: string): void {
    for (const listener of this.listeners) {
      try {
        listener(key);
      } catch {
        // listener failures must not break the settings write
      }
    }
  }
}
