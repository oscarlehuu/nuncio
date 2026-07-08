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
    key: 'GITHUB_TOKEN',
    category: 'provider',
    providerId: 'github',
    type: 'secret',
    label: 'GitHub token',
    description: 'Personal access token used for GitHub forge API calls.',
    envVar: 'GITHUB_TOKEN',
  },
  {
    key: 'GITHUB_API_URL',
    category: 'provider',
    providerId: 'github',
    type: 'string',
    label: 'GitHub API URL',
    description: 'Base API URL for GitHub or GitHub Enterprise.',
    envVar: 'GITHUB_API_URL',
    default: 'https://api.github.com',
  },
  {
    key: 'GITHUB_WEBHOOK_SECRET',
    category: 'provider',
    providerId: 'github',
    type: 'secret',
    label: 'GitHub webhook secret',
    description: 'Shared secret used to verify GitHub webhook deliveries.',
    envVar: 'GITHUB_WEBHOOK_SECRET',
  },
  {
    key: 'GITLAB_TOKEN',
    category: 'provider',
    providerId: 'gitlab',
    type: 'secret',
    label: 'GitLab token',
    description: 'Personal access token used for GitLab forge API calls (merge requests, pipelines).',
    envVar: 'GITLAB_TOKEN',
  },
  {
    key: 'GITLAB_API_URL',
    category: 'provider',
    providerId: 'gitlab',
    type: 'string',
    label: 'GitLab API URL',
    description: 'API base URL. Default https://gitlab.com/api/v4; set for a self-hosted GitLab instance.',
    envVar: 'GITLAB_API_URL',
    default: 'https://gitlab.com/api/v4',
  },
  {
    key: 'GITLAB_WEBHOOK_SECRET',
    category: 'provider',
    providerId: 'gitlab',
    type: 'secret',
    label: 'GitLab webhook secret',
    description: 'Shared secret token used to verify GitLab webhook deliveries (X-Gitlab-Token).',
    envVar: 'GITLAB_WEBHOOK_SECRET',
  },
  {
    key: 'PI_AGENT_DIR',
    category: 'provider',
    providerId: 'pi',
    type: 'path',
    label: 'Pi agent directory',
    description:
      'Path to the Pi agent config root. Nuncio only needs Pi installed; manage Pi itself with the `pi` CLI. Default: ~/.pi/agent.',
    envVar: 'PI_CODING_AGENT_DIR',
    altEnvVar: 'PI_AGENT_DIR',
  },
  {
    key: 'NUNCIO_PI_BIN',
    category: 'provider',
    providerId: 'pi',
    type: 'path',
    label: 'Pi CLI binary',
    description:
      'Path to the `pi` CLI binary used for version checks and user-triggered updates. Defaults to PATH.',
    envVar: 'NUNCIO_PI_BIN',
    default: 'pi',
  },
  {
    key: 'NUNCIO_CODEX_BIN',
    category: 'provider',
    providerId: 'codex',
    type: 'path',
    label: 'Codex CLI binary',
    description:
      'Path to the `codex` CLI binary used to launch `codex app-server`. Leave as `codex` to auto-discover one logged-in install; set an absolute path when multiple installs exist.',
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
    category: 'workspaces',
    type: 'path',
    label: 'Project roots',
    description: 'Comma-separated directories scanned one level deep for git repos (project picker).',
    envVar: 'NUNCIO_PROJECT_ROOTS',
  },
  {
    key: 'NUNCIO_PROVIDER_UPDATE_CHECKS',
    category: 'advanced',
    type: 'boolean',
    label: 'Provider update checks',
    description:
      'Check Pi and Codex CLI versions against their public package registry and show optional update actions.',
    envVar: 'NUNCIO_PROVIDER_UPDATE_CHECKS',
    default: '1',
  },
  {
    key: 'NUNCIO_WORKSPACES_DIR',
    category: 'workspaces',
    type: 'path',
    label: 'Workspaces directory',
    description: 'Parent directory for per-session git worktrees (created at <dir>/<sessionId>).',
    envVar: 'NUNCIO_WORKSPACES_DIR',
    default: '~/.nuncio/workspaces',
  },
  {
    key: 'NUNCIO_TAILSCALE_AUTO_TRUST',
    category: 'network',
    type: 'boolean',
    label: 'Trust Tailscale devices',
    description:
      'Allow tailnet devices owned by the same Tailscale account to connect without the access token (identity verified via `tailscale whois`). On by default when Tailscale is detected.',
    envVar: 'NUNCIO_TAILSCALE_AUTO_TRUST',
    default: '1',
  },
  {
    key: 'NUNCIO_HUB_MODE',
    category: 'network',
    type: 'boolean',
    label: 'Hub mode',
    description:
      'Make this server a hub: reach your other tailnet machines running nuncio through this one URL at /m/<machine>/. Off by default.',
    envVar: 'NUNCIO_HUB_MODE',
    default: '0',
  },
  {
    key: 'NUNCIO_TASK_CONCURRENCY',
    category: 'agents',
    type: 'string',
    label: 'Max parallel subtasks',
    description:
      'How many queued tasks or delegated subtasks may run at once on this machine. Default 1 (strict FIFO).',
    envVar: 'NUNCIO_TASK_CONCURRENCY',
    default: '1',
  },
  {
    key: 'NUNCIO_SUBAGENT_PROVIDER',
    category: 'agents',
    type: 'string',
    label: 'Default subagent provider',
    description:
      'Provider-neutral routing default for delegated subagents. Leave empty to inherit the session provider.',
    envVar: 'NUNCIO_SUBAGENT_PROVIDER',
  },
  {
    key: 'NUNCIO_SUBAGENT_MODEL',
    category: 'agents',
    type: 'string',
    label: 'Default subagent model',
    description:
      'Provider-neutral model default for delegated subagents. Legacy global fallback used when the per-provider default subagent models map has no entry for the resolved provider. Leave empty to inherit the session model.',
    envVar: 'NUNCIO_SUBAGENT_MODEL',
  },
  {
    key: 'NUNCIO_SUBAGENT_MODELS',
    category: 'agents',
    type: 'string',
    label: 'Default subagent models',
    description:
      'JSON map of provider id → model id used as the default subagent model per provider. Takes precedence over the single legacy default subagent model.',
    envVar: 'NUNCIO_SUBAGENT_MODELS',
  },
  {
    key: 'NUNCIO_MULTITASK_COUNTDOWN_SECONDS',
    category: 'agents',
    type: 'string',
    label: 'Multitask launch countdown',
    description:
      'Grace window in seconds before a multitask subagent launches, letting you change its model or start it early. Clamped between 5 and 600 seconds.',
    envVar: 'NUNCIO_MULTITASK_COUNTDOWN_SECONDS',
    default: '15',
  },
  {
    key: 'NUNCIO_SUBAGENT_CLEANUP_POLICY',
    category: 'agents',
    type: 'string',
    label: 'Subagent cleanup policy',
    description:
      'Metadata for subagent workspace cleanup: immediate cleanup after review now, with snapshot later reserved for durable review artifacts.',
    envVar: 'NUNCIO_SUBAGENT_CLEANUP_POLICY',
    default: 'after-review',
  },
  {
    key: 'NUNCIO_VERIFY_COMMAND',
    category: 'agents',
    type: 'string',
    label: 'Verify command',
    description:
      'Shell command run in the session workspace after each turn; the result is annotated on the transcript (verify chip). A project-level .nuncio/verify script takes precedence. Empty disables verification.',
    envVar: 'NUNCIO_VERIFY_COMMAND',
  },
  // ── MCP & Tools ─────────────────────────────────────────────────────────
  {
    key: 'NUNCIO_BROWSER_DEFAULT_TARGET',
    category: 'tools',
    type: 'string',
    label: 'Default browser',
    description:
      'Browser target used when agents, MCP adapters, or API clients do not specify one.',
    envVar: 'NUNCIO_BROWSER_DEFAULT_TARGET',
    default: 'auto',
    options: [
      {
        value: 'auto',
        label: 'Auto',
        description: 'Use the desktop in-app browser when connected, otherwise use the Nuncio-owned CDP browser.',
      },
      {
        value: 'in_app',
        label: 'In-app',
        description: 'Require the desktop embedded browser and fail when the desktop shell is not connected.',
      },
      {
        value: 'external',
        label: 'External CDP',
        description: 'Always use the Nuncio-owned Chrome CDP browser.',
      },
    ],
  },
];

const BY_KEY = new Map(SETTING_DEFINITIONS.map((def) => [def.key, def]));

export function getSettingDefinition(key: string): SettingDefinition | undefined {
  return BY_KEY.get(key);
}

export function isSecretSetting(key: string): boolean {
  return BY_KEY.get(key)?.type === 'secret';
}
