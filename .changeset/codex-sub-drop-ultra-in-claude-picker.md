---
"nuncio": patch
---

Fixed the model picker offering Codex's `Ultra · Multi-agent` reasoning tier on Codex-subscription models shown under the Claude engine. Those rows run through Claude Code, which can't use Codex's native ultra tier (Claude effort tops out at `max` and the runtime skips it), so the picker now offers reasoning only up to `xhigh` for them. The native Codex engine keeps `Ultra`.
