# Reviewer report — Pi first-class provider

- Date: 2026-07-17 AEST
- Branch: `perf/pi-first-class-provider`
- HEAD: `cbffbf722a9f0c93b0d8b1e1e7cdc683e32cc3ce`
- Scope: independent read-only review of tracked and untracked Pi provider/performance changes
- Source/test edits: none

## Outcome

CHANGES REQUESTED. The production Pi lifecycle and external-memory changes are coherent, and the
reported `bun run gate` result is strong. Two P2 defects remain in real-provider timeout paths: the
performance deadline can accept an aborted sample as successful evidence, and the integration
interrupt test does not await its paid run on the new live-event timeout path.

## Findings

### [P2] Reject a timed-out performance sample before awaiting abort cleanup

**Evidence:** `scripts/pi-provider-perf-harness.mjs:133-145`, call sites at `:268` and `:306`, and
sample acceptance at `:269-272` / `:307-314`.

The timeout callback awaits `onTimeout()` before rejecting. If aborting settles the measured
promise, that promise can win `Promise.race` while the timeout callback is suspended. This is not
hypothetical control flow: a non-billable deferred-promise probe where `onTimeout` resolves the
measured promise returned `RESOLVED aborted-success`. Pi's current `abort()` is specifically an
abort-and-wait-for-idle operation, so this is the normal cleanup shape. If at least one text delta
arrived before timeout, `validateSample` then accepts the truncated/aborted run and `--write` may
publish it as completion evidence. If abort itself hangs, the advertised deadline also never
rejects.

**Fix:** make timeout selection irreversible before starting cleanup. After selecting timeout,
interrupt/abort, await the original run under a separate bounded cleanup deadline, then dispose and
remove the session file. Add a non-network unit test where abort settles the measured promise and
assert the deadline still rejects. Do not remove the billable opt-in gate.

### [P2] Await the integration run when first-live-event detection times out

**Evidence:** `apps/server/test/integration/pi-agent.integration.spec.ts:326-350` and
`apps/server/src/agents/providers/pi-agent.provider.ts:199-207`.

`runPromise` is scoped inside the `try`. If `liveEvent.promise` rejects at 30 seconds, control jumps
to `finally`, which can only call synchronous `provider.dispose()`. That method starts
`session.abort()` fire-and-forget and immediately detaches the handle; the test never awaits the paid
run's settlement before continuing to later tests or suite teardown. This creates avoidable overlap
with module close, settings restoration, and generated-session cleanup precisely on the failure path
the new event-driven test is meant to make deterministic.

**Fix:** retain `runPromise` outside the `try`; in `finally`, if it has not settled, await
`provider.interrupt(created.id)` and then await `runPromise` under a bounded cleanup deadline before
calling `dispose`. Keep the existing contained JSONL deletion after settlement.

## Verified behavior

- **External-memory cache:** only a successful repository-root probe is cached
  (`external-memory-sources.ts:195-207`); Claude/Codex indexes and files are still read on each load
  (`:210-245`). The new test proves cross-store reuse and fresh Claude index reads
  (`pi-engine.external-memory-sources.spec.ts:28-79`).
- **Tool-only completion:** a non-error, non-aborted assistant terminal increments the completion
  count even with no text (`pi-agent.provider.ts:763-793`), and the fallback now requires both no
  emitted text message and no observed completion (`:399-409`). The regression test pins no fake
  assistant row and IDLE settlement (`pi-agent.provider.spec.ts:1150-1179`).
- **Thinking/tool ordering and sealing:** thinking is sealed before a tool starts and before an
  assistant terminal; open activity is cleared idempotently on `agent_end` and prompt finalization
  (`pi-agent.provider.ts:664-685`, `:717-798`, `:388-392`). Interrupted thinking and tools are covered
  at `pi-agent.provider.spec.ts:725-810`.
- **Turn callback fence:** callbacks are ignored outside the active prompt and the emitter is cleared
  in `finally` (`pi-agent.provider.ts:687-688`, `:806-813`). Keeping the handle for resume is valid
  under Pi 0.80.6's current contract: agent listeners are awaited through `agent_end`, and Pi abort
  waits for idle. No production defect found here.
- **Interrupt flag:** the flag is installed before awaiting abort and consumed in prompt `finally`
  (`pi-agent.provider.ts:310-324`, `:378-393`), preserving clean IDLE cancellation while the handle
  remains resumable.
- **Docs/release:** README, Pi Engine, system architecture, testing guide, package command, checked-in
  report-only baseline, and patch changeset match the implemented cache and tool-only behavior. The
  baseline correctly avoids a speed claim and records its explicit Sonnet override.
- **Verification evidence:** tester report records `git diff --check`, changeset validation, the
  non-billable opt-in skip, and `bun run gate` passing 4,787 tests with 0 failures. The separate real
  Pi result (8 pass, environment/provider skips) was not rerun during this review.

## Residual non-blocking risks

- The failed Git-probe branch is visibly uncached in source, but the new cache spec does not directly
  prove that a failed probe is retried after a directory becomes a repository.
- The performance baseline has high variance and one runner/model sample; it remains evidence only.
  Its rendered markdown also omits the prompt and timeout, so future custom-prompt baselines should
  record those fields before cross-run comparison.
- The integration fallback may try several real credentials and includes Sonnet/Opus candidates after
  Haiku. This is explicit in the plan; callers should use `NUNCIO_PI_INTEGRATION_MODEL` when cost or
  quota requires a different authenticated model.

## Unresolved questions

None.

**Status:** DONE_WITH_CONCERNS
**Summary:** Production Pi/cache behavior reviewed clean; two P2 timeout/settlement defects remain in paid evidence paths.
**Concerns/Blockers:** Fix both timeout cleanup paths before PR; no production adapter blocker found.

## Post-fix verification

Both prior P2 findings are resolved. No new blocker found in the focused re-review.

- **Performance deadline:** timeout selection is now represented as an explicit outcome before
  cleanup begins (`scripts/pi-provider-perf-harness.mjs:135-174`). Once selected, abort or measured
  run settlement cannot turn the sample into success. Cleanup awaits abort plus the measured run,
  but a separate cleanup timer bounds that wait if either hangs. The deterministic regressions pin
  both cases (`scripts/pi-provider-perf-harness.spec.mjs:5-27`).
- **Real-provider integration teardown:** the interrupt integration retains `runPromise` across its
  `try/finally`, invokes bounded settlement before `dispose`, and disposes only after settlement or
  a clear cleanup timeout (`apps/server/test/integration/pi-agent.integration.spec.ts:328-366`). The
  helper awaits interrupt acknowledgement and run settlement under one deadline
  (`apps/server/test/helpers/real-provider-run-cleanup.ts:1-25`); unit coverage proves normal
  settlement, a hung run, and a hung interrupt (`apps/server/test/unit/agents/real-provider-run-cleanup.spec.ts:5-43`).
- **Verification:** focused non-billable tests passed 5/5 during this review. The refreshed tester
  evidence records `git diff --check`, changeset and opt-in checks, plus `bun run gate` passing
  4,793 tests with 0 failures. The paid real-Pi path was intentionally not rerun.
- The performance report now records prompt and timeout (`scripts/pi-provider-perf-harness.mjs:83-91`),
  closing the earlier comparison-metadata residual risk.

## Post-fix unresolved questions

None.

**Status:** DONE
**Summary:** Both P2 timeout/settlement defects are fixed and covered by deterministic non-billable tests.
**Concerns/Blockers:** None; paid real-Pi execution remains intentionally outside this re-review.
