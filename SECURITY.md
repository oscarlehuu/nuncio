# Security Policy

Nuncio is a self-hosted app that runs on your own machine and handles **API keys, OAuth/subscription tokens, and an encrypted settings store**. We take security seriously.

## Supported versions

Only the latest release line receives security fixes. Nuncio is pre-1.0 (`0.x`), so breaking changes can happen on any minor bump — pin to a specific release if you need stability.

| Version | Supported |
|---------|-----------|
| latest `0.x` | ✅ |
| older `0.x` | ❌ — upgrade to the latest release |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report them privately:

1. **Preferred:** use GitHub's private vulnerability reporting — go to the [Security tab](https://github.com/oscarlehuu/nuncio/security/advisories/new) of the repo and click **"Report a vulnerability"**. This creates a private advisory visible only to the maintainers.
2. **Alternative:** email the maintainer at `oscar.lehuu@gmail.com` with the subject `Nuncio security report`.

Please include:

- A description of the issue and its impact
- Steps to reproduce (proof-of-concept, logs, or a minimal repro)
- Affected versions / commits
- Any suggested fix or mitigation

You will receive an acknowledgment within **72 hours**, and a status update with a fix timeline within **7 days**. We will credit you in the advisory unless you prefer to remain anonymous.

## Scope

In scope:

- Secrets handling — the settings store (AES-256-GCM encryption at rest), masking of secrets in API responses, fallback to env vars
- Auth — Tailscale network exposure, the planned static app token, session access controls
- The agent harness — provider credential usage (Pi `~/.pi/agent/auth.json`, `CURSOR_API_KEY`), filesystem access via the folder picker and git worktree creation
- SSE / event log — session data leakage across sessions, replay cursor abuse
- Dependencies — known-vulnerable packages in `apps/server` or `apps/web`

Out of scope (but still welcome as hardening suggestions):

- Self-hosted deployment misconfiguration on the user's machine (e.g. exposing the API without Tailscale)
- Vulnerabilities in upstream dependencies that should be reported to their maintainers directly — though please still tell us so we can bump

## Disclosure policy

- We acknowledge receipt privately within 72 hours.
- We investigate and develop a fix on a private branch.
- We coordinate a release with you before public disclosure.
- We publish a GitHub Security Advisory with credit (unless you prefer otherwise) once the fix is released.

## Security best practices for self-hosters

If you self-host Nuncio, follow these to keep your instance secure:

- **Expose only over Tailscale (or another private network).** Do not bind the API or web ports to a public interface.
- **Do not commit `.env` or `~/.pi/agent/auth.json`** — both are gitignored already; keep them that way.
- **Rotate API keys** if you suspect they've been exposed. The Settings UI lets you update `CURSOR_API_KEY` and other secrets without a restart.
- **Run as a non-root user** with the minimum filesystem permissions Nuncio needs (read access to the project directories you delegate to; write access to `data/`).
- **Keep Bun and dependencies up to date** — `bun update` periodically.
