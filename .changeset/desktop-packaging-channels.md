---
"nuncio": minor
---

Nuncio now ships as an installable macOS app that keeps itself up to date. Alongside `bun run dev` for live development, there are two packaged builds you install once and keep: **Nuncio** (stable) follows tagged releases, and **Nuncio Dev** rides the latest `dev` merges — each checks GitHub on launch and updates in place. Both are signed and notarized, so they open without Gatekeeper warnings, and each carries a self-contained server bundle, so the full local daemon runs with no separate Bun install. Dev and stable install side by side with independent data.
