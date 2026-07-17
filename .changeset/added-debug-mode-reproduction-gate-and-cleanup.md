---
"nuncio": minor
---

Debug mode now runs the full hypothesis-first loop: the agent enumerates hypotheses, adds marked (`// nuncio-debug`) instrumentation, then pauses on a first-class "Reproduction Steps" gate — numbered steps, a live log counter, and Proceed / Mark Fixed. Proceed hands the collected logs back so the agent can diagnose; Mark Fixed tells it to strip its instrumentation. The changes panel warns if any `// nuncio-debug` line is left in the final diff.
