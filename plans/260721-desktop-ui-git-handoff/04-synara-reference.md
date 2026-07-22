# Reference — Synara source map (open-source competitor, same product category)

Synara ("Open-source GUI for Agentic Development", trysynara.com, GitHub
`Emanuele-web04/synara`, MIT-era open repo) is an Electron desktop app running Codex, Claude,
Cursor, Antigravity, Grok, Droid, Kilo, OpenCode, **Pi** as engines — nuncio's closest
comparable, with public source. Shallow clone studied 2026-07-21 (session scratchpad; ~49MB).
Stack: Electron 40, React 19 + Zustand + TanStack Query/Router + Tailwind v4 + Base UI,
Effect-TS event-sourced server, Bun + Turborepo.

Paths below are relative to their repo root.

## Window chrome (Track A1 reference)

`apps/desktop/src/main.ts` (`createWindow`, `getTitleBarOptions`, `getWindowMaterialOptions`):
- macOS: `titleBarStyle:'hiddenInset'`, computed `trafficLightPosition` so the dots center in a
  46px header; `vibrancy:'under-window'`, `visualEffectState:'followWindow'`,
  `backgroundColor:'#00000000'`.
- Windows: `frame:false`, renderer draws min/max/close. Linux: opaque, no vibrancy.
- **`packages/shared/src/desktopChrome.ts`** — `CHAT_SURFACE_HEADER_HEIGHT_PX = 46`,
  `MAC_TRAFFIC_LIGHT_DOT_RADIUS_PX`, `getMacTrafficLightPosition()` — one constant imported by
  BOTH main and renderer; drag via CSS `-webkit-app-region` with `no-drag` on the header's
  action cluster (`chat/ChatHeader.tsx`).

## Layout

Routes (TanStack file-based): `_chat.$threadId`, `_chat.pull-requests`, `_chat.kanban`,
`_chat.automations`, `_chat.settings`, `_chat.workspace`, `_chat.studio`, `_chat.plugins`.
Sidebar resizable (`ui/sidebar.tsx`, min 13rem) → single/split chat lanes
(`chat/SingleChatSurface.tsx` / `SplitChatSurface.tsx`) → **right dock**
(`chat/RightDock.tsx`: Browser, Explorer, File, Terminal, Pull-request panes;
`rightDockStore.ts`) → bottom terminal tabs (`TerminalWorkspaceTabs.tsx`, xterm v6 + webgl).
Diff rendering via `@pierre/diffs`; staging pane `chat/GitPanel.tsx`.

## Git rail (Track B reference)

- **`components/GitActionsControl.tsx` + `.logic.ts`** — header split-button + dropdown:
  Commit / Commit & push / Push / Create PR / Create Branch / Sync branch; stacked type
  `GitStackedAction = 'commit'|'push'|'create_pr'|'commit_push'|'commit_push_pr'`; commit
  dialog; default-branch confirmation (`requiresDefaultBranchConfirmation`); staged progress
  toast (`buildGitActionProgressStages`: "Generating commit message… → Committing… → Pushing to
  {target}… → Creating PR…").
- **`components/BranchToolbar.tsx`** — project + branch + worktree switcher in one compact
  control.
- Server: `git/Services/GitManager.ts` (`runStackedAction`, `handoffThread` local↔worktree),
  `git/Services/TextGeneration.ts` + per-provider layers — **AI commit message + PR title/body**
  (default model gpt-5.4-mini; inputs = staged summary + patch, or base/head + diff summary);
  `git/Layers/GitHubCli.ts` — all GitHub ops via `gh` CLI (`pr create --body-file` so user
  content never hits argv); `GitStatusBroadcaster.ts` — live status push.
- PR review inbox: route `_chat.pull-requests*`, `components/pullRequest/*`
  (`PullRequestList/Row/ListFilters`, grouping by involvement; detail tabs Summary/Code/Timeline,
  checks ring, comment composer; dockable beside chat via `PullRequestDockPane.tsx`).
- Worktree lifecycle: transcript-inline stepper `chat/MessagesTimeline.tsx` →
  `WorktreeSetupCard` (vertical `<ol>` with connector lines, per-step glyphs, shimmer
  "Preparing worktree…"); server `worktreeSetup.ts`, `managedWorktrees.ts`;
  local↔worktree move persisted in `gitHandoffOperations.ts` (phases
  `new|pending|uncertain|git_applied|completed`, idempotency table).

## Cross-engine handoff (Track C reference)

- UI: `chat/ChatHeader.tsx` "Hand off" menu (per-provider items, availability-gated) +
  source→target provider badge.
- Client: `hooks/useThreadHandoff.ts`, `lib/threadHandoff.ts`
  (`buildThreadHandoffImportedMessages` — completed user/assistant msgs, fresh ids, attachments;
  `resolveThreadHandoffModelSelection` — sticky per-provider → project default → provider
  default; same branch/worktree travels; composer draft copied).
- Server: `orchestration/decider.ts` `thread.handoff.create` → fresh thread,
  `handoff:{sourceThreadId, bootstrapStatus:'pending'}`, transcript as `handoff-import` rows;
  `orchestration/handoff.ts` `buildHandoffBootstrapText` — last 6 msgs verbatim (2,400 chars
  each) + older as 320-char bullets, budget `min(0.75×provider max, 32,000)` chars, metadata
  prefix; `Layers/ProviderCommandReactor.ts` injects once on first native turn as
  `<handoff_context>…</handoff_context>` + `<latest_user_message>`, then marks completed.
  Guard: no re-handoff until ≥1 native message. Sibling builders reuse the same machinery:
  fork/sidechat (`sidechat_context`) and engine-restart (`thread_context`).

## Theming

`apps/web/src/index.css` — Tailwind v4 `@theme inline`, semantic vars incl. PR status colors +
brand `--claude`; single `--radius` with multiplier scale; `--app-shell-background` transparent
over vibrancy. Theme engine `theme/theme.logic.ts` + generated `theme.seed.generated.ts`
(themes generated from an accent/surface seed, incl. `semanticColors.diffAdded/diffRemoved`).
