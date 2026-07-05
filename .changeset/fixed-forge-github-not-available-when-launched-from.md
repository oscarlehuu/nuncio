---
"nuncio": patch
---

Fixed "Forge provider github is not available" (and the same for GitLab) when the desktop app is launched from Finder/Dock. A GUI-launched app inherits a minimal PATH, so the server's `gh auth token` / `glab auth status` spawn failed with ENOENT even when the CLI was installed and authenticated, making the forge look unavailable. CLI auth now spawns with common install dirs (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`) appended to PATH, while still preferring any `gh`/`glab` the user's own PATH resolves.
