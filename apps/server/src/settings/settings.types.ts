/**
 * Settings store — type definitions.
 *
 * A "setting" is a runtime-configurable value that overrides an env var.
 * Boot-only vars (NUNCIO_DATA_DIR, PORT, NUNCIO_SETTINGS_KEY) are NOT settings —
 * they must be read before the DB / encryption key is available.
 */

export type SettingType = 'secret' | 'string' | 'path' | 'boolean';

export type SettingCategory = 'provider' | 'general';

/**
 * Declarative metadata for one configurable key. Aggregated in
 * `SETTING_DEFINITIONS` (settings.registry.ts). Adding a future provider's
 * credentials = adding one entry here — no API/schema change.
 */
export interface SettingDefinition {
  /** Stable key used in the `settings` table and API paths. */
  key: string;
  category: SettingCategory;
  /** Provider id this setting belongs to, or undefined for general settings. */
  providerId?: string;
  type: SettingType;
  label: string;
  description: string;
  /** Env var name used as fallback when no DB row exists (back-compat). */
  envVar?: string;
  /** Secondary env var also honoured as fallback (e.g. PI_AGENT_DIR / PI_CODING_AGENT_DIR). */
  altEnvVar?: string;
  /** Literal default when neither DB nor env provides a value. `~`-paths left for consumer to expand. */
  default?: string;
  /** If true, this setting is read-only on the frontend (status-only display). */
  readOnly?: boolean;
}

/** Row in the `settings` SQLite table. */
export interface SettingRow {
  key: string;
  value: string;
  updated_at: number;
}

/** DTO returned by GET /api/settings. Secrets are masked; raw value never leaves the server. */
export interface SettingDto {
  key: string;
  category: SettingCategory;
  providerId?: string;
  type: SettingType;
  label: string;
  description: string;
  /** True when a DB row OR env var provides a value. */
  hasValue: boolean;
  /** Source of the resolved value: 'db' | 'env' | 'default' | null. */
  source: 'db' | 'env' | 'default' | null;
  /**
   * For non-secret types: the resolved value.
   * For secret types: a masked preview like `••••last4` (or null when no value).
   */
  value: string | null;
  /** Whether the frontend should render this as read-only. */
  readOnly: boolean;
}

/** Body for PUT /api/settings/:key. */
export interface UpdateSettingDto {
  value: string;
}
