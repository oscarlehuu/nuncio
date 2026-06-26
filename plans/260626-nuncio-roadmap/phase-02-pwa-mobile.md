# Phase 02 — PWA + Mobile + Tailscale Prod

**Status:** In progress (Lanes A+B merged)  
**Depends on:** Phase 0–1

## Done
- [x] vite-plugin-pwa, manifest, icons, SW (Lane A)
- [x] Mobile drawer, scrim, safe-area (Lane B)
- [x] README PWA + Tailscale guide (Lane C)

## Remaining
- [ ] iPhone Add to Home Screen manual test via Tailscale
- [ ] Unified prod proxy (optional): single port for web + API

## Agent ownership

| Lane | Files |
|------|-------|
| A | `vite.config.ts`, `index.html`, `public/icons/**` |
| B | `App.tsx`, `sidebar.tsx`, `index.css`, `home-view.tsx` |
| C | `README.md` |

## Success criteria

- Installable PWA on iOS via Tailscale HTTPS
- `npm run build` + `npm test` green
