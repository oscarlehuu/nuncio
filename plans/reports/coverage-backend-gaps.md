# Backend coverage gaps — unit test pass

Date: 2026-07-14  
Worktree: `0xo6`  
Gate: `cd apps/server && bun test test/unit/mcp-stdio/ test/unit/sessions/ test/unit/pi-local/ test/unit/projects/ test/unit/provider-updates/ test/unit/push/ test/unit/orchestration/ test/unit/usage/` → **693 pass / 0 fail**

## Files touched (new specs)

| Spec | Source focus |
|---|---|
| `test/unit/mcp-stdio/json-rpc.spec.ts` | `mcp-stdio/json-rpc.ts` — invalid request, notifications, initialize (default + requested protocol), tools/list, tools/call happy + missing name, method-not-found, runtime error mapping |
| `test/unit/sessions/git-session.controller.spec.ts` | `sessions/api/git-session.controller.ts` — all GET/POST routes, staged diff flags, commit stageAll toggle, push branch resolution + force, missing session / missing git dir |
| `test/unit/pi-local/pi-local.controller.spec.ts` | `pi-local/pi-local.controller.ts` — workspace required, limit parsing |
| `test/unit/projects/projects.controller.spec.ts` | `projects/projects.controller.ts` — list/get/upsert/delete + 400/404 branches |
| `test/unit/provider-updates/provider-update-command-runtime.spec.ts` | `provider-updates/provider-update-command-runtime.ts` — npm version fetch, PATH merge, env injection, command resolve, `runCommand` stdout |
| `test/unit/push/push.controller.spec.ts` | `push/push.controller.ts` — register/unregister happy + missing token |
| `test/unit/orchestration/orchestration-tools.service.spec.ts` | `orchestration/tools/orchestration-tools.service.ts` — mode off/read-write, tools preamble, enqueue + record-fact wiring |
| `test/unit/sessions/diff/session-diff.service.spec.ts` | `sessions/diff/session-diff.service.ts` — resolveTarget binding, worktree vs local, not-a-repo empty diff, truncation, comment→steer, path traversal reject |
| `test/unit/usage/usage-credentials.spec.ts` | `usage/usage-credentials.ts` — readJsonFile, decodeKeychainJson, decodeJwtExpMs, refreshOAuthAccessToken |
| `test/unit/usage/claude.fetcher.spec.ts` | `usage/fetchers/claude.fetcher.ts` — `parseClaudeUsage` windows + extra usage |
| `test/unit/usage/codex.fetcher.spec.ts` | `usage/fetchers/codex.fetcher.ts` — `parseCodexUsage` windows, spark, credits, resets |

## Files extended

| Spec | Added coverage |
|---|---|
| `test/unit/pi-local/pi-local-sessions.service.spec.ts` | blank workspace, Pi list failure, max-limit cap (50), `find` by path, `readTranscriptEvents` failure |

## Notes

- New controller/service specs use hand-rolled call spies (not `jest.fn`) so isolated `bun test` runs stay green.
- `json-rpc.spec.ts` complements existing `mcp-stdio-protocol.spec.ts` with the pure dispatch/error matrix; protocol spec still covers runtime integration.
- Session diff comment test uses a real temp dir because `validateRelativePath` calls `realpathSync`.

## Residual gaps (not in this pass)

- `claude.fetcher.ts` / `codex.fetcher.ts` `fetch()` integration paths (credential resolution + live HTTP) — only parsers + credential helpers covered here.
- `orchestration-tools.service.ts` `routingDeps` / `buildWorkspaceSnapshot` error branches — only mode gating + enqueue/record-fact happy paths.
- `provider-update-command-runtime.ts` `runCommand` timeout branch — stdout path only.

## Round 2

Date: 2026-07-14  
Gate: `cd apps/server && bun test test/unit/evidence/evidence-git-head.spec.ts test/unit/forges/forge-repo.controller.spec.ts test/unit/forges/webhooks.controller.spec.ts test/unit/forges/forges-repo.service.spec.ts test/unit/forges/forges.controller.spec.ts test/unit/forges/cli-auth.spec.ts test/unit/fs/fs.controller.spec.ts test/unit/auth/auth.controller.spec.ts test/unit/hub/hub.controller.spec.ts test/unit/cursor-local/cursor-local.controller.spec.ts test/unit/loops/loops.controller.spec.ts test/unit/provider-updates/provider-updates.controller.spec.ts` → **61 pass / 0 fail**

### Files touched (new specs)

| Spec | Source focus | Line % (isolated run) |
|---|---|---|
| `test/unit/evidence/evidence-git-head.spec.ts` | `evidence/evidence-git-head.ts` — clean HEAD, non-repo, unborn branch, missing path, invalid sha | 91% |
| `test/unit/forges/forge-repo.controller.spec.ts` | `forges/api/forge-repo.controller.ts` — all public routes + parse* validation errors | 100% |
| `test/unit/forges/webhooks.controller.spec.ts` | `forges/webhooks/webhooks.controller.ts` — bad signature, ignored event, happy path, empty raw body | 100% |
| `test/unit/fs/fs.controller.spec.ts` | `fs/fs.controller.ts` — dirs/entries/file CRUD + BadRequest rethrow vs wrap | 100% |
| `test/unit/auth/auth.controller.spec.ts` | `auth/auth.controller.ts` — login cookie, invalid token, status bearer/tailnet, token endpoint | 100% |
| `test/unit/hub/hub.controller.spec.ts` | `hub/hub.controller.ts` — hub off vs on machine discovery | 100% |
| `test/unit/cursor-local/cursor-local.controller.spec.ts` | `cursor-local/cursor-local.controller.ts` — workspace required, limit parsing | 100% |
| `test/unit/loops/loops.controller.spec.ts` | `loops/loops.controller.ts` — list/stats/get/create validation/lifecycle/runs 404s | 100% |
| `test/unit/forges/forges.controller.spec.ts` | `forges/api/forges.controller.ts` — session PR open/get/comment | 100% |
| `test/unit/provider-updates/provider-updates.controller.spec.ts` | `provider-updates/provider-updates.controller.ts` — list, pi/codex update, unknown provider | 100% |

### Files extended

| Spec | Added coverage | Line % (isolated run) |
|---|---|---|
| `test/unit/forges/forges-repo.service.spec.ts` | workflow/issue/PR delegation, empty checks on missing branch / listChecks failure | 100% |
| `test/unit/forges/cli-auth.spec.ts` | mocked `Bun.spawn` default-runner path + timeout branch | 100% |

### Notes

- Hand-rolled call spies throughout; no `jest.fn`.
- `evidence-git-head` uses real temp git dirs for happy/unborn paths; spawn mock for invalid-sha; timeout kill branch (lines 13–14) still uncovered (~91% lines).
- `cli-auth` timeout test adds ~2.5s to the round-2 gate (single spec).

### Residual gaps (round 2)

- `evidence-git-head.ts` git-spawn timeout kill callback (lines 13–14) — would need fake timers or a 3s wait.
- Controller specs cover REST delegation only; deeper service/provider integration remains in existing forge provider specs.
