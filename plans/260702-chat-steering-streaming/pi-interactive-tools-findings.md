# Pi interactive tools (T4) — SDK findings and chosen design

## How interactive tools surface in the Pi SDK (`@earendil-works/pi-coding-agent` 0.80.2)

- Pi has no built-in AskQuestion tool; question/questionnaire tools come from **extensions**
  (`pi.registerTool`, see SDK `examples/extensions/question.ts` / `questionnaire.ts`). Extension
  tools load in SDK sessions too (`createAgentSession` auto-discovers `~/.pi/agent/extensions/`
  and `.pi/extensions/`), and their calls surface through `session.subscribe()` as ordinary
  `tool_execution_start` / `tool_execution_end` events with the tool name and args.
- Extension tools collect answers via `ctx.ui.select/confirm/input`. Each mode binds its own
  `ExtensionUIContext`; headless SDK embedding binds none, so the runner falls back to a **no-op
  UI context** (`dist/core/extensions/runner.js` — `select()` → `undefined`, `confirm()` → `false`).
  A pi run that hits an interactive tool therefore does not block: the tool resolves immediately
  with an empty/cancelled answer and the turn ends with the question unanswered.

## Chosen design (mirrors `CursorCliProvider`)

1. In the pi subscribe handler, a `tool_execution_start` whose tool name is in
   `tool-interaction.registry` and whose args normalize to questions emits `user_input_requested`
   (requestId = toolCallId) instead of `tool_start`; the matching `tool_execution_end` is swallowed.
2. `supportsInteraction()` → true; `submitInteraction()` resolves the pending request
   (`user_input_resolved`), formats the answers, and delivers them via `steerMidRun` when the run
   is still streaming (SDK queues before the next LLM call), else via a normal `steer` that
   re-enters the resumed pi session.

## Future option: truly blocking dialogs

`AgentSession.bindExtensions({ uiContext, mode })` is public — nuncio could bind a custom
`ExtensionUIContext` whose `select/confirm/input` emit `user_input_requested` and block until the
user answers, feeding the real answer back as the tool result mid-turn. Deliberately not done now:
it depends on per-extension `ctx.hasUI` behavior, risks hanging runs on unanswered dialogs, and
the steer-based path already gets answers to the model. Revisit if extension tools that *require*
a synchronous answer show up in practice.
