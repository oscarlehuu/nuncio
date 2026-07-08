---
"nuncio": minor
---

Added an auto-fix loop on top of the verifier gate: when a session's post-turn checks fail, nuncio can feed the failure output straight back to the agent and let it try again — up to a few rounds — before it stops and flags the session as needing you. It's off by default; turn it on with the `NUNCIO_VERIFY_AUTO_STEER` setting and cap the attempts with `NUNCIO_VERIFY_MAX_ROUNDS` (default 3). The retry budget also stops early when two runs fail identically, so a stuck agent surfaces to you instead of burning rounds. The transcript now shows each auto-retry as its own line and, when the loop gives up, a distinct "checks still failing — needs your attention" row, so it's never confused with an ordinary red check. The whole loop is rebuilt from the event log, so a daemon restart mid-retry resumes exactly where it left off.
