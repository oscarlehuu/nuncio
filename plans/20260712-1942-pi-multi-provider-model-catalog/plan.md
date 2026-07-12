# Pi multi-provider model catalog

## Goal

Surface every authenticated Pi `ModelRegistry` provider as a stable picker group, while deriving
model-specific thinking and image capabilities from registry metadata. Nuncio remains CLI-first:
it reads Pi auth state and never manages provider keys.

## Constraints

- Work only in `/tmp/nuncio-n1` on `feat/pi-multi-provider`.
- No new provider adapters, settings keys, auth prompts, or picker redesign.
- Follow TDD: multi-provider registry fixtures fail before implementation.
- Preserve a stable empty response when Pi has no available models or the SDK fails.

## Phases

1. **Scout — complete**
   - Confirmed `ModelRegistry.getAvailable()` already filters to configured providers.
   - Confirmed registry display names and thinking metadata are already consumed.
   - Found unstable registry-order output and provider-wide image gating.
2. **Red tests — complete (execution blocked by missing dependencies)**
   - Add xAI + Google + Anthropic fixtures with display names, image input, reasoning maps,
     unconfigured-provider absence, and deterministic ordering assertions.
   - Add core catalog coverage only if model-level capability lookup changes shared logic.
3. **Implementation — complete**
   - Normalize registry metadata into deterministic provider groups/models.
   - Surface model-level image support without changing auth ownership.
   - Use selected-model image capability in shared composer/session gates.
4. **Docs and release note — complete**
   - Clarify Pi CLI `/login`, `auth.json`, multi-provider discovery, and no Nuncio key management.
   - Add a patch changeset.
5. **Verification and review — complete with environment constraints**
   - Requested commands attempted: dependency-backed checks are blocked because `bun install`
     cannot fetch packages; listener specs independently hit sandbox `EPERM`.
   - Bun transpilation and `git diff --check` pass; changeset check passes.
   - Review diff, fix blockers, commit conventionally, and attempt push.

## Success criteria

- Configured xAI, Google, and arbitrary Pi providers appear under correct display names.
- Unconfigured providers do not appear and empty/error fallback remains stable.
- Thinking options honor `reasoning` plus `thinkingLevelMap`; image upload follows registry `input`.
- Output ordering is deterministic independent of registry order.
- Requested checks pass, or environmental blockers are reported verbatim.

## Dependencies and risks

- Pi SDK metadata contract: `input` is `['text']` or `['text', 'image']`.
- `bun install` currently cannot fetch Electron packages because outbound network is blocked.
- Model-specific image gating must remain provider-neutral at shared boundaries.

## Unresolved questions

None.
