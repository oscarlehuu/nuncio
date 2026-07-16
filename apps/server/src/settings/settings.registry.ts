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
    key: 'forges.autoSteer',
    category: 'advanced',
    type: 'boolean',
    label: 'Auto-steer from forge feedback',
    description:
      'Route pull-request reviews, comments, and failing CI logs to the session that owns the pull request.',
    envVar: 'NUNCIO_FORGES_AUTO_STEER',
    default: '1',
  },
  {
    key: 'forges.autoCloseOnMerge',
    category: 'advanced',
    type: 'boolean',
    label: 'Auto-close merged sessions',
    description:
      'Archive an idle pull-request session and remove its worktree after merge when no local or unpushed work remains.',
    envVar: 'NUNCIO_FORGES_AUTO_CLOSE_ON_MERGE',
    default: '1',
  },
  {
    key: 'PI_AGENT_DIR',
    category: 'provider',
    providerId: 'pi',
    type: 'path',
    label: 'Nuncio Engine agent directory',
    description:
      'Path to the Nuncio Engine agent config root. Nuncio only needs the `pi` CLI installed; manage Pi itself with the `pi` CLI. Default: ~/.pi/agent.',
    envVar: 'PI_CODING_AGENT_DIR',
    altEnvVar: 'PI_AGENT_DIR',
  },
  {
    key: 'NUNCIO_PI_MODELS_PATH',
    category: 'provider',
    providerId: 'pi',
    type: 'path',
    label: 'Nuncio Engine models file',
    description:
      'Optional Pi-format custom model file used only by Nuncio Engine. Defaults to nuncio-models.json inside the active Pi agent directory; the Pi CLI models.json is never loaded.',
    envVar: 'NUNCIO_PI_MODELS_PATH',
  },
  {
    key: 'PI_EXTENSION_DISCOVERY',
    category: 'provider',
    providerId: 'pi',
    type: 'string',
    label: 'Nuncio Engine extension discovery',
    description:
      'Nuncio Engine sessions load only an allowlisted set of Pi extensions so CLI-oriented ones cannot alter daemon behavior. Set to "full" to restore Pi\'s default discovery (~/.pi and project .pi).',
    envVar: 'PI_EXTENSION_DISCOVERY',
  },
  {
    key: 'PI_EXTERNAL_MEMORIES',
    category: 'provider',
    providerId: 'pi',
    type: 'string',
    label: 'Nuncio Engine external memories',
    description:
      'Choose which read-only Claude Code and Codex CLI memory stores Nuncio Engine may index for the selected project. Nuncio never writes to these stores.',
    envVar: 'PI_EXTERNAL_MEMORIES',
    default: 'all',
    options: [
      { value: 'off', label: 'Off', description: 'Do not read or expose external agent memories.' },
      { value: 'claude', label: 'Claude Code', description: 'Use matching Claude Code project memories only.' },
      { value: 'codex', label: 'Codex CLI', description: 'Use matching Codex CLI memories only.' },
      { value: 'all', label: 'All', description: 'Use matching memories from both external stores.' },
    ],
  },
  {
    key: 'PI_EXTERNAL_MEMORIES_MAX_BYTES',
    category: 'provider',
    providerId: 'pi',
    type: 'number',
    label: 'External memory index budget (bytes)',
    description:
      'Maximum UTF-8 bytes Nuncio Engine injects for the compact external-memory index. Full memories remain available through the read tool. Hard-capped at 16384 bytes.',
    envVar: 'PI_EXTERNAL_MEMORIES_MAX_BYTES',
    default: '12288',
  },
  {
    key: 'NUNCIO_CLAUDE_CONFIG_DIR',
    category: 'provider',
    providerId: 'pi',
    type: 'path',
    label: 'Claude Code config directory for memories',
    description:
      'Claude Code config root Nuncio Engine reads project memories from. Stored memories stay read-only and in Claude Code\'s own store.',
    envVar: 'NUNCIO_CLAUDE_CONFIG_DIR',
    altEnvVar: 'CLAUDE_CONFIG_DIR',
    default: '~/.claude',
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
  {
    key: 'ANTHROPIC_API_KEY',
    category: 'provider',
    providerId: 'claude',
    type: 'secret',
    label: 'Anthropic API key',
    description:
      'API key for the `claude` provider (distribution path). Optional when the SDK-bundled Claude CLI is already logged in via subscription; set it to run without that login.',
    envVar: 'ANTHROPIC_API_KEY',
  },
  {
    key: 'NUNCIO_CLAUDE_BIN',
    category: 'provider',
    providerId: 'claude',
    type: 'path',
    label: 'Claude CLI binary',
    description:
      'Path to a `claude` CLI binary used for the auth probe and by the SDK. Leave unset to use the binary bundled with the Claude Agent SDK.',
    envVar: 'NUNCIO_CLAUDE_BIN',
  },
  {
    key: 'NUNCIO_CLAUDE_PERMISSION_MODE',
    category: 'provider',
    providerId: 'claude',
    type: 'string',
    label: 'Claude permission mode',
    description:
      'How the `claude` provider gates tool use. bypassPermissions (default) runs every tool without asking in trusted workspaces; acceptEdits auto-approves file edits and asks for the rest; default asks for everything; plan is read-only planning.',
    envVar: 'NUNCIO_CLAUDE_PERMISSION_MODE',
    default: 'bypassPermissions',
    options: [
      { value: 'acceptEdits', label: 'Accept edits', description: 'Auto-approve file edits; ask for the rest.' },
      { value: 'default', label: 'Ask every time', description: 'Route every privileged tool through an approval card.' },
      { value: 'plan', label: 'Plan only', description: 'Read-only planning; no edits or commands.' },
      { value: 'bypassPermissions', label: 'Bypass', description: 'Run every tool without asking (trusted workspaces only).' },
    ],
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
      'Check managed provider CLI versions against their public package registries and show optional update actions.',
    envVar: 'NUNCIO_PROVIDER_UPDATE_CHECKS',
    default: '1',
  },
  {
    key: 'NUNCIO_CLI_UPDATE_NOTIFICATIONS',
    category: 'advanced',
    type: 'boolean',
    label: 'CLI update notifications',
    description:
      'Show provider CLI update notifications. Manual update checks and Update actions remain available when this is off.',
    envVar: 'NUNCIO_CLI_UPDATE_NOTIFICATIONS',
    default: '1',
  },
  {
    key: 'NUNCIO_CLI_UPDATE_MUTED',
    category: 'advanced',
    type: 'string',
    label: 'Muted CLI update notifications',
    description:
      'Comma-separated provider CLI ids with muted update notifications, such as `pi,codex`. Manual updates still work.',
    envVar: 'NUNCIO_CLI_UPDATE_MUTED',
    default: '',
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
  // ── Heartbeat (rung 3) — founder-tunable cadences. ───────────────────────
  {
    key: 'NUNCIO_HEARTBEAT_INFRA_SPEC',
    category: 'advanced',
    type: 'string',
    label: 'Heartbeat: infra self-check cadence',
    description:
      'Schedule spec for the infra self-check (expiring credentials, zombie sessions). Default every 15 minutes.',
    envVar: 'NUNCIO_HEARTBEAT_INFRA_SPEC',
    default: 'every:15m',
  },
  {
    key: 'NUNCIO_HEARTBEAT_RECONCILE_SPEC',
    category: 'advanced',
    type: 'string',
    label: 'Heartbeat: fleet reconciliation cadence',
    description:
      'Schedule spec for the hourly fleet reconciliation (auto-resolve cleared attention, fold settled loop runs). Default every 60 minutes.',
    envVar: 'NUNCIO_HEARTBEAT_RECONCILE_SPEC',
    default: 'every:60m',
  },
  {
    key: 'NUNCIO_HEARTBEAT_DIGEST_MORNING',
    category: 'advanced',
    type: 'string',
    label: 'Heartbeat: morning digest time',
    description: 'Daily time for the retrospective morning digest. Default 08:00.',
    envVar: 'NUNCIO_HEARTBEAT_DIGEST_MORNING',
    default: 'daily@08:00',
  },
  {
    key: 'NUNCIO_HEARTBEAT_DIGEST_EVENING',
    category: 'advanced',
    type: 'string',
    label: 'Heartbeat: evening digest time',
    description: 'Daily time for the pre-flight evening digest. Default 20:00.',
    envVar: 'NUNCIO_HEARTBEAT_DIGEST_EVENING',
    default: 'daily@20:00',
  },
  {
    key: 'NUNCIO_DISPATCHER_EVENING_SPEC',
    category: 'advanced',
    type: 'string',
    label: 'Dispatcher: evening proposal time',
    description: 'Daily time for deterministic dispatcher proposals. Default 20:05.',
    envVar: 'NUNCIO_DISPATCHER_EVENING_SPEC',
    default: 'daily@20:05',
  },
  {
    key: 'NUNCIO_HEARTBEAT_ZOMBIE_AGE_MIN',
    category: 'advanced',
    type: 'string',
    label: 'Heartbeat: zombie session threshold (minutes)',
    description:
      'A RUNNING session with no event for this many minutes is flagged as a zombie. Default 30.',
    envVar: 'NUNCIO_HEARTBEAT_ZOMBIE_AGE_MIN',
    default: '30',
  },
  {
    key: 'NUNCIO_LOOP_STUCK_PENDING_AGE_MIN',
    category: 'advanced',
    type: 'string',
    label: 'Heartbeat: loop stuck-run threshold (minutes)',
    description:
      'A loop run whose task has been RUNNING this many minutes without settling is force-failed so the loop can fire again, and raised for attention. Coarse safety net for a silent/wedged session; the finer zombie-session check runs sooner. Default 180.',
    envVar: 'NUNCIO_LOOP_STUCK_PENDING_AGE_MIN',
    default: '180',
  },
  {
    key: 'NUNCIO_ANOMALY_EMPTY_DIFF_MIN',
    category: 'advanced',
    type: 'string',
    label: 'Anomaly: empty-diff threshold (minutes)',
    description:
      'A session RUNNING this many minutes with no uncommitted changes is flagged as an anomaly (empty diff). Default 30.',
    envVar: 'NUNCIO_ANOMALY_EMPTY_DIFF_MIN',
    default: '30',
  },
  {
    key: 'NUNCIO_ANOMALY_LOOP_FAILING_RUNS',
    category: 'advanced',
    type: 'string',
    label: 'Anomaly: loop-failing run count',
    description:
      "A loop with this many of today's runs all failed/budget-exhausted and no green verify is flagged as failing. Default 3.",
    envVar: 'NUNCIO_ANOMALY_LOOP_FAILING_RUNS',
    default: '3',
  },
  {
    key: 'NUNCIO_CLONE_DIR',
    category: 'workspaces',
    type: 'path',
    label: 'Clone directory',
    description:
      'Parent directory where the forge-aware picker clones repositories (created at <dir>/<repo-name>). Default: ~/nuncio/projects.',
    envVar: 'NUNCIO_CLONE_DIR',
    default: '~/nuncio/projects',
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
    key: 'NUNCIO_ORCHESTRATION_TOOLS',
    category: 'agents',
    type: 'string',
    label: 'Orchestration tools',
    description:
      'Whether a running engine can observe the session fleet and delegate work via the nuncio_* tools. off exposes nothing; read adds read-only observation tools; read-write also lets the engine enqueue subagent tasks. Same-machine, same-founder — these govern context hygiene, not multi-tenant security.',
    envVar: 'NUNCIO_ORCHESTRATION_TOOLS',
    default: 'off',
    options: [
      { value: 'off', label: 'Off', description: 'No orchestration tools are exposed to engines.' },
      { value: 'read', label: 'Read-only', description: 'Engines can list and read sessions and task results.' },
      { value: 'read-write', label: 'Read-write', description: 'Engines can also enqueue subagent tasks.' },
    ],
  },
  {
    key: 'NUNCIO_ENGINE_ROUTING',
    category: 'agents',
    type: 'string',
    label: 'Engine routing table',
    description:
      'JSON map of routing tag → { "provider": "…", "model": "…", "avoidAuthorProvider": true } that sends tagged tasks to a chosen engine — e.g. mechanical work to a cheap engine, review to a different engine than the author. Tags: mechanical, review, design, research. avoidAuthorProvider picks a different available engine than the delegating session. A miss, an unavailable engine, or malformed JSON falls through to the normal subagent defaults; an explicit provider always wins. Empty disables routing.',
    envVar: 'NUNCIO_ENGINE_ROUTING',
  },
  {
    key: 'NUNCIO_DELEGATE_NOTIFY',
    category: 'agents',
    type: 'string',
    label: 'Delegate notify policy',
    description:
      'How a parent session is notified when one of its delegated subagent tasks finishes. event-only appends a digest to the transcript; steer additionally wakes an idle parent with the digest so it can continue autonomously. Per-task override wins over this default.',
    envVar: 'NUNCIO_DELEGATE_NOTIFY',
    default: 'event-only',
    options: [
      { value: 'event-only', label: 'Event only', description: 'Append the digest to the parent transcript; never wake the parent.' },
      { value: 'steer', label: 'Auto-steer', description: 'Wake an idle parent with the digest (subject to depth and rate guards).' },
    ],
  },
  {
    key: 'NUNCIO_CONTEXT_FACTS_INJECT',
    category: 'agents',
    type: 'string',
    label: 'Inject project facts',
    description:
      'When on, a new session on a project starts already knowing that project\'s curated facts (build commands, gotchas, standing decisions) injected into its first prompt within a byte budget. Set to off as a global kill-switch.',
    envVar: 'NUNCIO_CONTEXT_FACTS_INJECT',
    default: 'on',
    options: [
      { value: 'on', label: 'On', description: 'Inject project facts into new sessions.' },
      { value: 'off', label: 'Off', description: 'Never inject project facts.' },
    ],
  },
  {
    key: 'NUNCIO_CONTEXT_FACTS_MAX_BYTES',
    category: 'agents',
    type: 'string',
    label: 'Project facts budget (bytes)',
    description:
      'Maximum bytes of project facts injected into a new session preamble. Facts beyond the budget are omitted (with a note), never truncated mid-fact.',
    envVar: 'NUNCIO_CONTEXT_FACTS_MAX_BYTES',
    default: '4096',
  },
  {
    key: 'NUNCIO_CONTEXT_FILE_POLICY',
    category: 'agents',
    type: 'string',
    label: 'Context-file policy',
    description:
      'Whether nuncio materializes the engine\'s native context file (e.g. CLAUDE.local.md, from the prompt profile) into a session worktree, containing the current project facts. worktree-local writes only into the worktree and .git/info/exclude (never a repo-owned file, never an existing one); none writes nothing. Facts still arrive via the session preamble regardless — the file is engine-idiomatic reinforcement, not the guarantee.',
    envVar: 'NUNCIO_CONTEXT_FILE_POLICY',
    default: 'none',
    options: [
      { value: 'none', label: 'None', description: 'Never write a context file.' },
      { value: 'worktree-local', label: 'Worktree-local', description: 'Write the engine context file into the session worktree only.' },
    ],
  },
  {
    key: 'NUNCIO_PROMPT_PROFILE_PI',
    category: 'agents',
    type: 'string',
    label: 'Prompt profile override (Nuncio Engine)',
    description:
      'A full prompt-profile document (markdown with YAML frontmatter + named ## sections: brief-wrapper, facts-wrapper, digest-wrapper, tools-preamble, idioms) that overrides the repo profile for the Nuncio Engine. See apps/server/prompt-profiles/README.md for the format. Empty uses the repo profile / pass-through default.',
    envVar: 'NUNCIO_PROMPT_PROFILE_PI',
  },
  {
    key: 'NUNCIO_PROMPT_PROFILE_CURSOR',
    category: 'agents',
    type: 'string',
    label: 'Prompt profile override (Cursor)',
    description:
      'Full prompt-profile document overriding the repo profile for the Cursor engine (same format as the Pi override; see prompt-profiles/README.md).',
    envVar: 'NUNCIO_PROMPT_PROFILE_CURSOR',
  },
  {
    key: 'NUNCIO_PROMPT_PROFILE_CODEX',
    category: 'agents',
    type: 'string',
    label: 'Prompt profile override (Codex)',
    description:
      'Full prompt-profile document overriding the repo profile for the Codex engine (same format as the Pi override; see prompt-profiles/README.md).',
    envVar: 'NUNCIO_PROMPT_PROFILE_CODEX',
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
  {
    key: 'NUNCIO_VERIFY_AUTO_STEER',
    category: 'agents',
    type: 'boolean',
    label: 'Auto-fix failing verifies',
    description:
      'When a post-turn verify fails, automatically steer the session with the failure output so the agent fixes it, up to the max rounds below, then surface "needs you". Off by default.',
    envVar: 'NUNCIO_VERIFY_AUTO_STEER',
    default: '0',
  },
  {
    key: 'NUNCIO_VERIFY_MAX_ROUNDS',
    category: 'agents',
    type: 'string',
    label: 'Max auto-fix rounds',
    description:
      'How many times to auto-steer a failing verify before surfacing "needs you". Default 3. 0 surfaces immediately without auto-steering. Non-integer or negative values fall back to 3.',
    envVar: 'NUNCIO_VERIFY_MAX_ROUNDS',
    default: '3',
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
