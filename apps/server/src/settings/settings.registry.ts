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
  {
    key: 'NUNCIO_CODEX_BIN',
    category: 'provider',
    providerId: 'codex',
    type: 'path',
    label: 'Codex CLI binary',
    description:
      'Path to the `codex` CLI binary used to launch `codex app-server`. Defaults to PATH.',
    envVar: 'NUNCIO_CODEX_BIN',
    default: 'codex',
  },
  {
    key: 'NUNCIO_CODEX_HOME',
    category: 'provider',
    providerId: 'codex',
    type: 'path',
    label: 'Codex home',
    description:
      'Optional CODEX_HOME override for Codex app-server. Leave unset to use the same Codex login as the CLI/app.',
    envVar: 'NUNCIO_CODEX_HOME',
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
  {
    key: 'NUNCIO_CURSOR_AGENT_BIN',
    category: 'provider',
    providerId: 'cursor',
    type: 'path',
    label: 'Cursor CLI binary',
    description:
      'Path to the `agent` CLI binary for handoff sessions. Defaults to ~/.local/bin/agent, then PATH.',
    envVar: 'NUNCIO_CURSOR_AGENT_BIN',
  },
  {
    key: 'NUNCIO_CODEX_CWD',
    category: 'provider',
    providerId: 'codex',
    type: 'path',
    label: 'Codex default working directory',
    description:
      'Used when a Codex session has no selected workspace or worktree. Falls back to the server process cwd if unset.',
    envVar: 'NUNCIO_CODEX_CWD',
  },
  {
    key: 'NUNCIO_CODEX_RUNTIME_MODE',
    category: 'provider',
    providerId: 'codex',
    type: 'string',
    label: 'Codex runtime mode',
    description:
      '`full-access` runs with approval_policy=never and danger-full-access. `approval-required` starts read-only/untrusted and surfaces approval requests in the transcript.',
    envVar: 'NUNCIO_CODEX_RUNTIME_MODE',
    default: 'full-access',
  },
  // ── General ──────────────────────────────────────────────────────────────
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
