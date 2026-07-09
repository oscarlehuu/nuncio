# Nuncio B&W redesign — design notes

Prototype: `prototype.html` (self-contained, open in any browser or via the published artifact).
This file records the rules the prototype embodies, so production work can apply them 1:1.

## Principles

1. **Monochrome by default.** Luminance builds hierarchy (sidebar < content < card),
   hairline borders firm up edges. No hue in the chrome.
2. **Color is a summons.** Amber = waiting on the founder (pending input, warnings,
   failed-run counts). Red = broken (error status, destructive actions, tripped breakers).
   Nothing else is colored — running is a *gray* pulse, success is plain text with a check.
   Exception: diff +/− keeps green/red (universal convention; `diffMarkers` pref already
   offers a mono fallback).
3. **No glass.** Sticky headers are solid `--background`. Floating layers (menus, dialogs,
   toasts) are solid `--popover` + shadow + hairline rim — zero `backdrop-filter`, no aurora.
4. **No redundancy.** One mechanism per job: one back affordance per page, one create-agent
   entry (the Home composer; grid slots create only into their own slot), one primary
   button per row.

## Token mapping (prototype → production `index.css`)

| Prototype var | Dark | Light | Maps to |
|---|---|---|---|
| `--bg` | `#0a0a0a` | `#ffffff` | `--background` |
| `--side` | `#050505` | `#fafafa` | `--sidebar` |
| `--card` | `#111214` | `#ffffff` | `--card` / `--popover` |
| `--well` | `#101113` | `#f7f7f7` | `--muted` |
| `--hair` | `white 8.5%` | `black 9%` | `--border` |
| `--fg` | `#ededed` | `#171717` | `--foreground` |
| `--mut` | `#8f8f8f` | `#6f6f6f` | `--muted-foreground` |
| `--pri` | `#ededed` | `#171717` | `--primary` (white↔black button) |
| `--amber` | `#f5a623` | `#b3730d` | `--status-warning` (light darkened for AA) |
| `--red` | `#ef5f66` | `#ca2a30` | `--destructive` / `--status-error` |

## Production checklist (agreed with Oscar 2026-07-09)

> STATUS 2026-07-09: ALL SIX ITEMS IMPLEMENTED on branch `bw-redesign`
> (worktree `.claude/worktrees/wf_2f63c229-b7f-1`, 7 commits, not pushed).
> Verified: 818 web + 300 core + 43 mobile tests pass, web build clean;
> codex xhigh diff review found one low finding (terminal fallback chroma), fixed in 94bd168f.
> Out-of-scope color stragglers awaiting a call: lineageStatusDot (session-detail),
> info/success-hued chips in loop/forge views.

- [x] Delete the accent presets (iris/cobalt/ember/jade/custom) — CSS blocks, accent-provider
      custom-hex path, settings row. Base achromatic tokens become the only theme;
      zero the residual blue chroma (0.002–0.014) in base neutrals.
- [ ] Remove `.app-aurora`, `--app-aurora`, `surface-glass*` + all ad-hoc
      `bg-*/80 backdrop-blur` (7 sites); floating layers get solid `bg-popover shadow-e2/e3`.
- [ ] Merge `/new` into `/` — composer on top, attention queue + digest below;
      remove the New agent header button (⌘N focuses the Home composer instead).
- [ ] Status discipline: `tool-glyph.tsx` tones → `text-muted-foreground`;
      `status-dot.tsx` RUNNING → gray pulse, IDLE → no dot; tile glow amber-only
      (running breath → neutral); success chips → plain.
- [ ] Attention rows: two actions max (primary + Dismiss); drop the separate "Seen" button.
- [ ] Keep: hover-rail sidebar mechanism (Oscar's call), diff green/red, elevation ladder.

## Model picker at scale (10+ models per engine)

One popover, three mechanisms — no submenu nesting:

1. **Search first.** Input pinned at the top, autofocused; typing flattens all engines
   into one filtered list. With 10+ models, search is the primary path, browsing the fallback.
2. **Curated collapse.** An engine with many models shows its 3 featured ones plus one
   `All N <engine> models` expander row. Small engines (≤3) just list everything — no expander.
3. **Recent on top.** The last 3 used models sit in a Recent section; a check marks the
   active one. Selecting updates the trigger label directly (no confirmation toast — the
   label change is the feedback).

List is capped at ~300px and scrolls inside the popover; cost/tier tags sit right-aligned
in the muted column. Production mapping: `model-picker.tsx` already has the flat list +
sticky search header — add the featured-collapse + recents; drop the per-provider submenu.

### Effort, fast, and the CLI — same popover, no submenus

- **CLI row.** Chips under the search box (`All · Claude · Codex · Pi`) filter groups to one
  CLI/harness; each group header carries the CLI glyph + binary sub (`claude-agent-sdk`,
  `codex CLI`, `local harness`). Filtering to one CLI disables featured-collapse (you asked
  for that CLI — show its whole catalog).
- **Options panel pinned at the bottom** for the *selected* model (mirrors `ModelOptionsPanel`):
  the Faster ↔ Smarter effort slider (Claude `effort`: low…max, default high; Codex
  `reasoningEffort`: minimal…xhigh) and the ⚡ Fast toggle where supported (`fast` boolean /
  service tier). Models without options show no panel — Haiku gets nothing.
- **Row affordances**: models with tunables carry tiny gauge/bolt glyphs so you can see
  what's tunable before selecting.
- **Trigger stays honest**: `Opus 4.8 · max ⚡` — effort only shown when off-default,
  bolt only when fast is on. Adjusting options keeps the popover open; selecting a model
  closes it.

## Decisions log

- Sidebar mechanism unchanged (hover-rail + pin + mobile sheet) — Oscar chose to keep it.
- Home + /new merged — Oscar confirmed.
- Accent presets deleted outright (not kept as opt-in) — Oscar confirmed "thuần Vercel".
- Glass direction: solid-first (option B1) — embodied in the prototype for Oscar to judge.
- Status colors: amber/red only — embodied in the prototype for Oscar to judge.
