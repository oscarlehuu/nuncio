# Design lock: Session attention status

**Status:** LOCKED — 2026-07-13
**Problem:** Multi-session workbench không cho biết session nào đang chạy, đang đợi input, hay đã xong.
**Principle:** Attention, not new FSM. Reuse `StatusDot` + `SessionTile` language everywhere.

---

## 1. Attention model (canonical)

Four user-facing attention levels. Derived; **no FSM change**.

| Level | Condition | Summons eye? |
|-------|-----------|--------------|
| **Needs you** | `session.pendingInput === true` (AskQuestion / provider approval open) | Yes — strongest |
| **Working** | `status === 'RUNNING'` and not pending | Soft — gray pulse |
| **Broken** | `status === 'ERROR'` | Yes — red, no pulse |
| **Settled** | `IDLE` / `PAUSED` / `CREATED` / `ARCHIVED` | No |

Orthogonal (only inside open session / tile, not list chrome):

- Steer queued → composer / `QueuedSteersPanel` only
- Verify → existing `VerifyChip`
- Machine active (Cursor CLI) → existing footer badge

**Data source:** prefer server `Session.pendingInput` on list surfaces. Live tiles/detail may also derive from stream events; when both exist, **pending wins over Working**.

---

## 2. Visual vocabulary (locked)

Reuse existing tokens from `status-dot.tsx` + `session-tile.tsx`:

| Level | Dot | Extra |
|-------|-----|-------|
| Needs you | Amber pulse + warning glow | Copy: **Waiting for you** |
| Working | Muted gray pulse | No amber, no border summons on list |
| Broken | `bg-destructive` | No pulse |
| Settled | **No dot** | Quiet on purpose |

**Copy (English, UI):**

| Context | String |
|---------|--------|
| Pending subtitle / pill | `Waiting for you` |
| Working pill | `Running` |
| Settled pill | `Idle` / `Paused` / `Created` via `statusLabel()` |
| Error pill | `Error` |
| Strip counts | `{n} running` · `{n} needs you` · `{n} idle` (omit zero buckets) |

Do **not** invent alternate copy (`Needs input`, `Blocked`, `Awaiting…`) on these surfaces.

---

## 3. Surfaces

### 3.1 Sidebar row (must)

`RecentRow` today: dot only for RUNNING/ERROR; never passes `pending`.

**Locked behavior:**

1. Show `StatusDot` when `pendingInput || RUNNING || ERROR`.
2. Pass `pending={!!session.pendingInput}`.
3. Subtitle when pending: amber **Waiting for you** (replaces preview for that row).
4. Else keep: `ProviderIcon` + `preview ?? statusLabel(status)`.
5. No row border glow in sidebar (tiles keep glow; list stays calm).

**Group-by-status (when that mode is on):**

- Add lane **Needs you** above Running.
- A pending RUNNING session appears **only** in Needs you (not also under Running).
- Lane order: Needs you → Running → Error → Paused → Idle → Created.

### 3.2 Attach / slot picker (must)

Same rule as sidebar: `StatusDot` + `pending` + subtitle override. Shared helper preferred (`sessionAttention(session)` → `{ level, label }`).

### 3.3 Grid tile (keep; source of truth)

No redesign. Already correct: amber glow + “Waiting for you” + pending StatusDot. Ensure list `pendingInput` and stream-derived pending stay consistent (pending wins).

### 3.4 Session detail header (must)

Today: title + VerifyChip + lineage; **no status chrome**.

**Locked:** compact status pill immediately right of title (before VerifyChip):

| Level | Pill |
|-------|------|
| Needs you | Warning / amber outline or soft fill — `Waiting for you` |
| Working | Muted — `Running` |
| Broken | Destructive — `Error` |
| Settled | Muted outline — `statusLabel(status)` |

Rules:

- One pill only; never stack Running + Waiting.
- Do not move Stop / Respond into the pill — actions stay where they are.
- Banner + composer pending UX stay; pill is at-a-glance only.
- Size: small Badge / chip, ~same height as VerifyChip; does not dominate title.

### 3.5 Workbench attention strip (should)

One quiet line above the grid (or home when sessions exist), **only if** `running + needsYou > 0`:

```
2 running · 1 needs you
```

- Idle count optional; omit if strip would be long — prefer only summoning buckets.
- Click **needs you** → select/focus first (or cycle) pending session in workbench/sidebar.
- Click **running** → optional; nice-to-have, not required for v1.
- No cards, no icon row, no dashboard stats.

Hide strip when everything is settled.

### 3.6 Notifications (should)

`use-session-notifications` already has `needs-input` kind unused.

**Locked:** fire when `pendingInput` goes false → true on a session that is **not** the focused/active session.

| Kind | Trigger | Body tone |
|------|---------|-----------|
| `needs-input` | pending rises | Title = session title; body = `Waiting for you` |
| `finished` | RUNNING → IDLE (existing) | unchanged |
| `error` | → ERROR (existing) | unchanged |

Do not notify on every poll while still pending (edge only).

---

## 4. Shared helper (implementation contract)

Introduce one pure helper (core or web lib):

```ts
type SessionAttention = 'needs-you' | 'working' | 'broken' | 'settled';

function sessionAttention(session: {
  status: SessionStatus;
  pendingInput?: boolean;
}): SessionAttention
```

- `pendingInput` → `needs-you` (even if status is RUNNING)
- else ERROR → `broken`
- else RUNNING → `working`
- else → `settled`

UI maps attention → StatusDot props + label. **Single source** for sidebar, picker, header pill, strip counts.

---

## 5. Explicit non-goals

- No new FSM state (`AWAITING_INPUT`, etc.)
- No IDLE status dots
- No persistent left icon rail
- No per-status color borders on sidebar rows
- No mobile redesign in v1 (same API fields; mobile can follow later)
- No Crew harness status redesign (Crew has its own phase UI)
- Steer-queued / verify / machine-active stay off list chrome

---

## 6. Ship order

| Phase | Scope | Done when |
|-------|--------|-----------|
| **A** | `sessionAttention` + sidebar + attach picker + status group lane | Multi-session list answers “needs me / working / done” without opening |
| **B** | Session header status pill | Opening a session shows level in chrome immediately |
| **C** | Attention strip + needs-input notify | Fleet glance + background interrupt |

A alone is the minimum viable fix. B+C complete the design.

---

## 7. Docs / product surfaces

When implementing, update in the same PR:

- `docs/product-surfaces.md` — sidebar row, session header pill, workbench strip
- Changeset: user-facing (`patch` unless strip is framed as new workflow — default **patch**)

---

## 8. Acceptance (manual)

1. Two RUNNING sessions, one with AskQuestion open → sidebar: one amber “Waiting for you”, one gray pulse.
2. Open the pending session → header pill says Waiting for you; banner still works.
3. Answer input → amber clears; session Working or Settled correctly.
4. All idle → no attention strip; sidebar quiet (no dots).
5. Background session gains pending while another is focused → desktop notify once.

---

## Unresolved

- None for v1 lock. Mobile parity deferred. Strip click-to-cycle vs open-first: **open/focus first pending** for v1.
