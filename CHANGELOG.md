# Changelog

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
