---
"nuncio": minor
---

Crew Builders and other policy-restricted Nuncio Engine sessions now have a bash tool: every command runs inside a Nuncio-enforced OS sandbox (network disabled, writes confined to the workspace, git metadata and the .nuncio verify gate read-only), so a Builder can run builds and tests before submitting. Configurable via the new Nuncio Engine policy shell setting.
