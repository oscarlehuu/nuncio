# Phase 02 Lane A — PWA Report

**Branch:** `cursor/phase-02-pwa-5323`  
**Date:** 2026-06-27  
**Status:** DONE

## Summary

Implemented installable PWA for Nuncio web app via `vite-plugin-pwa`.

## Changes

| File | Change |
|------|--------|
| `apps/web/package.json` | Added `vite-plugin-pwa` devDependency |
| `apps/web/vite.config.ts` | VitePWA plugin: manifest, Workbox precache + NetworkFirst `/api/*` |
| `apps/web/index.html` | iOS meta tags, theme-color, apple-touch-icon, title "Nuncio" |
| `apps/web/public/icons/` | icon.svg source + PNGs (192, 512, apple-touch 180) |

## Manifest

- **name:** Nuncio
- **theme_color / background_color:** `#0d0f12`
- **display:** standalone
- **start_url:** `/`
- **icons:** 192×192, 512×512 (+ maskable)

## Service Worker

- **Precache:** static shell (JS, CSS, HTML, icons, SVG)
- **Runtime:** `NetworkFirst` for `/api/*` (10s network timeout, 24h cache expiry)

## iOS Meta Tags

- `apple-mobile-web-app-capable: yes`
- `apple-mobile-web-app-status-bar-style: black-translucent`
- `apple-mobile-web-app-title: Nuncio`
- `viewport-fit=cover` for notch safe areas (CSS handled by Lane B)

## Verify

```
npm run build  → PASS
PWA v1.3.0 — precache 15 entries, sw.js + manifest.webmanifest generated
```

## Out of Scope (other lanes)

- Mobile sidebar drawer (Lane B)
- Safe-area CSS (Lane B)
- README Tailscale prod docs (Lane C)

## Unresolved

- Manual iPhone Add to Home Screen test pending Tailscale HTTPS deploy
