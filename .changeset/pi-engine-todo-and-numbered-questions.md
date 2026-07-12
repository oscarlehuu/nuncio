---
"nuncio": minor
---

Pi sessions gain a live task list and a better question flow. The agent keeps a visible plan (`todo_write`) that renders as a checklist in the transcript and as `n/m steps` on workbench tiles; the shared `plan_updated` event is provider-neutral so other engines can feed the same UI. AskUserQuestion moved in-repo: options are always numbered 1–4 (reply "option 2" or just "2" and the agent maps it back), you can attach a free-text note to a chosen option, and answered questions now show exactly what was picked. Pi extension discovery is deny-by-default behind an allowlist — CLI-oriented global extensions no longer leak into daemon sessions (`PI_EXTENSION_DISCOVERY=full` restores the old behavior).
