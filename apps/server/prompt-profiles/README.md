# Prompt profiles

Engine-specific prompting decisions live here as **data**, never in adapter code (ADR-004). A
profile shapes only what nuncio *appends/wraps* — it never modifies the engine's own
vendor-owned system prompt. The core Nuncio runtime identity and post-policy capability
manifest are also outside profile control: a profile can tune orchestration phrasing, but cannot
remove or contradict the host-awareness contract.

## Files

- `<provider>.md` — one per provider (e.g. `pi.md`, `cursor.md`, `codex.md`).
- `<provider>--<model-slug>.md` — model-specific variant (e.g. `claude--opus.md`).

A DB override (settings key `NUNCIO_PROMPT_PROFILE_<PROVIDER>`) holding a full profile document
wins over the repo file, letting the founder hotfix without a release.

**Resolution precedence:** DB override → model-specific repo file → provider repo file →
built-in empty pass-through (every wrapper absent → canonical content unchanged). Among matching
repo files, the most-specific `modelPattern` glob wins.

## Format

Markdown with YAML frontmatter and named `##` sections:

```markdown
---
provider: claude            # AgentProvider.id this applies to (required)
modelPattern: "*"           # glob against the model id; most-specific match wins (default *)
version: 3                  # integer (informational; default 1)
status: active              # draft | active | retired (default draft)
contextFileName: CLAUDE.local.md   # B4: engine's native context file; omit if none
evalScore: { passRate: 0.88 }      # stamped by the eval pipeline; informational only
---

## brief-wrapper
Wraps the rendered handoff brief. Use `{{content}}` for the canonical text (every
`{{content}}` occurrence is replaced). A wrapper with no slot → the canonical text is
appended after the wrapper text (fail-open, with a warning).

## facts-wrapper
Wraps the rendered project-facts block, same `{{content}}` rule.

## digest-wrapper
Wraps a task-completion digest message.

## tools-preamble
Overrides the default orchestration-tools system-prompt paragraph when present.

## idioms
Freeform human/eval notes. Injected nowhere; read by people and the distill step.
```

## Rules

- The **only** templating is `{{content}}` replacement — no conditionals, no loops. If a
  wrapper needs logic, that belongs in the canonical renderer, keeping profiles dumb data.
- Unknown sections are ignored with a warning (an old daemon tolerates a newer profile).
- A malformed profile (bad/absent frontmatter, missing `provider`) is skipped with one warning;
  resolution falls through to the next precedence level.

**No real profiles ship in this repo yet** — writing them is founder/eval work. Until then every
engine uses the empty pass-through, so composed prompts are byte-identical to having no profiles
at all.
