# Phase 03 orchestration

**Base:** `cursor/phase-02-combined-5323`

| Lane | Branch | Ownership |
|------|--------|-----------|
| A Backend | `cursor/phase-03-backend-5323` | `apps/server/src/**` except `*.spec.ts` |
| B Frontend | `cursor/phase-03-frontend-5323` | `apps/web/src/**` |
| C Tests | `cursor/phase-03-tests-5323` | `apps/server/src/**/*.spec.ts`, `apps/server/test/**` |

**Merge:** A → C → B → verify

**Backend note for founder:** steer requires in-memory Pi session registry per nuncio session id.
