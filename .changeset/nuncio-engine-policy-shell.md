---
"nuncio": minor
---

Policy-restricted Nuncio Engine sessions now have a bash tool. When an OS sandbox backend is available, networking is disabled, writes are confined to the workspace, and git metadata plus the `.nuncio` verify gate are mounted read-only; the default auto mode clearly announces its advisory fallback when no backend is available.
