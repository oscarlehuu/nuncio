# Findings 01 — Desktop UI current state

## Shell composition

Electron is a thin shell: `apps/desktop/src/main.js` `createWindow(url)` loads the Vite dev
server or the packaged daemon serving `apps/web/dist`. Desktop-only features all live in
`main.js`: tray + close-to-tray, native app/Server menus, auto-updater, notifications,
window-state persistence, embedded BrowserView (in-app browser + design mode), node-pty
terminals. Bridge: `preload.js` → `window.nuncioDesktop`.

**Window chrome is 100% native default** — no `frame:false`, `titleBarStyle`, `vibrancy`,
`transparent`, or `-webkit-app-region` anywhere in `apps/desktop` or `apps/web`. macOS renders
the stock title bar + traffic lights above the app. This is the single biggest visual gap vs
Cursor/Synara (both integrate window controls into the app header).

Web-side Electron detection exists in exactly one place: `general-settings-section.tsx:14`
(`window.nuncioDesktop?.marker === 'desktop'`). `use-desktop-sidebar.ts` /
`desktop-sidebar-shell.tsx` mean the `md:` breakpoint, not Electron.

## Design system

Cursor retheme **already shipped** — `b7faf994 feat(web): retheme UI to Cursor's exact design
tokens` (after `16a0bbee` monochrome/glass-removal). `apps/web/src/index.css` (454 lines) has
the target values live:

- Dark: `--background:#181818`, chrome `--sidebar/--popover:#141414`, `--foreground:#F0F0F0`,
  `--border: rgb(240 240 240 / 0.075)` hairline; light: `#FCFCFC`/`#F3F3F3`/ink `#141414`.
- Elevation ladder `--shadow-e0..e3` (flat at rest, shadow only on overlays), type scale
  `--text-ui-xs…--text-title`, radius `--radius:0.25rem`, Geist Variable + SF Mono.
- Status colors are the only chromatic tokens; info is neutral gray (mono direction holds).

`packages/core/src/design-tokens.ts` mirrors the values; `design-tokens.spec.ts` enforces
parity — **any restyle edits both files**.

## Surfaces (all broadly on-theme)

sidebar (`sidebar.tsx` — borderless rows, selection pill), home (`home-surface.tsx` /
`home-view.tsx` — composer-centric, `max-w-[720px]`), workbench grid (`grid-view.tsx`), session
tile (`session-tile.tsx` — lifted card + tile-glow), session detail (`session-detail.tsx` —
centered 760px transcript, composer card, right inspector aside 360px), transcript tool rows
(`transcript-blocks/tool-call-block.tsx` + `tool-glyph.tsx` — quiet, monochrome), settings
(`settings-view.tsx` — Cursor-style nav + grouped cards), diff (`diff-view.tsx` — unified,
status-token tinted), shadcn primitives on the e-ladder.

## Inconsistencies to sweep

1. **57× arbitrary `text-[NNpx]`** bypassing the `text-ui*` scale — worst: `grid-slot-composer.tsx`
   (8), `grid-view.tsx` (5), `session-tile.tsx` (4), `transcript-blocks/evidence-block.tsx`,
   most `forge/*`.
2. **9× hardcoded hues** (amber/emerald) outside status tokens: `session-scm-conflicts.tsx:11-12`,
   `session-changes-panel.tsx:207,214`, `usage-settings-section.tsx:240`,
   `session-changes-panel-utils.tsx:14`, `forge/pr-files.tsx:19`, `review-changes.tsx:25`,
   `remote-access-settings-section.tsx:73` → route through `--status-warning/success`.
3. **5× legacy shadows** off-ladder: `grid-view.tsx:327`, `grid-slot-composer.tsx:487`
   (`shadow-sm` pills), `design-mode-overlay.tsx:59` (`shadow-lg backdrop-blur-md`),
   `ui/switch.tsx:22` (`bg-white shadow-sm` — theme-blind), `model-effort-slider.tsx:142`
   (`ring-black/15` — theme-blind).
4. **Elevation drift:** index.css header says "cards flat, hairline-separated; shadow only on
   overlays", but session tiles + both composers use `shadow-e1/e2 + surface-lit + hover lift`.
   Deliberate hero emphasis vs stated principle — needs an explicit call (see plan.md decisions).

Note: `plans/260716-cursor-ui-study/` does not exist in this worktree/branch history — the
retheme it specified is nonetheless verifiably merged (values above).
