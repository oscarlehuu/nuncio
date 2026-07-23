---
"nuncio": patch
---

Fix the managed subscription model host to drive the helper's real CLI: pin the version that ships the host subcommands, spawn the actual binary and subcommands, and point the router at the broker. The host now installs, starts, and serves its model catalog on loopback as intended.
