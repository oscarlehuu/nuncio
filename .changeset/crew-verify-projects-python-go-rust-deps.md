---
"nuncio": patch
---

Crew verification now projects Python, Go, and Rust dependency caches into its network-disabled sandbox, not just JavaScript ones. A Crew run that verifies a Poetry/uv, Go modules, or Cargo repository reuses your already-installed virtualenv, Go module cache, or Cargo registry — mounted read-only — so its verify command runs offline instead of failing on an uncached install. Multi-language repos project every detected ecosystem at once, and a repo with no recognized lockfile is left exactly as before.
