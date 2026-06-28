# Assets

Screenshots and images used by `README.md` live here.

This directory is the **only** place `*.jpg` / `*.png` files are tracked — the root `.gitignore` ignores those extensions everywhere else, with an explicit `!assets/*.jpg` / `!assets/*.png` exception.

## Conventions

- Use descriptive kebab-case names: `session-list-mobile.png`, `create-session-desktop.png`, `sidebar-archived-tab.png`.
- Prefer `.png` for UI screenshots (lossless); use `.jpg` only for large photos where file size matters.
- Keep images reasonably sized — compress before committing (`pngquant`, `oxipng`, or squoosh.app). Aim for < 500 KB per image.
- Reference them from `README.md` with relative links: `![Session list on mobile](session-list-mobile.png)`.
