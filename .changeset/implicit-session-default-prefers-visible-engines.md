---
"nuncio": patch
---

Sessions, tasks, and loops created without an explicit engine now default to a visible engine (Nuncio Engine first) instead of a hidden legacy engine; hidden engines remain a fallback when nothing visible is available. README now documents the single-engine default and the "Show legacy engines" toggle.
