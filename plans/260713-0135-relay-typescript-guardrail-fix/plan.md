# Relay TypeScript Guardrail Fix

## Goal

Clear the three reported server TypeScript errors without weakening the relay watchdog invariant: only a `RelayPathHealth` proven to have `status: 'down'` may reach Funnel recovery.

## Files

- Modify `apps/server/src/relay/relay-health.service.ts`
- Modify `apps/server/src/relay/relay-watchdog.service.ts`
- Retain or clarify `apps/server/test/unit/relay/relay-watchdog.service.spec.ts`
- Verification only: `apps/server/test/unit/relay/`, `apps/server/test/unit/evidence/`

## TDD / Implementation

1. Establish red/guardrail proof:
   - Run `bun run lint` from `apps/server` and retain the three reported diagnostics as the compile-time red state.
   - Run the watchdog unit spec; its existing table test already asserts both `up` and `unknown` probes never call `enableFunnel`. Rename that test only if needed to state the boundary explicitly; do not weaken its assertions.
2. Fix TS2367 in `relay-health.service.ts` by using the current `NetworkInterfaceInfo.family` string contract (`entry.family === 'IPv4'`) and removing the impossible numeric comparison (`entry.family === 4`). The existing LAN health spec already supplies the typed string form.
3. Fix both TS2345 errors in `relay-watchdog.service.ts` with a real predicate such as `isDownProbe(probe: RelayPathHealth): probe is DownProbe`. Route the non-down branch through that predicate before either `recordFailure` or `recoverDownFunnel`.
   - Keep `recoverDownFunnel(probe: DownProbe)` and `recordFailure(probe: DownProbe)` strict.
   - Keep the only `enableFunnel` call inside `recoverDownFunnel`, so `up` and `unknown` are structurally excluded from the recovery call chain after narrowing, not merely rejected by a runtime condition.
4. Verify from `apps/server`:
   - Iterate `bun run lint` until clean; this is the compile-time proof that the predicate narrows `RelayPathHealth` to `DownProbe` at both strict call sites.
   - Run `bun test test/unit/relay/ test/unit/evidence/` and require all tests green, including the `up`/`unknown` no-mutation cases.
5. Review the focused diff, stage only the relay/test files actually changed, and commit conventionally with no AI references (suggested: `fix: enforce typed relay watchdog recovery`).

## Success Criteria

- TS2367 and both TS2345 diagnostics are gone.
- Only a predicate-proven `DownProbe` can enter Funnel recovery or failure accounting.
- `up` and `unknown` probes cannot reach `enableFunnel` by type structure and remain runtime-covered.
- Server lint and the requested relay/evidence suites pass.

## Unresolved Questions

None.
