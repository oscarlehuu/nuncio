# Changelog

## 0.3.0

### Minor Changes

- [#35](https://github.com/oscarlehuu/nuncio/pull/35) [`918c64c`](https://github.com/oscarlehuu/nuncio/commit/918c64c1568f7f2226d7caeb45da349769b69239) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Added a Review changes panel so you can see, commit, and push an agent's work directly from a session.

- [#21](https://github.com/oscarlehuu/nuncio/pull/21) [`066a29b`](https://github.com/oscarlehuu/nuncio/commit/066a29bb934788419724638744ba5a5d7d6e8917) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Added Codex approval controls in the chat composer and transcript so pending local actions can be approved or denied, with pending approval state tracked in SQLite.

- [#21](https://github.com/oscarlehuu/nuncio/pull/21) [`066a29b`](https://github.com/oscarlehuu/nuncio/commit/066a29bb934788419724638744ba5a5d7d6e8917) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Added Codex as a local app-server provider so sessions can run with your existing Codex login.

- [#35](https://github.com/oscarlehuu/nuncio/pull/35) [`918c64c`](https://github.com/oscarlehuu/nuncio/commit/918c64c1568f7f2226d7caeb45da349769b69239) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Added GitHub account settings (token + API URL) so Nuncio can connect to your GitHub account.

- [#35](https://github.com/oscarlehuu/nuncio/pull/35) [`918c64c`](https://github.com/oscarlehuu/nuncio/commit/918c64c1568f7f2226d7caeb45da349769b69239) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Added GitHub webhooks so a new issue labeled nuncio can automatically start a session.

- [#35](https://github.com/oscarlehuu/nuncio/pull/35) [`918c64c`](https://github.com/oscarlehuu/nuncio/commit/918c64c1568f7f2226d7caeb45da349769b69239) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Added GitLab support: open merge requests and trigger sessions from GitLab issues, including self-hosted instances.

- [#35](https://github.com/oscarlehuu/nuncio/pull/35) [`918c64c`](https://github.com/oscarlehuu/nuncio/commit/918c64c1568f7f2226d7caeb45da349769b69239) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Added one-tap Open Pull Request from a session, with live PR status and CI checks in the UI.

- [#32](https://github.com/oscarlehuu/nuncio/pull/32) [`5200f85`](https://github.com/oscarlehuu/nuncio/commit/5200f857304b2cce20d209dcc47576380d2f8ed0) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Added server API support for provider capabilities, Pi interrupts, live model switching, and image attachments.

- [#18](https://github.com/oscarlehuu/nuncio/pull/18) [`c363bbe`](https://github.com/oscarlehuu/nuncio/commit/c363bbe4fb7dbd88a718383447dfcdd31c8e2176) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Added URL routes so sessions and pages survive a browser refresh.

- [#35](https://github.com/oscarlehuu/nuncio/pull/35) [`918c64c`](https://github.com/oscarlehuu/nuncio/commit/918c64c1568f7f2226d7caeb45da349769b69239) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - GitHub/GitLab now also authenticate via the gh and glab CLIs, and Settings shows which method (token or CLI) is in use.

- [#35](https://github.com/oscarlehuu/nuncio/pull/35) [`918c64c`](https://github.com/oscarlehuu/nuncio/commit/918c64c1568f7f2226d7caeb45da349769b69239) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Redesigned Settings into Providers and Source Control sections with per-provider connect/manage rows and brand icons.

### Patch Changes

- [#21](https://github.com/oscarlehuu/nuncio/pull/21) [`066a29b`](https://github.com/oscarlehuu/nuncio/commit/066a29bb934788419724638744ba5a5d7d6e8917) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Added Codex reasoning and Priority controls to the model picker.

- [#18](https://github.com/oscarlehuu/nuncio/pull/18) [`c363bbe`](https://github.com/oscarlehuu/nuncio/commit/c363bbe4fb7dbd88a718383447dfcdd31c8e2176) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - CLI handoff sessions now show when Cursor is running on your Mac, surface steer conflicts with a toast and force-steer option, and auto-refresh the transcript when the IDE run finishes.

- [#18](https://github.com/oscarlehuu/nuncio/pull/18) [`c363bbe`](https://github.com/oscarlehuu/nuncio/commit/c363bbe4fb7dbd88a718383447dfcdd31c8e2176) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - CLI handoff sessions now update in realtime when Cursor IDE adds new turns — no hard reload needed.

- [#18](https://github.com/oscarlehuu/nuncio/pull/18) [`c363bbe`](https://github.com/oscarlehuu/nuncio/commit/c363bbe4fb7dbd88a718383447dfcdd31c8e2176) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Fixed CLI handoff transcript sync — removed the 500-turn cap that prevented new Cursor IDE messages from appearing after refresh, and fixed the dedup so repeated tool calls are no longer duplicated. Split the AI's internal thinking that Cursor concatenates onto assistant messages into a separate collapsible "Thought for Xs" block (matching Cursor's UI). Moved repo/branch/Local into the composer footer row and auto-scroll to the latest message on session enter.

- [#32](https://github.com/oscarlehuu/nuncio/pull/32) [`dca1741`](https://github.com/oscarlehuu/nuncio/commit/dca174105d2a3c90317bb43534e6b16cd65281b6) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Fixed Pi sessions so they resume from the same persisted thread after the server restarts.

- [#21](https://github.com/oscarlehuu/nuncio/pull/21) [`066a29b`](https://github.com/oscarlehuu/nuncio/commit/066a29bb934788419724638744ba5a5d7d6e8917) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Fixed the session composer unlocking late after an agent finishes replying.

- [#25](https://github.com/oscarlehuu/nuncio/pull/25) [`69c7675`](https://github.com/oscarlehuu/nuncio/commit/69c76754370018eca62cf4ef6e0ca657baf2c3f0) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Handoff sessions now show a live AskQuestion form on your phone and accept answers from Nuncio instead of closing the prompt in milliseconds.

- [#25](https://github.com/oscarlehuu/nuncio/pull/25) [`69c7675`](https://github.com/oscarlehuu/nuncio/commit/69c76754370018eca62cf4ef6e0ca657baf2c3f0) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Imported AskQuestion prompts now render as structured questionnaire blocks in the transcript instead of generic tool rows.

- [#21](https://github.com/oscarlehuu/nuncio/pull/21) [`066a29b`](https://github.com/oscarlehuu/nuncio/commit/066a29bb934788419724638744ba5a5d7d6e8917) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Kept generated Nuncio session branches out of the base branch picker.

- [#21](https://github.com/oscarlehuu/nuncio/pull/21) [`066a29b`](https://github.com/oscarlehuu/nuncio/commit/066a29bb934788419724638744ba5a5d7d6e8917) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Made per-session worktrees opt-in with a Work locally/New worktree picker that forks worktrees from the selected branch.

- [#18](https://github.com/oscarlehuu/nuncio/pull/18) [`c363bbe`](https://github.com/oscarlehuu/nuncio/commit/c363bbe4fb7dbd88a718383447dfcdd31c8e2176) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Redesigned the session transcript to match the Cursor IDE style: tool calls render as compact one-line rows (e.g. "Read foo.ts L10-20", "Ran `pnpm test`"), consecutive tool calls collapse into a single "Ran N files, M commands…" summary header that expands to reveal individual rows, and thinking blocks collapse to a single "Thought" row. File paths and commands use inline monospace pills, the "Done" status label is hidden by default (only "Failed" and "Running…" appear), and the overall spacing is tighter so long agent runs no longer fill the screen with full-width tool boxes.

- [#21](https://github.com/oscarlehuu/nuncio/pull/21) [`066a29b`](https://github.com/oscarlehuu/nuncio/commit/066a29bb934788419724638744ba5a5d7d6e8917) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Updated Codex in the model picker to use a branded icon instead of the fallback letter.

## 0.2.0

### Minor Changes

- [#5](https://github.com/oscarlehuu/nuncio/pull/5) [`3c8760b`](https://github.com/oscarlehuu/nuncio/commit/3c8760b88ed17c8a7c152c647430b47f7ff566f4) Thanks [@oscarlehuu](https://github.com/oscarlehuu)! - Added **Continue on mobile** — pick an in-progress Cursor chat from your Mac and import it into Nuncio so you can steer it from your phone. Imported chats resume via the Cursor CLI (`agent --resume`); sessions you create in Nuncio still use the in-process SDK.

## 0.1.0

### Minor Changes

- Initial public release: a self-hosted, mobile-first web app for delegating tasks to AI coding agents. Create a session with a prompt, the agent runs in-process and streams output as events; steer mid-task, pause, archive, restore, or delete. ([#1](https://github.com/oscarlehuu/nuncio/pull/1))
- Provider-agnostic agent harness: a common `AgentProvider` interface + `AgentRegistry` so any agent SDK plugs in uniformly. Pi SDK is the inaugural provider; a built-in Mock provider keeps the UI working end-to-end when no credentials are configured. ([#1](https://github.com/oscarlehuu/nuncio/pull/1))
- Per-session provider + model selection — choose the agent provider and the exact model per session; both are stored on the session and wired through to the SDK. ([#2](https://github.com/oscarlehuu/nuncio/pull/2))
- Cursor provider via `@cursor/sdk` local runtime — enable with `CURSOR_API_KEY` (settable from the Settings UI, encrypted at rest). ([#2](https://github.com/oscarlehuu/nuncio/pull/2))
- Git worktree workspace per session — each session can run in an isolated git worktree on a throwaway branch; pick a project folder and base branch from the create-session form. ([#3](https://github.com/oscarlehuu/nuncio/pull/3))
- Settings store — runtime-configurable env vars (API keys, paths, flags) stored in SQLite and editable via the frontend; secrets encrypted at rest (AES-256-GCM), env vars still honoured as fallback. ([#4](https://github.com/oscarlehuu/nuncio/pull/4))
- Server-side folder picker — browse the host machine's directories to pick a project (works on iPhone PWA), or paste a custom path. ([#4](https://github.com/oscarlehuu/nuncio/pull/4))
- Installable mobile-first PWA — standalone dark UI, safe-area aware; install on iPhone via Tailscale HTTPS. ([#1](https://github.com/oscarlehuu/nuncio/pull/1))

### Patch Changes

- Migrated runtime to Bun (`bun:sqlite` + `bun test`) for the server, build, and tests. ([#1](https://github.com/oscarlehuu/nuncio/pull/1))
- shadcn/ui (radix-nova preset) with light + dark theming and Vitest component tests for the frontend. ([#1](https://github.com/oscarlehuu/nuncio/pull/1))
- Pi auth hardening — API key or OAuth/subscription tokens via the SDK's `AuthStorage`. ([#1](https://github.com/oscarlehuu/nuncio/pull/1))
- Cursor streaming UX polish and provider UI overhaul. ([#4](https://github.com/oscarlehuu/nuncio/pull/4))
