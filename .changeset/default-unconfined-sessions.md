---
"nuncio": patch
---

Nuncio Engine sessions now run with full machine access by default (network, toolchain, reads) — isolation comes from per-session git worktrees and the gate guard. The hermetic OS sandbox is now opt-in (`NUNCIO_ENGINE_WORKSPACE_CONFINEMENT=on`) for untrusted work, instead of the default; the previous default blocked the network, Xcode, and reads outside the workspace.
