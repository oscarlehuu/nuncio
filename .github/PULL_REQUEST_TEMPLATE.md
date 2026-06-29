<!--
Thanks for opening a PR! Fill in the sections below. Keep it concise.
Read CONTRIBUTING.md and AGENTS.md for the full workflow.
-->

## Summary

<!-- What does this PR change, and why? One or two paragraphs. -->

## Changes

- <!-- bullet list of meaningful changes (not file-by-file) -->

## Type

- [ ] feat — new user-facing capability
- [ ] fix — bug fix
- [ ] refactor — no behavior change
- [ ] docs — documentation only
- [ ] test — test-only
- [ ] chore — tooling, deps, CI

## Checklist

- [ ] **TDD-first** — wrote a failing test, then implemented the minimum to pass it (see [CONTRIBUTING.md](../CONTRIBUTING.md#working-practice-tdd-first))
- [ ] **Suite is green** — `bun run lint && bun run test && bun run --filter @nuncio/web test && bun run build` all pass locally
- [ ] **Changeset added** for user-facing changes — `bun run add-changeset patch|minor "…"` (see AGENTS.md → Versioning rubric; skip for pure refactor/test/docs/chore — add `<!-- no-changeset -->` to PR body if src touched)
- [ ] **Docs synced** — `README.md` (commands, API, architecture, status) and `AGENTS.md` (if architecture/conventions shifted) match the shipped code
- [ ] **No secrets committed** — no API keys, tokens, or `.env` files in the diff
- [ ] **No new vulnerabilities introduced** — dependency bumps are vetted, no `latest`/floating ranges

## Test plan

<!-- How did you verify this works? Be specific:
- Unit tests added/updated (which spec files?)
- Manual reproduction steps (what did you click/run, what did you see?)
- For UI changes: tested against mockup.html and light/dark toggle?
-->

## Related issues / PRs

<!-- "Closes #123", "Refs #456", or "N/A". -->

## Screenshots / recordings

<!-- For UI changes only. Redact any sensitive data. -->
