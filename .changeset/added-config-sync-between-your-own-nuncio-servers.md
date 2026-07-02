---
"@nuncio/server": minor
"@nuncio/web": minor
---

Added one-click config sync between your own nuncio servers: from Settings → Remote access, "Sync config" pushes this server's Pi credentials (auth/models/settings.json, never sessions) and DB-configured settings to a same-account tailnet peer running nuncio. The target backs up existing files before overwriting (0600), only accepts known Pi filenames and registered non-path settings, and the whole exchange is authorized by tailnet identity — no token to copy.
