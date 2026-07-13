# Missions R2 + E3 — Relay watchdog and simulator evidence

## Context

- Branch: `feat/relay-watchdog-sim-capture` from `dev` (`553b3a31`).
- Preserve ADR-007: relay health is operational metadata, not a Session event/FSM change.
- TDD red → green → refactor. Keep R2 and E3 in separate conventional commits.

## Phase 1 — R2 relay health/watchdog

1. **Red: probe/guard tests.** Add `apps/server/test/unit/relay/relay-watchdog.service.spec.ts` covering discriminated `up | down | unknown` probes. Assert `enableFunnel()` is called only after an explicit `down`; `up` and `unknown` never invoke any mutation. Assert a failed restart/re-probe raises one deduped `relay-down` Attention item and recovery clears it.
2. **Red: API contract.** Add `apps/server/test/unit/relay/relay.controller.spec.ts` for `GET /api/relay/health` returning exactly `{lan,tailnet,funnel}`, each `{status,latencyMs,probedAt,reason?}`; unprobed/indeterminate paths use `unknown`, null latency/time as applicable.
3. **Green: typed probing.** Create `apps/server/src/relay/relay.types.ts` and focused probe service(s). LAN probes loopback health, tailnet derives local Tailscale connectivity, and Funnel uses CLI Funnel status because same-host HTTP cannot prove the public route. Record monotonic elapsed latency; command/fetch ambiguity is `unknown`, never `down`.
4. **Green: structurally one-way watchdog.** Create `relay-watchdog.service.ts` with a cadence/lifecycle seam and a small recovery function whose first branch is `if (probe.status !== 'down') return`. Its only mutation dependency is `TailscaleService.enableFunnel(port)`; include no disable/reset/serve-down command. After restart, re-probe: recovered clears `relay-down`; still explicitly down or failed enable raises Attention with subject `funnel` and diagnostic payload.
5. **Green: surface/wiring.** Create `relay.controller.ts` and `relay.module.ts`; `RelayModule` imports `TailscaleModule` + `AttentionModule`, owns cached last-probe state, and is imported once by `app.module.ts`. Extend `attention.types.ts`/ranking tests with `relay-down` at an appropriate infrastructure severity.
6. **Refactor/docs.** Keep files below 200 lines where practical. Update `README.md` and `docs/system-architecture.md` with endpoint shape, cadence, probe meanings, and the observe-and-restart-only invariant.
7. **Commit R2:** stage only R2 tests/source/docs; commit `feat: add relay health watchdog`.

## Phase 2 — E3 simulator evidence target

1. **Red: capability/capture tests.** Extend `apps/server/test/unit/evidence/evidence-capture.service.spec.ts` or add `simulator-evidence-capture.spec.ts`. Inject/mock exec and filesystem seams. Assert non-macOS and absent `xcrun` report a stable clear reason and perform no capture/event; never run real `xcrun` in tests.
2. **Red: parity.** Assert a successful mocked `xcrun simctl io booted screenshot <temp.png>` stores bytes through the existing `MediaStore` and returns the same `EvidenceCapturedPayload` fields/ref shape accepted by `isEvidenceCapturedEvent`.
3. **Green: discriminated target.** Extend `evidence.types.ts` to browser (default, URL/route) vs `simulator` input without weakening existing origin checks. Route simulator work from `EvidenceCaptureService` through a focused `simulator-evidence-capture.service.ts`; retain pre/post Git HEAD equality and serialized capture behavior.
4. **Green: capability + execution.** Add injected exec/platform seams. Capability requires macOS and resolvable `xcrun`; unavailable capture is a no-op with the capability reason and appends no event. Successful capture uses an isolated temp file, always cleans it, parses PNG dimensions for `viewport`, uses a stable simulator route, and writes only the opaque media ref.
5. **API/event integration.** Update `sessions.controller.ts` validation so simulator input does not require `url`; append `evidence_captured` only for successful capture. Preserve browser/task automatic capture behavior.
6. **Document seam.** Update `README.md`/architecture docs: simulator screenshot capability, macOS/xcrun gate, and a future `recordVideo` driver seam. Explicitly state Maestro installation/verify wiring is out of scope.
7. **Release + commit E3.** Add one minor changeset covering both new capabilities, then commit E3 source/tests/docs/changeset as `feat: add simulator evidence capture`.

## Verification and delivery

1. Run focused R2/E3 specs during each red/green loop; prove red failures are assertion failures.
2. From `apps/server`: `bun run lint`, then `bun test test/unit/`. Do not suppress failures; record exact sandbox `EPERM` socket failures separately from product failures.
3. From repo root: `bun run check-changeset`, inspect `git diff --check`, and run a code-review pass before commits/push.
4. Push `feat/relay-watchdog-sim-capture`; if blocked, preserve both local commits and report the exact error.

## Success criteria

- A healthy or unknown Funnel can never enter a mutating code path; only explicit down can attempt enable, and no teardown primitive exists.
- Health API exposes truthful last status/latency for all three paths; persistent Funnel failure is durable/deduped Attention.
- Simulator and browser successes share MediaStore + `evidence_captured`; unsupported hosts clearly no-op; no Maestro dependency exists.

## Unresolved questions

- None; use `PORT ?? 3000`, deterministic `relay-down` subject `funnel`, and conservative `unknown` whenever a probe cannot prove state.
