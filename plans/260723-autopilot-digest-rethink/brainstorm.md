# Autopilot + Digest rethink — brainstorm (2026-07-23)

Trigger: Oscar's screenshot of the Home attention queue. His read as a non-dev user:
"I don't understand what these cards mean, I don't know what to do, and the button
layout (Dismiss/Open vs Approve/Dismiss) is inconsistent and annoying."

## 1. Diagnosis (grounded in code)

### 1.1 Too many overlapping concepts for one job

The user's job is one question: **"what did the machine do, and what do I need to do?"**
Today that is spread across five named surfaces plus internal vocabulary:

- **Home** = DigestCard + AttentionQueue (`home-surface.tsx:65-66`)
- **Digest** = separate route with stat grids (`digest-view.tsx`)
- **Autopilot** = loops fleet (`autopilot-view.tsx`)
- **Timeline** = drill-down feed
- Vocabulary leaking into UI copy: *dispatcher, heartbeat, loop, breaker, verify,
  missed fires, pre-flight, project lines, raised/resolved*.

Navigation is circular: Home → DigestCard → Digest view → buttons back to
Inbox/Autopilot/Timeline (`digest-view.tsx:120-150`). A newcomer never learns which
surface is "the" one.

### 1.2 Cards don't answer the three user questions

A card must answer: **(a) what happened, (b) why should I care, (c) what exactly
happens if I press this button.** Current copy is dev-log speak:

- `Schedule "every:15m" missed fires while offline (~24h overdue)` — raised at
  `heartbeat.service.ts:143`. No user action except Dismiss; nothing says what the
  schedule was for or what pressing Dismiss does.
- `Dispatcher proposal · Tomorrow's plan - 2 proposals` — "dispatcher" is an internal
  component name. Approve gives no preview of consequence (it queues N tasks —
  the payload knows this, the card doesn't say it).
- `Verify failed after auto-fix rounds` (`attention-collectors.ts:104`) — dev phrasing.
- `Loop "…" tripped its breaker` (`attention-collectors.ts:134`) — circuit-breaker
  metaphor is internal.
- PR review cards show the raw PR title only; nothing says "an agent opened this PR
  and it's waiting for your review".

### 1.3 Duplicates and staleness destroy trust (two verified root causes)

- **PR duplicates**: dedup key is `${project.path}#${pr.number}`
  (`attention-collectors.ts:167`). Two recent-project *paths* that point at the same
  GitHub repo (main checkout + a worktree/second path, both basename "nuncio") each
  raise their own item for the same PR → every PR appears twice with identical labels.
  Fix direction: key by **forge repo identity** (owner/repo#number), not local path.
- **Stale dispatcher proposals**: subject is date-keyed (`dispatcher.service.ts:71`),
  and yesterday's un-acted proposal is never superseded → "Tomorrow's plan" appears
  twice (1d ago + 14h ago). Which one is tomorrow's? Fix direction: raising a new
  proposal auto-resolves any open older one; also auto-expire past-dated plans.
- **Missed-schedule** items linger (5d ago in the screenshot) with no auto-expiry and
  no useful action.

### 1.4 No fixed action grammar

`attention-row.tsx:81-127` renders, in JSX order: Approve → Dismiss → Open → Create.
So the primary lands *left* of Dismiss for dispatcher rows and *right* of Dismiss for
PR/spawn rows; missed-schedule has Dismiss alone. Same word "Dismiss" also means
different things per kind (resolve item vs dismiss chip) with no visual distinction.

## 2. Design principles for the redo

1. **One inbox, one question.** The queue exists to empty itself ("Nothing needs you"
   is the product goal — keep that). Everything else is drill-down, not a peer surface.
2. **Every card is a sentence a non-dev understands** + one consequence line.
   Template: *[Who/what] [did/needs X] — [what pressing the primary will do].*
3. **Fixed action grammar**: primary verb always the outermost right, filled; Dismiss
   always the same slot (ghost, immediately left of primary); card body itself opens
   the subject. Verb varies per kind (Review / Approve / Answer / Create / Run now);
   position never does. (Matches the existing DialogFooter convention: cancel left,
   action right.)
4. **Identity-true dedup + supersede**: one real-world subject = one card, newest
   proposal replaces older, cleared conditions expire themselves.
5. **User vocabulary only**: no dispatcher/breaker/heartbeat/verify in UI strings.

## 3. Proposed shape

### 3.1 Conceptual model: two places, not five

- **Home ("Today")** — one screen: a 1-2 sentence narrative header (absorbs the
  digest) + the ranked needs-you queue. E.g. *"Overnight: 6 runs, 5 green, 2 PRs
  opened. 3 things need you."*
- **Autopilot** — the machine's own story: what will run (incl. tomorrow's plan from
  the dispatcher), what is running, what ran (run history; digest archive lives here).
  A dispatcher proposal is really *Autopilot's plan for tomorrow* — its detail belongs
  here; the inbox keeps only the one-line "Approve tomorrow's plan (2 tasks)" card.
- Timeline stays as drill-down. The Digest route dissolves into Home header +
  the existing push notification (push already implemented, `digest.ts:71`).

### 3.2 Card anatomy (all kinds)

```
[accent] [kind chip] [title in plain language]
         [consequence/context subline]
         [project · age]                    [Dismiss] [Primary →]
```

Per-kind rewrite:

| kind | title (user language) | subline | primary |
|---|---|---|---|
| pr-review | "PR ready for your review: <title>" | "Opened by autopilot · nuncio #157" | Review |
| dispatcher-proposal | "Tomorrow's plan: 2 tasks" | "Approve to queue them for tonight (budget 2/10)" | Approve |
| permission | "<session> is waiting on your answer" | first line of the question | Answer |
| verify-dead | "Tests still red after 3 auto-fix tries" | "Needs a human decision" | Open |
| tripped-breaker | "Autopilot paused <loop> after repeated failures" | "Resume when you've had a look" | Open |
| missed-schedule | "A schedule fell behind while your Mac was offline" | "<schedule name> · ~24h overdue" | Run now (or auto-expire) |
| spawn-task | "Suggested follow-up: <title>" | tldr (exists) | Create |

Grouping: N same-kind cards collapse into one group card ("4 PRs waiting for review")
expandable in place — the dispatcher row already has this expand pattern to reuse.

### 3.3 Digest → narrative, not telemetry

The stat grids (Raised/Resolved/Open, Succeeded/Failed, Project lines) are founder
telemetry, not a briefing. Replace with 2-4 generated sentences + the top 3 highlight
links; keep the numbers behind a "details" disclosure or move them to Autopilot's
dashboard header (which already shows fleet stats).

## 4. Phasing

- **P0 (fix trust + the annoyance, small diffs)**
  1. Action order: move Approve after Dismiss in `attention-row.tsx` — primary always
     right-most for every kind.
  2. PR dedup by forge repo identity, not project path.
  3. New dispatcher proposal supersedes the previous open one; past-dated plans expire.
  4. Missed-schedule auto-expires once the schedule fires again.
  5. Copy pass: per-kind plain-language titles + consequence sublines (table above);
     Approve toast already says "N tasks queued" — put it on the card *before* the tap.
- **P1 (structure)**
  6. Digest route dissolves into Home narrative header; DigestCard removed.
  7. Same-kind grouping in the queue.
  8. Dispatcher proposal detail view inside Autopilot ("Planned for tonight").
- **P2 (concept/IA)**
  9. Sidebar = Home, Autopilot (+ sessions). Timeline reachable from Home header.
  10. Vocabulary sweep: loop→"standing task"? breaker→"paused", verify→"checks".

## 5. Decisions (Oscar, 2026-07-23)

1. **Delete the /digest route.** Home narrative header absorbs it; no archive view.
2. **Dismiss keeps ONE meaning everywhere**: hide from the inbox, do nothing else.
   Same label, same slot, all kinds.
3. **Missed-schedule stays as-is.** No "Run now", no auto-expiry, no copy change.
4. **Group same-kind cards** (≥2 of the same kind collapse into one expandable group).

Execution model (Oscar): Codex gpt-5.6-sol implements (`high` effort, Fast/priority
tier) and reviews (`xhigh` effort, Fast tier); Claude orchestrates only.
Scope note: P2 items (sidebar IA, vocabulary sweep) and "dispatcher detail inside
Autopilot" are NOT in this round — not yet decided.
