---
"nuncio": patch
---

Multitask mode on the Nuncio Engine now really fans out. Start a multitask session on the Nuncio Engine and it splits your goal into 2-5 independent subtasks and launches a child agent for each, instead of only describing the split. The split runs as one bounded, tool-less call on the same model your session is using; if the model can't produce a clean split it retries once and, failing that, reports the error on the parent instead of leaving you stuck.
