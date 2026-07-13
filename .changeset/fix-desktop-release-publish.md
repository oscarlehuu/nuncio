---
"nuncio": patch
---

Fixed the desktop auto-update prerelease publishing, which had been failing since the "draft release until assets upload" change — every dev build errored at the GitHub release step (HTTP 422), so the desktop app stopped receiving updates. Draft releases are now created with a real tag ref before assets upload, and stale-draft cleanup no longer tries to delete a nonexistent tag.
