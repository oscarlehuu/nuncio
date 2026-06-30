# Git / GitHub / GitLab Forge Integration — Phased Implementation Plan

> Devin-style git + forge integration for Nuncio. **Locked scope & priority:** local git ops →
> outbound PR/MR → inbound issue/PR→session webhooks. **GitHub first** behind a single `forge`
> provider abstraction; GitLab adapter follows. Each phase is independently shippable and
> **test-gated per AGENTS.md** (green suite + changeset + code-review pass before PR).
>
> Grounded in scout recon + verified against the codebase (file:line refs are real as of writing).

## Guiding constraints (from AGENTS.md)

- **TDD-first.** Every phase starts from a failing `*.spec.ts` under `apps/server/test/unit/<domain>/`
  (or co-located `*.spec.tsx` for web). Red → Green → Refactor. Suite green is a hard gate.
- **Changeset mandatory** for user-facing change: `bun run add-changeset <patch|minor> "<note>"`.
  New end-to-end capability → `minor`; polish/fix → `patch`.
- **Code-review pass** (code-reviewer agent / Bugbot) before commit or PR — tests-green alone is not done.
- **Shared-first / provider-agnostic.** The `forge` layer mirrors the `AgentProvider` pattern
  (`agents.types.ts` → `agents.base-provider.ts` → `agents.registry.ts`). GitHub is the *inaugural*
  forge provider, not the architecture.
- **No migration framework.** Schema changes are guarded `ALTER TABLE` in `DatabaseService.migrate()`
  using the `PRAGMA table_info(...)` template (`apps/server/src/db/database.service.ts:71`).
- **bun:sqlite positional `?` params only** — never named `@param`.
- **Branch lane (resolved — D0):** forge work is provider-neutral harness code. It lands through the
  **current** lane — `codex/github-gitlab-integration` → `codex-sdk` → `main` — then `main` is synced back
  to `pi-sdk` + `cursor-sdk`. The `codex/` prefix is **routing only, not ownership**: the deliverable
  becomes shared the moment it reaches `main` (the shared source of truth). No dedicated `forge-sdk` branch
  and no CI `branch-flow` changes. Per-phase feature branches: `codex/forge-phase-NN` off `codex-sdk`.

---

## Architecture at a glance

```
apps/server/src/
  git/                        EXTEND — local git ops (Phase 1)
    git.service.ts            + status/diff/stage/commit/push      (git.service.ts:40)
    git.controller.ts         + session-scoped routes              (git.controller.ts)
    git.types.ts              + GitStatusDto/GitDiffDto/CommitResultDto/PushResultDto
  forges/                     NEW MODULE — forge abstraction (Phase 2+)
    forges.types.ts           ForgeProvider interface (mirrors agents.types.ts)
    forges.base-provider.ts   BaseForgeProvider (shared HTTP/error orchestration)
    forges.registry.ts        ForgeRegistry (resolve by id: github|gitlab)
    forges.module.ts          wires providers + registry, exports registry
    forges.service.ts         session-facing facade (open PR/MR, fetch status)
    api/forges.controller.ts  REST: PR/MR create + status (Phase 3)
    webhooks/
      webhooks.controller.ts  signature-verified inbound (Phase 4)
      webhooks.service.ts     event → session-create mapping (Phase 4)
    providers/
      github-forge.provider.ts   (Phase 2/3/4)
      gitlab-forge.provider.ts   (Phase 5)
  sessions/                   forge metadata fields on session (Phase 3)
  settings/                   forge credentials in declarative catalog (Phase 2/5)
```

The forge layer reuses the exact three-file shape that made the agent harness extensible:
`ForgeProvider` interface ≈ `AgentProvider` (`apps/server/src/agents/agents.types.ts:32`),
`BaseForgeProvider` ≈ `BaseAgentProvider` (`apps/server/src/agents/agents.base-provider.ts:15`),
`ForgeRegistry` ≈ `AgentRegistry` (`apps/server/src/agents/agents.registry.ts:9`).

---

# Phase 1 — Local git ops (status / diff / stage / commit / push) + review-changes UI

**Goal:** Review and commit/push a session's working tree from the web UI. **No accounts, no network
forge.** Ships standalone value (review what the agent did, commit it, push the branch).

### Files to add / change

| File | Change |
|---|---|
| `apps/server/src/git/git.service.ts` | Add methods on `GitService` (`git.service.ts:40`), reusing the private `git()` spawn helper (`git.service.ts:20`): `status(repoRoot)` → `git(['status','--porcelain=v1','-b'])`; `diff(repoRoot, {staged?, base?})` → `git(['diff'])` / `git(['diff','--staged'])` / `git(['diff', base])`; `stageAll(repoRoot)` → `git(['add','-A'])`; `commit(repoRoot, message)` → `git(['commit','-m',message])`; `push(repoRoot, branch, {force?})` → `git(['push','origin',branch])` (`--force-with-lease` when force). All resolve the repo via existing `resolveRepoRoot()` (`git.service.ts:90`). |
| `apps/server/src/git/git.types.ts` | Add `GitFileChange { path; index; workTree; staged }`, `GitStatusDto { branch; ahead; behind; clean; files: GitFileChange[] }`, `GitDiffDto { diff; truncated }`, `CommitResultDto { sha; committed }`, `PushResultDto { pushed; remoteBranch }`. |
| `apps/server/src/git/git.controller.ts` | Add a **session-scoped** sub-resource. Resolve the session's working dir (`worktreePath ?? workspace ?? projectPath`) via `SessionsService`. New routes below. Requires importing `SessionsModule`/`SessionsService` — to avoid a circular dep (Sessions already imports Git), put the new routes in a thin new controller `git-session.controller.ts` registered in `SessionsModule` instead, calling injected `GitService`. **(Decision: see D1.)** |
| `apps/server/src/git/git.module.ts` | No change if session-scoped controller lives in `SessionsModule`; otherwise export stays as-is. |
| `apps/web/src/lib/api.ts` | Add `fetchGitStatus(id)`, `fetchGitDiff(id, opts)`, `commitSession(id, message)`, `pushSession(id, opts)` (mirror existing fetch helpers, e.g. `createSession` at `api.ts`). |
| `apps/web/src/components/review-changes.tsx` | **NEW** — "Review changes" panel: file list (status), per-file/whole diff viewer (reuse `markdown-view`/transcript code-block styling), **Commit** (message input, prefilled from session title/prompt) + **Push** buttons. shadcn primitives only. |
| `apps/web/src/components/session-detail.tsx` | Mount `ReviewChanges` in the session detail layout (near header actions at `session-detail.tsx:1`); show only when session has a git working dir (`worktreePath`/`projectPath`). |

### New API routes (session-scoped; under global `/api` prefix)

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/api/sessions/:id/git/status` | — | `GitStatusDto` |
| GET | `/api/sessions/:id/git/diff` | `?staged=1&base=<ref>` | `GitDiffDto` |
| POST | `/api/sessions/:id/git/commit` | `{ message, stageAll? }` | `CommitResultDto` |
| POST | `/api/sessions/:id/git/push` | `{ force? }` | `PushResultDto` |

### New settings keys
None. (Push auth uses the host's existing git credentials — see cross-phase decision D2.)

### New session / data fields
None in Phase 1 (read working tree on demand; no persistence).

### Test plan

- **Unit (TDD-first):** `apps/server/test/unit/git/git.service.spec.ts` (extend existing spec). Reuse its
  `initRepo()` + `runGitAsync()` harness (`git.service.spec.ts:23`). New cases: clean repo → `clean:true`;
  dirty file → appears in `status.files`; `diff` returns unstaged hunks; `commit` produces a sha and
  clears status; `push` to a **bare local remote** (`git init --bare` + `git remote add origin`) succeeds and
  reports `remoteBranch`. Force-push path with `--force-with-lease`.
- **Integration/e2e:** `apps/server/test/e2e/app.e2e-spec.ts` — extend (it already builds a repo via
  `initRepo`, `app.e2e-spec.ts:24`): create a session with `useWorktree`, write a file in the worktree,
  `GET …/git/status` shows it, `POST …/git/commit` then `…/git/push` to a bare remote.
- **Web:** `apps/web/src/components/review-changes.spec.tsx` (Vitest + Testing Library) — renders status,
  disables Commit on empty message, calls API on Commit/Push.

### Changeset (one line)
`Added a Review changes panel so you can see, commit, and push an agent's work from a session.`  *(minor)*

---

# Phase 2 — Forge abstraction + GitHub auth (no outbound calls yet)

**Goal:** Define the provider-agnostic `forge` layer and land **encrypted GitHub credential storage**
via the settings module. Mirrors the agent-provider pattern. Independently shippable: ships a configured,
**testable** GitHub client (`isAvailable()` true, `getCurrentUser()` works) with zero behavior change to
sessions.

### Files to add / change

| File | Change |
|---|---|
| `apps/server/src/forges/forges.types.ts` | **NEW** — `ForgeProvider` interface mirroring `AgentProvider` (`agents.types.ts:32`): `readonly id`, `readonly name`, `isAvailable(): Promise<boolean>`, `getCurrentUser(): Promise<ForgeUser>`, `createPullRequest(opts): Promise<ForgePullRequest>`, `getPullRequest(ref): Promise<ForgePullRequest>`, `listChecks(ref)`, `addComment(ref, body)`, `verifyWebhookSignature(headers, rawBody): boolean`, `parseWebhookEvent(headers, payload): ForgeWebhookEvent \| null`, `bustCache()`. Plus shared DTOs: `ForgeUser`, `CreatePullRequestOptions`, `ForgePullRequest`, `ForgeCheck`, `ForgeWebhookEvent`, `ForgeRepoRef`. |
| `apps/server/src/forges/forges.base-provider.ts` | **NEW** — `BaseForgeProvider` (template-method like `agents.base-provider.ts:15`): shared `request()` HTTP wrapper (auth header injection, JSON parse, error→`HttpException` mapping, rate-limit surface), shared cache-bust. Concrete providers implement endpoint/path specifics. |
| `apps/server/src/forges/forges.registry.ts` | **NEW** — `ForgeRegistry` (mirrors `agents.registry.ts:9`): `all()`, `available()`, `get(id)`, `getAvailable(id)`, `defaultId()`, `bustCaches()`. Subscribes to `settings.onChange(() => this.bustCaches())` exactly like `AgentRegistry` (`agents.registry.ts:26`). |
| `apps/server/src/forges/providers/github-forge.provider.ts` | **NEW** — `GithubForgeProvider implements/extends BaseForgeProvider`. `id='github'`. `isAvailable()` checks a resolved token from settings (env-style cache like `CursorAgentProvider.isAvailable()` at `cursor-agent.provider.ts:50`). `getCurrentUser()` → `GET /user`. Base URL from `GITHUB_API_URL` setting (defaults `https://api.github.com`; GH Enterprise override). Auth-only in this phase. |
| `apps/server/src/forges/forges.module.ts` | **NEW** — `imports: [SettingsModule]`, providers `[GithubForgeProvider, ForgeRegistry]`, `exports: [ForgeRegistry]` (mirrors `agents.module.ts`). |
| `apps/server/src/app.module.ts` | Register `ForgesModule` in the imports array (`app.module.ts:11`). |
| `apps/server/src/settings/settings.registry.ts` | Add entries to `SETTING_DEFINITIONS` (`settings.registry.ts:17`) — see settings keys below. New entries only; declarative, no schema/API change (the catalog is built for exactly this, per AGENTS.md "Settings store"). |
| `apps/web/src/components/settings-view.tsx` | Surfaces new keys automatically (settings UI is catalog-driven). Add a `category: 'forge'` group label if we extend `SettingCategory`. **(See D3.)** |

### New API routes
None in Phase 2 (credentials flow through the existing `/api/settings/:key` endpoints —
`settings.controller.ts`). Secrets are masked + encrypted by the existing `SettingsService` (`settings.service.ts:74` `set()` → `encryptValue`).

### New settings keys (in `SETTING_DEFINITIONS`)

| key | category | type | envVar | Notes |
|---|---|---|---|---|
| `GITHUB_TOKEN` | `provider` (or new `forge`) | `secret` | `GITHUB_TOKEN` | PAT or OAuth access token. Encrypted at rest (AES-256-GCM, `settings.crypto.ts`). |
| `GITHUB_API_URL` | `general` | `string` | `GITHUB_API_URL` | Default `https://api.github.com`; set for GitHub Enterprise Server. |
| `GITHUB_WEBHOOK_SECRET` | `provider`/`forge` | `secret` | `GITHUB_WEBHOOK_SECRET` | HMAC secret for inbound signature verification (used in Phase 4; stored now). |

> Adding `SettingType`/`SettingCategory` values is optional. `secret` already exists
> (`settings.types.ts:9`); a new `'forge'` category requires touching the `SettingCategory` union
> (`settings.types.ts:11`) + the settings-view grouping. **Recommendation: reuse `provider`** to ship
> Phase 2 with zero type changes (D3).

### New session / data fields
None.

### Test plan

- **Unit (TDD-first):**
  - `apps/server/test/unit/forges/forges.registry.spec.ts` — resolve by id, `available()` filters on
    `isAvailable()`, `bustCaches()` on settings change. Mirror `agents.registry` style.
  - `apps/server/test/unit/forges/github-forge.provider.spec.ts` — inject a stub `fetch`/SDK (same
    pattern as `CursorAgentProvider.sdkOverride`, `cursor-agent.provider.ts:39`). Assert: no token →
    `isAvailable()=false`; token set → true; `getCurrentUser()` hits `/user` with `Authorization: Bearer`
    + Enterprise base URL honored.
  - `apps/server/test/unit/settings/settings.registry.spec.ts` (or `.service.spec.ts`) — new keys are
    listed, `GITHUB_TOKEN` is `secret` (masked in DTO, encrypted on `set`).
- **Vs implementation:** all stubbed/unit — no live GitHub. Real-API calls deferred to an opt-in
  `test/integration/github-forge.integration.spec.ts` (gated on `GITHUB_TOKEN`, mirroring the
  Pi/Cursor `test:integration` gating).

### Changeset (one line)
`Added GitHub account settings (token + Enterprise URL) so Nuncio can connect to your GitHub.`  *(minor)*

---

# Phase 3 — Outbound: open a PR from a session's branch + surface status/checks/comments

**Goal:** From an `IDLE` session with a pushed branch, open a GitHub PR (title/body derived from the
task prompt + the changeset/diff), then surface PR state (open/merged/draft), CI checks, and comments
in the session UI. Builds on Phase 1 (push) + Phase 2 (auth).

### Files to add / change

| File | Change |
|---|---|
| `apps/server/src/forges/providers/github-forge.provider.ts` | Implement `createPullRequest()` (`POST /repos/{owner}/{repo}/pulls`), `getPullRequest()`, `listChecks()` (`GET …/commits/{sha}/check-runs`), `addComment()` (`POST …/issues/{number}/comments`). Derive `owner/repo` from the repo's `origin` remote URL (new `GitService.remoteInfo(repoRoot)` → parse `git remote get-url origin`). |
| `apps/server/src/git/git.service.ts` | Add `remoteInfo(repoRoot): { host; owner; repo }` parsing `git(['remote','get-url','origin'])` (ssh + https forms). Used to pick the forge provider + target repo. |
| `apps/server/src/forges/forges.service.ts` | **NEW** — session-facing facade injected into a controller: `openPullRequestForSession(sessionId)` (resolve repo root + branch + base from session, build title/body from `session.prompt`/title + diff summary, call provider, persist PR metadata), `getPullRequestForSession(sessionId)` (refresh status/checks). Injects `ForgeRegistry`, `GitService`, `SessionsRepository`. |
| `apps/server/src/forges/api/forges.controller.ts` | **NEW** — `@Controller('sessions/:id/forge')` routes (below). |
| `apps/server/src/forges/forges.module.ts` | Add `ForgesService` + controller; import `GitModule` + `SessionsPersistenceModule`. |
| `apps/server/src/sessions/domain/sessions.types.ts` | Add forge metadata to `SessionRow` (snake_case) + `SessionDto` (camelCase) + map in `sessions.repository.ts` `toDto`/`insertRow` (`sessions.repository.ts:30`, `:97`): `forge_provider`, `pull_request_url`, `pull_request_number`, `pull_request_state`, `forge_status` (`none\|opening\|open\|merged\|closed\|error`). |
| `apps/server/src/db/database.service.ts` | Add guarded `ALTER TABLE sessions ADD COLUMN …` for each new column in `migrate()` following the `workspaceColumns` loop template (`database.service.ts:90`). |
| `apps/server/src/sessions/persistence/sessions.repository.ts` | Add `updateForgeState(id, {...})` (mirrors `updateProviderRuntimeState`, `sessions.repository.ts:160`); extend `toDto`/`insertRow`. |
| `apps/web/src/lib/api.ts` | `openPullRequest(id)`, `fetchPullRequest(id)`. |
| `apps/web/src/components/pr-panel.tsx` | **NEW** — "Open Pull Request" button (visible when session is `IDLE`, has a `branch`, and a forge is available); after open, shows PR link, state badge, check runs list, comments. |
| `apps/web/src/components/session-detail.tsx` | Mount `PrPanel` alongside `ReviewChanges`. |

### New API routes

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/sessions/:id/forge/pull-request` | `{ title?, body?, draft?, base? }` (defaults derived server-side from task + diff) | `ForgePullRequest` |
| GET | `/api/sessions/:id/forge/pull-request` | — | `ForgePullRequest` (refreshed status + checks) |
| POST | `/api/sessions/:id/forge/pull-request/comment` | `{ body }` | `{ ok }` |

### New settings keys
None new (reuses Phase 2). Optional `NUNCIO_FORGE_AUTO` (`off\|commit\|push\|pr`) if we automate the
post-run chain — **see D4**; default `off`.

### New session / data fields
`forgeProvider`, `pullRequestUrl`, `pullRequestNumber`, `pullRequestState`, `forgeStatus` (+ snake_case
columns + migration, above).

### Optional post-run automation seam
The recon's outbound seam is `BaseAgentProvider.runOrSteer` right after IDLE is set
(`agents.base-provider.ts:74`). **Do not** bury forge calls in the base provider (keeps the agent layer
forge-agnostic). Instead, gate an optional auto-chain in `SessionsService` where `startRun` completes
(`sessions.service.ts:421`) behind `NUNCIO_FORGE_AUTO`. Default stays manual (button-driven) for v1.

### Test plan

- **Unit (TDD-first):**
  - `apps/server/test/unit/forges/github-forge.provider.spec.ts` — stub HTTP: `createPullRequest` posts
    correct payload + returns parsed PR; `listChecks` maps check-runs; `addComment` hits issues endpoint.
  - `apps/server/test/unit/git/git.service.spec.ts` — `remoteInfo` parses ssh (`git@github.com:o/r.git`)
    + https (`https://github.com/o/r.git`) forms.
  - `apps/server/test/unit/forges/forges.service.spec.ts` — title/body derived from session prompt +
    diff; persists PR metadata via `updateForgeState`; rejects when no branch/remote.
  - `apps/server/test/unit/sessions/sessions.repository.spec.ts` — new columns round-trip; migration adds
    columns on a legacy DB (follow existing migration test style in `test/unit/db/`).
- **e2e:** `apps/server/test/e2e/app.e2e-spec.ts` — with a **stubbed forge provider** (DI override like
  `withSimulatedCursorProvider`, `app.e2e-spec.ts:54`), drive create→commit→push(bare remote)→`POST …/forge/pull-request`
  → assert session DTO carries `pullRequestUrl`.
- **Web:** `apps/web/src/components/pr-panel.spec.tsx` — button enabled only when eligible; renders PR
  link + checks after open.

### Changeset (one line)
`Added one-tap Open Pull Request from a session, with live PR status and CI checks in the UI.`  *(minor)*

---

# Phase 4 — Inbound: signature-verified webhook → session-create

**Goal:** A public, signature-verified webhook endpoint that turns a GitHub **issue** or **PR** event
into a Nuncio session (prompt = issue/PR title+body, repo + base branch resolved from payload). Maps the
event→session-create seam from recon.

### Files to add / change

| File | Change |
|---|---|
| `apps/server/src/forges/webhooks/webhooks.controller.ts` | **NEW** — `@Controller('webhooks/forge')`. Single `@Post(':provider')` handler. Needs the **raw body** for HMAC verification — register a raw-body parser for this route (NestJS `rawBody: true` on bootstrap, or a route-scoped `express.raw()` middleware). Verifies via `ForgeRegistry.get(provider).verifyWebhookSignature(headers, rawBody)`; on success delegates to `WebhooksService`. Returns 202 fast (work is async). |
| `apps/server/src/forges/webhooks/webhooks.service.ts` | **NEW** — `handleEvent(provider, event)`: use `provider.parseWebhookEvent()` → `ForgeWebhookEvent` (kind `issue\|pull_request`, action, repo, ref, title, body, number, sender). Map repo → local `projectPath` (match against `GitService.listProjects()`/`NUNCIO_PROJECT_ROOTS`; ignore unknown repos). Build `CreateSessionDto { prompt, projectPath, baseBranch, useWorktree: true }` and call `SessionsService.create()` (`sessions.service.ts:96`). Idempotency: dedupe on `(provider, deliveryId)` and on `(repo, issue/pr number)` to avoid duplicate sessions (store a `forge_webhook_deliveries` table or reuse the unique-index pattern from `sessions_cli_chat_unique`, `database.service.ts:131`). |
| `apps/server/src/forges/providers/github-forge.provider.ts` | Implement `verifyWebhookSignature()` (HMAC-SHA256 of raw body with `GITHUB_WEBHOOK_SECRET`, constant-time compare vs `x-hub-signature-256`) + `parseWebhookEvent()` (map `issues`/`pull_request` payloads). |
| `apps/server/src/forges/forges.module.ts` | Register webhook controller + service; import `SessionsModule` (or a slimmer seam) to call `SessionsService.create`. Mind the dependency direction (Sessions imports Git; Forges imports Sessions — no cycle since Sessions does not import Forges). |
| `apps/server/src/main.ts` | Enable raw body (`NestFactory.create(AppModule, { rawBody: true })`, `main.ts:39`) **or** exclude `webhooks/*` from the global `/api` prefix (`setGlobalPrefix('api', { exclude: [...] })`, `main.ts:40`) depending on the exposure decision (D5). Keep CORS as-is. |
| `apps/server/src/db/database.service.ts` | Add `forge_webhook_deliveries` table (`CREATE TABLE IF NOT EXISTS`) for idempotency, in `migrate()` / `SCHEMA`. |
| `apps/web/src/components/session-detail.tsx` (optional) | Badge a session as "From GitHub issue #N" using a new `origin`/`forgeProvider` field (cheap, optional). |

### New API routes

| Method | Path | Notes |
|---|---|---|
| POST | `/api/webhooks/forge/github` *(or un-prefixed `/webhooks/forge/github`, per D5)* | Signature-verified. 202 on accept, 401 on bad signature, 204/ignored for irrelevant events/repos. |

### New settings keys
`GITHUB_WEBHOOK_SECRET` already added in Phase 2 (used here). Optional `NUNCIO_WEBHOOK_AUTO_CREATE`
(`off\|issues\|prs\|all`) to scope which events spawn sessions — default conservative (D6).

### New session / data fields
Optional `origin TEXT` (`manual\|webhook`) + reuse `forgeProvider` on the session for provenance.
New `forge_webhook_deliveries(provider, delivery_id, created_at)` table (idempotency, not on session).

### Test plan

- **Unit (TDD-first):**
  - `apps/server/test/unit/forges/github-forge.provider.spec.ts` — `verifyWebhookSignature`: valid HMAC
    passes, tampered body/signature fails; `parseWebhookEvent` maps `issues.opened` + `pull_request.opened`
    to `ForgeWebhookEvent`, returns `null` for ignored actions.
  - `apps/server/test/unit/forges/webhooks.service.spec.ts` — known repo → `SessionsService.create` called
    with mapped prompt/projectPath/baseBranch/useWorktree; unknown repo → no session; duplicate delivery →
    no duplicate session (idempotency).
- **e2e (integration):** `apps/server/test/e2e/webhooks.e2e-spec.ts` — **NEW**. POST a signed GitHub
  payload fixture → 202 + a session row appears (`GET /api/sessions`); bad signature → 401 + no session;
  replay same delivery → still one session. Build on the existing e2e harness (`initRepo` +
  `withSimulatedCursorProvider` so the spawned session's agent run is simulated, `app.e2e-spec.ts:54`).
- **Vs implementation:** unit covers signature/mapping; e2e covers the HTTP→DB seam end to end.

### Changeset (one line)
`Added GitHub webhooks so a new issue or pull request can automatically start a Nuncio session.`  *(minor)*

---

# Phase 5 — GitLab adapter (MRs, PAT/OAuth, self-hosted URL) behind the same interface

**Goal:** Prove the abstraction by adding GitLab with **zero changes** to sessions/UI control flow —
only a new provider + settings entries. Merge Requests instead of PRs; self-hosted instance URL.

### Files to add / change

| File | Change |
|---|---|
| `apps/server/src/forges/providers/gitlab-forge.provider.ts` | **NEW** — `GitlabForgeProvider extends BaseForgeProvider`, `id='gitlab'`. Implement the same `ForgeProvider` surface against GitLab REST v4: `createPullRequest` → `POST /projects/{id}/merge_requests`; `getPullRequest` → MR show; `listChecks` → pipelines/jobs; `addComment` → MR notes; `verifyWebhookSignature` → compare `x-gitlab-token` (GitLab uses a shared secret token, **not** HMAC — handled inside the provider so the interface stays uniform); `parseWebhookEvent` → map `issue`/`merge_request` hooks. `getCurrentUser` → `GET /user`. Project id from remote `owner/repo` (URL-encoded path). |
| `apps/server/src/forges/forges.registry.ts` | Register `GitlabForgeProvider` in the providers array (one line; mirrors adding a provider to `AgentRegistry`). |
| `apps/server/src/forges/forges.module.ts` | Add `GitlabForgeProvider` to providers. |
| `apps/server/src/forges/webhooks/webhooks.controller.ts` | Route `:provider` already generic — `/webhooks/forge/gitlab` works via `ForgeRegistry.get('gitlab')`. No structural change. |
| `apps/server/src/settings/settings.registry.ts` | Add `GITLAB_TOKEN` (secret), `GITLAB_API_URL` (default `https://gitlab.com/api/v4`; self-hosted override), `GITLAB_WEBHOOK_SECRET` (secret). |
| `apps/server/src/git/git.service.ts` | `remoteInfo` already returns `host` — used to auto-pick `github` vs `gitlab` provider (host match), with explicit override allowed. |
| `apps/web/src/components/settings-view.tsx` / `pr-panel.tsx` | Copy reads "Pull/Merge Request" generically; provider label resolved from forge id. Mostly automatic (catalog-driven settings + generic PR DTO). |

### New API routes
None — the Phase 3/4 routes are provider-generic (`/api/sessions/:id/forge/pull-request`,
`/api/webhooks/forge/:provider`).

### New settings keys
`GITLAB_TOKEN` (secret), `GITLAB_API_URL` (string, self-hosted instance URL), `GITLAB_WEBHOOK_SECRET` (secret).

### New session / data fields
None new — `forgeProvider` already stores `github\|gitlab`; PR fields are reused for MRs.

### Test plan

- **Unit (TDD-first):** `apps/server/test/unit/forges/gitlab-forge.provider.spec.ts` — stubbed HTTP:
  `createPullRequest` posts MR payload to `/merge_requests`; `verifyWebhookSignature` matches
  `x-gitlab-token`; `parseWebhookEvent` maps `merge_request`/`issue` hooks; self-hosted `GITLAB_API_URL`
  honored. `forges.registry.spec.ts` — both providers resolvable; `defaultId`/host auto-select.
- **e2e:** extend `apps/server/test/e2e/webhooks.e2e-spec.ts` with a GitLab signed payload → session created
  via the same seam.
- **Integration (opt-in):** `test/integration/gitlab-forge.integration.spec.ts` gated on `GITLAB_TOKEN`.

### Changeset (one line)
`Added GitLab support: open merge requests and trigger sessions from GitLab issues/MRs, including self-hosted.`  *(minor)*

---

## Cross-phase decisions needing owner/user input

> **TL;DR for each — recommendation first, then the trade-off, then options.**

**D0 — Which SDK lane carries forge work? — ✅ RESOLVED.**
**Decision: carry it through the current `codex/github-gitlab-integration` → `codex-sdk` → `main`, then sync
`main` back to `pi-sdk` + `cursor-sdk`.** This is the AGENTS.md:96 "shared/provider-neutral work" path — the
`codex/` prefix is routing only (not SDK ownership), and the work becomes shared once it lands on `main`, the
shared source of truth. Rejected alternative: a dedicated `forge-sdk` integration branch (would require
editing the `branch-flow` CI rules + spec + AGENTS.md + manual GitHub branch protection). Per-phase feature
branches: `codex/forge-phase-NN` off `codex-sdk`, combined per the parallel-lane convention before one PR to
`codex-sdk`.

**D1 — Where do session-scoped git routes live (Phase 1)?**
**TL;DR: add a thin `git-session.controller.ts` inside `SessionsModule`.** Gain: avoids a Git→Sessions
circular import (Sessions already imports Git, `sessions.module.ts:4`); lose: git routes split across two
controllers. Options: (a) new controller in SessionsModule (recommended); (b) inject `SessionsService` into
`GitModule` (risks a cycle).

**D2 — git push / commit auth (Phase 1).**
**TL;DR: rely on the host's existing git credentials** (ssh agent / credential helper) for v1; document it.
Gain: zero secret handling, works with the user's current `git push`; lose: the `Bun.spawn` git process must
inherit the user's env/keychain — confirm on the always-on Mac. Options: (a) host credentials (recommended);
(b) inject `GITHUB_TOKEN` into an HTTPS remote URL for push (needed for headless/webhook-created sessions in
Phase 4 — revisit then). **Note:** webhook-created sessions (Phase 4) may have no interactive credentials —
token-based push likely required there.

**D3 — Settings category for forge keys (Phase 2).**
**TL;DR: reuse the existing `provider` category** to ship with zero type changes. Gain: no edits to the
`SettingCategory` union (`settings.types.ts:11`) or settings-view grouping; lose: forge creds sit next to
agent creds in the UI. Options: (a) reuse `provider` (recommended); (b) add a `'forge'` category for a
cleaner Settings page.

**D4 — How automatic is commit → push → PR (Phase 3)?**
**TL;DR: ship manual (button-driven) for v1**, add an opt-in `NUNCIO_FORGE_AUTO` later. Gain: user stays in
control, safer for a Devin-style tool acting on real repos; lose: an extra tap vs. fully hands-off. Options:
(a) manual buttons (recommended); (b) auto-commit on IDLE; (c) full auto chain to PR behind a setting
(seam at `sessions.service.ts:421` / `agents.base-provider.ts:74`).

**D5 — Webhook exposure + URL prefix (Phase 4).**
**TL;DR: expose via Tailscale Funnel and keep the route under `/api/webhooks/...`** (with raw-body parsing),
documented as opt-in. Gain: reuses the existing single public origin; lose: Funnel must be explicitly enabled
(Nuncio is normally tailnet-only, not public). Options: (a) Tailscale Funnel + `rawBody:true`
(recommended); (b) un-prefix `/webhooks/*` via `setGlobalPrefix` exclude (`main.ts:40`) and run a separate
listener; (c) external relay/proxy. **Decision drives `main.ts` bootstrap shape.**

**D6 — Which inbound events auto-create sessions (Phase 4)?**
**TL;DR: default to issues labeled for the bot (e.g. `nuncio`) only**, with `NUNCIO_WEBHOOK_AUTO_CREATE`
to widen. Gain: avoids a session storm from every issue/PR; lose: requires a label convention. Options:
(a) labeled issues only (recommended); (b) all opened issues; (c) issues + PRs; (d) all.

**D7 — GitHub PAT vs OAuth App vs GitHub App (cuts across 2/3/4).**
**TL;DR: start with PAT (`GITHUB_TOKEN`) for v1**, design `ForgeProvider` so an App/OAuth token source can
slot in later. Gain: simplest path to shipping outbound + inbound on a personal Mac; lose: no multi-org
installation tokens or fine-grained per-install auth. Options: (a) PAT now (recommended); (b) OAuth App
(adds a callback route + token exchange); (c) GitHub App (App ID + private key + installation tokens — best
for multi-tenant, heaviest). The interface (`getCurrentUser`, token resolution via settings) is identical;
only the credential source differs.

---

## Recommended execution order for subagents

Lanes follow the AGENTS.md split: **A — Backend** (`apps/server/src/**` non-spec), **B — Frontend**
(`apps/web/src/**`), **C — Tests + Docs** (`*.spec.ts`, `test/**`, `README.md`, `plans/reports/`).
Per AGENTS.md, **Tester writes specs first (red)**, Developer implements to green, Reviewer gates before PR.

### Phase-by-phase

**Phase 1 (no new module — extends git):**
1. `tester` writes failing `git.service.spec.ts` cases + `review-changes.spec.tsx` (red).
2. `developer` (Lane A) implements `GitService` methods + session-scoped controller + `git.types.ts`.
3. **In parallel** `ui-developer` (Lane B) builds `review-changes.tsx` + `api.ts` helpers against the agreed DTOs.
4. `tester` (Lane C) lands the e2e push-to-bare-remote case; `developer` makes it green.
5. `reviewer` runs the code-review gate → changeset → PR.

**Phase 2 (forge module + auth):**
1. `tester` writes `forges.registry.spec.ts` + `github-forge.provider.spec.ts` (auth-only) + settings-key spec (red).
2. `developer` (Lane A) lands `forges.types.ts` → `forges.base-provider.ts` → `forges.registry.ts` →
   `github-forge.provider.ts` (auth) → `forges.module.ts` → `app.module.ts` + settings entries.
3. `ui-developer` (Lane B) — minimal (settings UI is catalog-driven); only needed if D3 adds a `forge` category.
4. `reviewer` gate → changeset → PR.

**Phase 3 (outbound PR):**
1. `tester` writes provider PR/checks/comment specs + `remoteInfo` parse spec + repo migration spec + `pr-panel.spec.tsx` (red).
2. `developer` (Lane A): `remoteInfo`, provider PR methods, `forges.service.ts`, `forges.controller.ts`,
   session forge fields + migration + repository.
3. **In parallel** `ui-developer` (Lane B): `pr-panel.tsx` + `api.ts` helpers (depends only on the PR DTO contract).
4. `tester` (Lane C): e2e create→commit→push→PR with stubbed forge.
5. `reviewer` gate → changeset → PR.

**Phase 4 (inbound webhooks):**
1. `tester` writes `verifyWebhookSignature`/`parseWebhookEvent` specs + `webhooks.service.spec.ts` +
   `webhooks.e2e-spec.ts` (red).
2. `developer` (Lane A): provider signature/parse, `webhooks.controller.ts` + `webhooks.service.ts`,
   `main.ts` raw-body/prefix change (per D5), idempotency table.
3. `ui-developer` (Lane B): optional "From GitHub #N" provenance badge — **can run fully in parallel** (independent files).
4. `reviewer` gate (security focus: signature verification, raw-body handling, idempotency) → changeset → PR.

**Phase 5 (GitLab):**
1. `tester` writes `gitlab-forge.provider.spec.ts` + registry multi-provider spec + GitLab e2e payload (red).
2. `developer` (Lane A): `gitlab-forge.provider.ts` + registry/module registration + settings entries.
3. `ui-developer` (Lane B): generic "Pull/Merge Request" label polish — minimal, parallel.
4. `reviewer` gate → changeset → PR.

### What can run in parallel vs. must serialize
- **Serialize across phases:** 1 → 2 → 3 → 4 (3 needs 1's push + 2's auth; 4 needs 2's webhook secret +
  the session-create path). **5 can start once 2–4 land** (it only adds a provider).
- **Parallel within a phase:** Backend (Lane A) and Frontend (Lane B) run concurrently once the DTO/route
  contract is fixed by the Tester's red specs — strict file ownership (no overlapping edits) per AGENTS.md
  "Parallel-agent lane convention". Tester (Lane C) writes specs first, then only touches test/doc files.
- **Reviewer** always runs last per phase (gate before commit/PR), with extra scrutiny on Phase 4 (security).

### Per-phase Definition of Done (AGENTS.md gates)
`bun run test` + `bun run test:e2e` green · `bun run lint` clean · web `build`+`lint`+`test` green for UI
phases · `bun run add-changeset` fragment committed · code-review pass · `README.md` (API/architecture/status
table) + `AGENTS.md` (if conventions shifted) updated · lane report in `plans/reports/`.
