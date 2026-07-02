---
"nuncio": patch
---

Fixed the server daemon shutdown path so SIGTERM and SIGINT cleanly dispose CLI agents, close the Nest HTTP listener, and exit promptly instead of hanging until force-killed.
