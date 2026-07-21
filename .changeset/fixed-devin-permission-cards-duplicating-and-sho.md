---
"nuncio": patch
---

Fixed Devin stalling after you approve a permission: Nuncio now replies with the ACP `outcome.optionId` Devin expects, so tools actually run. Settings → Providers now includes Claude and Devin with configurable default permission modes (Devin defaults to Bypass Permissions), and Codex runtime mode is a labeled select. Also stopped duplicate permission cards and mapped ACP tool calls onto shared transcript tool rows.
