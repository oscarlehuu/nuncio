---
"nuncio": patch
---

Fixed the mobile home composer's base-branch picker silently showing "No branches" whenever the list was still loading or the request failed — it looked like an empty repo. It now shows a loading state and, on failure, a tappable retry with a clear message, so a slow or dropped `/api/projects/branches` request no longer reads as empty.
