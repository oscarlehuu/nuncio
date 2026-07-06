# Phase 3 — Images, model options, picker polish

**Effort:** 0.5d
**Depends on:** Phase 1. Independent of Phase 2 (parallelizable).

## Images

- Flip `capabilities.images: true` (post-S5 confirmation).
- In `executePrompt`, when `context.attachments` present, build the `SDKUserMessage.message.content` as blocks: text + `{ type: 'image', source: { type: 'base64', media_type, data } }` per attachment. MediaStore already hands the provider `{ kind, mimeType, data }` — same consumption path Pi uses (shipped 2026-07-04 plan).
- Verify paste-`[image N]`-refs render + round-trip in a real session.

## Model catalog + options

- `listModels()` final shape (from Phase 1 decision): group `Claude`, models from `initializationResult().models` or static list — display names, `sub` line ("Subscription (claude.ai login) · or API key"), icon.
- **Effort:** wire per S6 finding — if in-session, map nuncio `modelOptions` effort → SDK; mirror how `cursor-model-options.helpers.ts` / Codex expose effort so the UI picker Just Works (options schema is shared, no UI code).
- **Thinking:** pass `thinking` option at query start from modelOptions if we expose it; thinking deltas already render via the shared `thinking_*` events.

## Polish

- Provider icon/avatar in the transcript (`showAvatar` path — web asset only, no per-provider transcript logic).
- Session preview + status behaviors come free from BaseAgentProvider; verify nothing renders oddly with long tool-heavy Claude turns (tool summary noise).

## Exit criteria

- Send an image to a Claude session from web UI → model describes it.
- Model picker shows the Claude group with working model + effort switching per the declared capabilities.
- `bun run test` + web unit suites green; real-browser check per the playwright-core rule for any web-visible change.
