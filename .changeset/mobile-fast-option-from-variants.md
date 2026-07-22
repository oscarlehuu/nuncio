---
"nuncio": patch
---

Fixed the mobile model picker not offering the "Priority" (fast) toggle for Codex/Cursor models that express `fast` as a variant instead of an explicit options descriptor. The composer now derives fast from a model's variants (matching the web's `modelSupportsFast`), so those models can enable priority/fast from the Model options sheet.
