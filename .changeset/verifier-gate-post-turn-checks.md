---
"nuncio": minor
---

Added a verifier gate: after each agent turn ends, nuncio runs your project's check command (a `.nuncio/verify` script in the repo, or the `NUNCIO_VERIFY_COMMAND` setting) in the session's workspace and annotates the outcome on the transcript. A chip next to the session title — and on grid tiles — shows checks running, passed, or failed, so you can tell "done and green" from "done but broken" without opening the session. Verification never blocks the session itself.
