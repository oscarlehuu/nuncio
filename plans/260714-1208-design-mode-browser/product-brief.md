# Product brief — Nuncio Design Mode (browser dock)

**Status:** locked for Slice 1 planning  
**Date:** 2026-07-14  
**Not:** Cursor API / embedding Cursor Design Mode  
**Is:** replicate Cursor Design Mode UX on Nuncio’s desktop browser dock

---

## Problem

UI edits are spatial. Describing “the blue button in the third card” wastes turns and confuses agents. Cursor Design Mode solves this by pointing at live UI; Nuncio should offer the same loop on its self-hosted desktop dock, then **steer the open session**.

## Goal (Slice 1)

On Desktop, in an open session with the browser dock visible:

1. Toggle Design Mode.
2. Type intent in a **small overlay chat** (always keyboard-focused).
3. **Click** components on the page (no Cmd/Shift multi-select) → chips insert **inline** at the caret (`[component 1]`, `[component 2]`, …).
4. **Send = steer the currently open session only** — never create a new session / never retarget another task.

## Non-goals (Slice 1)

- Full Chrome DevTools UI
- Voice / draw-to-annotate
- React Fiber → source-file mapping (Cursor IDE depth)
- Web / PWA / mobile Design Mode (dock is desktop-only today)
- Wiring agent `browser_*` tools to the same in-app tab (`InAppBrowserBackend`) — Slice 2
- “Send as new session” or session picker from the overlay

## Locked UX decisions

| Decision | Choice |
|---|---|
| Where you compose | Small overlay chat in Design Mode (Cursor-like), not the main transcript composer |
| Multi-component | Plain click inserts next chip inline; no modifier keys |
| Keyboard | Focus stays on overlay input; after a page click, restore focus to overlay immediately |
| Page clicks in Design Mode | Select only — do not activate links/buttons/forms of the guest app |
| Send | Always `steer(sessionId)` of the session currently open in the UI |
| No open session | Design Mode Send disabled / blocked — do not auto-create |
| Session RUNNING | Existing steer semantics (mid-run or queue) — still same session |
| Chip format in prompt text | `[component N]` tokens; agent also gets structured identity + crop image(s) |

## User stories (accepted)

1. **Toggle Design Mode** — shortcut and/or button; off restores normal browse.
2. **Overlay chat + focus lock** — opening Design Mode shows overlay and focuses it; clicks on the page do not leave the user hunting for the input.
3. **Inline chips by click** — type → click → chip at caret → type → click → …; example: `tôi muốn [component 1] nằm ở vị trí [component 2]`.
4. **Send = steer open session** — same conversation; no context fork.
5. **Safe pick** — guest navigation/submit suppressed while Design Mode is on.
6. **Edit chips** — Backspace removes a chip as a token; optional: click chip re-highlights element (nice-to-have).
7. **Transcript fidelity** — after Send, the session transcript shows the prompt with chips/images so review matches what was sent.

## Example happy path

1. User opens session S, opens browser dock, navigates to `localhost:5173`.
2. Toggles Design Mode → overlay appears, caret blinking.
3. Types `move ` → clicks header CTA → `move [component 1] ` → types `to where ` → clicks sidebar logo → `move [component 1] to where [component 2]`.
4. Presses Enter / Send → `POST /api/sessions/S/steer` with message + per-component snapshots (DOM summary + crop PNGs as image attachments).
5. Agent continues session S; user can keep Design Mode on and queue another steer, or turn it off and browse.

## Success metrics (qualitative)

- User can complete a two-component spatial prompt without leaving the keyboard after the first character.
- Zero new sessions created by Design Mode Send.
- Agent receives enough identity (selector/xpath/html/styles/bbox) + visuals to act without “which button?” clarification in the common case.
