import type { SettingDefinition } from './settings.types';

/**
 * Declarative catalog of all runtime-configurable settings.
 *
 * Resolution order at runtime (SettingsService.resolve):
 *   1. DB `settings` row (DB wins — explicit user override)
 *   2. process.env[envVar] (or altEnvVar) — env still works, back-compat
 *   3. definition.default
 *
 * Boot-only vars (NUNCIO_DATA_DIR, PORT, NUNCIO_SETTINGS_KEY) are deliberately
 * absent — they are needed before the DB/encryption key is available.
 *
 * Adding a new provider's credentials = adding one entry here. No schema or
 * API change required.
 */
export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  // ── Provider credentials ────────────────────────────────────────────────
  {
    key: 'CURSOR_API_KEY',
    category: 'provider',
    providerId: 'cursor',
    type: 'secret',
    label: 'Cursor API Key',
    description: 'Required for the `cursor` provider. Mint at cursor.com/dashboard/cloud-agents.',
    envVar: 'CURSOR_API_KEY',
  },
  {
    key: 'PI_AGENT_DIR',
    category: 'provider',
    providerId: 'pi',
    type: 'path',
    label: 'Pi agent directory',
    description:
      'Path to the Pi auth/config root (holds auth.json + models.json). The directory path is configurable here; the auth.json *contents* are read-only — manage them with the `pi` CLI. Default: ~/.pi/agent.',
    envVar: 'PI_CODING_AGENT_DIR',
    altEnvVar: 'PI_AGENT_DIR',
  },
  // ── Provider behavioral ──────────────────────────────────────────────────
  {
    key: 'NUNCIO_CURSOR_CWD',
    category: 'provider',
    providerId: 'cursor',
    type: 'path',
    label: 'Cursor default working directory',
    description:
      'Used when a session has no workspace. Falls back to the server process cwd if unset.',
    envVar: 'NUNCIO_CURSOR_CWD',
  },
  // ── General ──────────────────────────────────────────────────────────────
  {
    key: 'NUNCIO_FORCE_MOCK',
    category: 'general',
    type: 'boolean',
    label: 'Force mock agent',
    description: 'Set to "1" to force the mock provider even when real providers are authed.',
    envVar: 'NUNCIO_FORCE_MOCK',
  },
  {
    key: 'NUNCIO_PROJECT_ROOTS',
    category: 'general',
    type: 'path',
    label: 'Project roots',
    description: 'Comma-separated directories scanned one level deep for git repos (project picker).',
    envVar: 'NUNCIO_PROJECT_ROOTS',
  },
  {
    key: 'NUNCIO_WORKSPACES_DIR',
    category: 'general',
    type: 'path',
    label: 'Workspaces directory',
    description: 'Parent directory for per-session git worktrees (created at <dir>/<sessionId>).',
    envVar: 'NUNCIO_WORKSPACES_DIR',
    default: '~/.nuncio/workspaces',
  },
];

const BY_KEY = new Map(SETTING_DEFINITIONS.map((def) => [def.key, def]));

export function getSettingDefinition(key: string): SettingDefinition | undefined {
  return BY_KEY.get(key);
}

export function isSecretSetting(key: string): boolean {
  return BY_KEY.get(key)?.type === 'secret';
}
