/**
 * Canned prompt for the home-composer "Generate AGENTS.md" quick action (P3 of
 * the codebase-context study). AGENTS.md is the one context mechanism every
 * engine discovers natively (Pi, Codex, Claude, Cursor), so a good one is the
 * highest-leverage per-repo investment — this prompt is Nuncio's `/init`.
 * It pre-fills the composer (user can edit before sending); it is not sent
 * automatically.
 */
export const AGENTS_MD_GENERATION_PROMPT = `Analyze this repository and create (or update) an AGENTS.md file at the repo root — the operating manual an AI coding agent needs to work here effectively.

Ground rules:
- If AGENTS.md already exists, improve it in place; keep anything you cannot verify is stale.
- Verify every command you document by actually running it (install, build, test, lint). Document only what works.
- Keep it under ~150 lines. Concise bullets over prose. No filler.

Cover:
1. What the project is (one short paragraph) and the tech stack.
2. Setup and everyday commands: install, build, run, test (full suite + a single test), lint/format.
3. Layout: the directories that matter and what lives in each.
4. Conventions inferred from the existing code — style, naming, commit style, where tests live. Do not invent rules the codebase doesn't follow.
5. Gotchas and non-obvious constraints: required env vars, ports, generated files, directories an agent must never touch.

Finish by re-reading the file for accuracy; when unsure about a claim, drop it rather than guess.`;
