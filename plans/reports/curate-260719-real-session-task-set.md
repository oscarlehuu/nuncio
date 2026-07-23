# Curated eval task set — from real Nuncio sessions (2026-07-19)

Data source: `~/.nuncio/data/nuncio.db` (29 sessions; **0** carried `verify_start` /
`verify_result` — every verifyCommand below is curator-supplied).

## Shortlist

| Session | Shape | Why kept | Graded vehicle |
|---|---|---|---|
| `1e9997f2` | UI bug + 2 steers | Model picker preference leaked across composers; later fixed in `fbb4afa8` | **Distilled** `eval/tasks/isolate-model-picker-per-composer.json` + fixture `model-pref-composer-scope` |
| `94aa1f34` | UI bug + steer | User messages wrong after agent turns; related fix `cc39f003` | Seed JSON only (full-repo pin; hard to plant a tiny failing contract) |
| `4f09a061` | Engine / hermetic | Engine still picking up Pi global extensions after hermetic setup | Seed JSON only |
| `900850e2` | Multi-CLI resolve | Codex CLI discovery when several installs exist + steer "implement" | Seed JSON only |
| `f0605d4d` | Workbench UX | Grid chat not full enough for long work | Seed JSON only |
| `ba1eb035` | Runtime identity | Agents should know they are inside Nuncio (any engine) | Seed JSON; overlaps shipped `identify-nuncio-runtime` |

Rejected for this set: pure research/chat (`88466278` tour), compaction filler
(`ab3650e7` count 1–500), image-only "fix this" with no recoverable text contract
(`ccf789bc`), duplicate Pi-update sessions.

## Artifacts

- Graded (portable, suite-safe): `eval/tasks/isolate-model-picker-per-composer.json`
  + `eval/fixtures/model-pref-composer-scope/`
- Archival seeds (machine-local `{ repo, baseSha }` pins, `informational` + `control`):
  `plans/260719-engine-shell-and-compaction/curated-tasks/*.json`
- Re-extract: `bun run eval:extract -- --session <id> --data-dir ~/.nuncio/data --slug … --base-sha … --verify-command "…"`

## Curation rules applied

1. Prefer Builder-shaped sessions (fix/implement + steers) over chat/research.
2. Strip composed preamble (extractor already keeps the final user section).
3. Fold human steers into the distilled prompt (eval runner does the same for recorded tasks).
4. Full-repo recorded pins stay **seed/control** until a session lands with a real
   verify loop — otherwise `bun test` at HEAD-of-day can pass without the fix.
5. Distill when a real fix has a clear unit contract (here: scoped model preference).

## Real Crew run (this curation)

See the same-day append below / `eval` server logs under `/tmp/nuncio-eval/` for the
Builder=pi arm on `model-pref-composer-scope`.

## Real Crew run (Builder = pi + sandboxed shell)

Date: 2026-07-19. Daemon `:3077`, `NUNCIO_DATA_DIR=/tmp/nuncio-eval/data-curate`.
Task: distilled `model-pref-composer-scope` (from session `1e9997f2`).
Profile: Foreman/Reviewer `pi cliproxyapi:claude-sonnet-4-6`, Builder `pi cliproxyapi:claude-opus-4-8`,
`verifyCommand: bun test`.

| Metric | Result |
|---|---|
| Run id | `1d8b89d7-0c05-4172-88ec-8cce88d61f36` |
| Outcome | **SUCCEEDED** (DONE) |
| First-verify green | ✅ (0 retries) |
| Gates | verify passed + review passed |
| Builder tools | `read` → `edit` (partial) → `bash` heredoc write → `bash "bun test"` → `submit_build` |
| Sandboxed shell | used (visible `bun test` in transcript) |

First attempt (`5b434050-…`) blocked on `Repository-local Git identity is required for checkpoint commits`
because `buildFixture` did not persist `user.name`/`user.email` into `.git/config`. Fixed in
`eval/fixtures/lib/deterministic-git.mjs` (commit SHA unchanged; identity now local).

## Unresolved

- Full-repo recorded seeds are archival until sessions start recording `verify_*` events.
- Remaining shortlist items (`94aa1f34`, `4f09a061`, …) still need distill or a real verify pin
  before graded A/B.
