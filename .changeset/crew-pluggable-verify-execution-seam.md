---
"nuncio": patch
---

Widened Crew's verify-execution seam so an alternate isolation backend can plug in additively: the
verification workspace factory and the sandbox backend are now name-selectable registries, and the
verify timeout and output cap are overridable per Crew profile. Every field is optional and omission
keeps today's git-snapshot + host-sandbox behavior byte-identical; an unknown strategy fails profile
resolution with a clean validation error.
