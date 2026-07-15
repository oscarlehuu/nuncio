# External Agent Memories

Status: complete

## Goal

Give Nuncio Engine sessions a bounded read-only index of project-relevant Claude Code and Codex CLI memories plus a session-bound tool for full reads.

## Phases

1. [complete] Add failing source, budget, tool-security, settings, and provider integration specs.
2. [complete] Implement fail-soft filesystem adapters and pure byte-bounded rendering.
3. [complete] Add the read tool, settings metadata, DI, and Pi provider wiring.
4. [complete] Run focused tests, full server unit suite, lint/build, and independent review.
5. [complete] Sync user-facing docs and changeset metadata.

## Constraints

- External stores remain read-only; Nuncio never creates or edits memory files.
- Source access is scoped to the session project and configured mode.
- Engine-specific behavior stays inside the Pi provider seam.
- Prompt and tool outputs respect UTF-8 byte caps and fail soft on missing source data.
