---
"nuncio": patch
---

Added a container sandbox backend for Crew verification. A quality profile can now set `sandboxBackend: "container"` to run its deterministic verify command inside a Docker or Podman container instead of the host Seatbelt/bubblewrap sandbox: the workspace snapshot is bind-mounted read-write, any dependency store is mounted read-only, networking is disabled, and memory/cpu/pid limits are applied (image and limits are configurable via the profile's `container` policy). Readiness now probes the selected backend, so a container profile blocks with a clear "needs setup" issue when no Docker/Podman daemon is reachable, exactly like the host sandbox does when Seatbelt/bubblewrap is missing.
