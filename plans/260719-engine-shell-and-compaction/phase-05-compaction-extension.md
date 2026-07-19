# Phase 05 — Compaction extension + Nuncio Engine settings group (Track B)

## Context links

- `apps/server/src/agents/pi-engine/engine-extension.ts` — the rail this rides (add a second hook
  registration alongside the gate guard).
- Phase 04 deliverables (contract spec, survivors builder).
- Grok Build `code_compaction` (Apache-2.0) — skeleton + degenerate-summary check inspiration;
  Codex `compact.rs` — verbatim user-message budget inspiration. Design only, no code dependency.

## Overview

Priority: high. The `session_before_compact` handler. Pi keeps the machinery (trigger, cut
mechanics, session-file write + reload); Nuncio owns the policy — the summary is assembled as:

```
[1 survivors block — verbatim, from session-state-snapshot]
[2 recent user messages — verbatim, ≈4K-token budget, newest-first]
[3 LLM summary of the remainder — cheap model, incremental (previous summary honored),
   file-ops ledger preserved]
[4 transcript pointer — "full history is durable; use read_session_history"]
```

Returned as `SessionBeforeCompactResult.compaction` (summary string + Pi's prepared
`firstKeptEntryId`). **Fail-open on every path**: any error, degenerate summary after one retry,
or timeout → return `undefined` → Pi default compaction runs. A session is never bricked by this
layer.

## Requirements

- Summarizer model: `NUNCIO_ENGINE_COMPACTION_MODEL`, default `cliproxyapi:claude-sonnet-4-6`;
  unavailable model → fall back to session model, then to Pi default (fail-open ladder).
- Degenerate check (conservative): empty, near-empty, or trivially repetitive summary → one retry
  → fail-open. Never blocks compaction from happening.
- Toggle: `NUNCIO_ENGINE_COMPACTION=on|off`, **default off** (opt-in until phase 06 eval win).
- **Engine settings group (locked decision 6):** register `NUNCIO_ENGINE_COMPACTION`,
  `NUNCIO_ENGINE_COMPACTION_MODEL`, `NUNCIO_ENGINE_POLICY_SHELL` in `settings.registry.ts` and
  surface `NUNCIO_ENGINE_GATE_GUARD` there too, grouped as "Nuncio Engine" in the Settings UI.
  (Per-phase thinking effort is backlog riding this same group.)
- Solo Engine sessions only in this round (Crew loads the rail via phase 02, but Crew compaction
  behavior stays default until evaluated separately).

## Related code files

- **Create:** `apps/server/src/agents/pi-engine/compaction-extension.ts` (+ spec)
- **Edit:** `apps/server/src/agents/pi-engine/engine-extension.ts` — register the hook (toggleable)
- **Edit:** `apps/server/src/agents/providers/pi-agent.provider.ts` — thread settings/summarizer
  dependencies into the factory options
- **Edit:** `apps/server/src/settings/settings.registry.ts` — Engine group entries
- **Web:** settings view renders the catalog generically — verify grouping renders; adjust only if
  the group header needs a label mapping.

## Implementation steps (TDD)

1. Red: assembly specs — skeleton order fixed; survivors byte-identical to builder output; user
   messages selected newest-first within budget with truncation of the oldest selected; previous
   summary passed through to the incremental prompt; pointer appended.
2. Red: fail-open specs — summarizer throws / degenerate twice / toggle off / non-Engine session →
   `undefined` (Pi default). Green: implement.
3. Red: settings specs — resolution DB→env→default, cache-bust on change. Green: registry entries.
4. Verify in the web Settings UI (level-5 visual check, light/dark).

## Todo

- [ ] Assembly + fail-open specs → implementation
- [ ] Settings group + UI verification
- [ ] Changeset (minor): "Nuncio Engine sessions can now preserve plan, verify, and steer state
      verbatim across context compaction (opt-in), configurable in Settings."

## Risks

- Skeleton overhead inflates the compacted context → hard per-block budgets (phase 04) + measure
  `tokensBefore/after` in the emitted event payload.
- Cheap-model summary quality — mitigated by the skeleton carrying everything critical verbatim;
  the summary only narrates the remainder.
