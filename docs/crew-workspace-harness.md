# Crew Workspace Harness

**Status:** implemented and verified for the `dev` integration lane. This is not a claim that Crew
is in a stable release.
**Last synchronized:** 2026-07-16.
**Authority companion:** [CrewRun Authority Boundary and State Machine](crew-run-authority-and-state-machine.md).

## Purpose and fixed scope

Nuncio has two execution modes:

- **Solo** remains the default for every fresh composer and preserves the existing provider/model
  picker and request shape.
- **Crew** selects a saved Quality profile and runs one fixed local workflow:
  `PLAN -> BUILD -> VERIFY -> REVIEW -> SYNTHESIZE -> DONE`.

Crew is a provider-neutral outer harness above ordinary Nuncio Tasks and Sessions. Providers own
their model loops and thread state. Nuncio owns durable workflow state, permissions, one worktree,
one writer lease, context projection, deterministic verification, review validity, retry budgets,
recovery, Attention, and terminal outcomes.

The MVP has no configurable workflow graph and performs no outbound forge or deployment action.
Verify and review are mandatory.

## Profile resolution

The only preset is `quality`. A profile binds three model members:

| Role | Runtime policy | Purpose |
|---|---|---|
| Foreman | `read-only`, network disabled | Plan and synthesize |
| Builder | `workspace-write`, network disabled | Implement and fix |
| Reviewer | `read-only`, network disabled | Return structured findings |
| Nuncio Tester | deterministic read-only process | Run the configured verify command |

Pi, Codex, and Claude are configurable role providers. `mock` exists only in explicitly enabled
source-test runs. The Builder and Reviewer must not use the same provider/model pair.

Resolution has exactly two public states:

- `ready`: every frozen provider/model exists, each adapter advertises the required runtime
  policy with network disabled, Builder and Reviewer are independent, a verify command resolves,
  and the host verifier sandbox is available.
- `needs_setup`: one or more of those requirements is missing.

Nuncio never silently changes a provider or model. A missing frozen binding blocks the run.

Resolution order is run override, project override, saved profile, then fixed Quality policy
defaults. Each `CrewRun` stores an immutable snapshot containing the resolved bindings, runtime
policies, verify command, separate verify/review retry caps, reviewer-freshness setting, profile
id/revision, and resolution time. Editing a saved profile affects only later runs.

Quality defaults are:

- `maxVerifyRetries = 2`;
- `maxReviewRetries = 2`;
- `strictFreshFinalReviewer = true`;
- a project/profile/global verify command must resolve before the profile is ready.

For a project-level `.nuncio/verify`, task creation checks that the file is tracked at the exact
selected base SHA; an untracked file or a file that exists only on another branch cannot make the
profile ready. Nuncio invokes the tracked script with `sh`, so it does not require an executable
bit. Project and profile command overrides remain trusted configuration and take precedence.

Crew checkpoints require a repository-local Git identity because Nuncio will not borrow ambient
global author metadata for autonomous commits. Configure it once in each target repository with
`git config --local user.name "Your Name"` and
`git config --local user.email "you@example.com"` before delegating build work.

## Fixed execution loop

### Plan

The read-only Foreman receives a bounded role envelope and submits a structured plan. Nuncio
automatically accepts a plan that stays inside the fixed roles and policy. A material unresolved
decision moves the same phase to `BLOCKED_USER/material_clarification`; the user response updates
the durable context revision and queues Plan again.

### Build

Nuncio grants the single writer lease only to `builder:primary`. The same Builder Session and
provider thread are reused for verify and review feedback rounds when resumable. Build completion
is accepted only after Nuncio independently confirms the canonical worktree, expected branch,
reachable full Git head, and structured Builder result. The Builder must leave a committed head;
model prose cannot establish a gate.

### Verify

Nuncio runs the frozen verify command itself. It records exit status, timeout, spawn failure,
combined-output overflow, duration, pre/post workspace boundary evidence, full head, and a redacted
verify-log artifact. A pass requires exit code zero, no timeout/abort/spawn error/overflow, and an
unchanged clean workspace boundary.

A failure returns to the same Builder while the verify retry budget remains. The initial attempt
does not consume the cap; at most two automated verify-fix retries occur by default. Cap exhaustion
blocks for the user. An approved extra round adds exactly one round for that gate and returns to
Build.

### Review

Before Reviewer execution, Nuncio captures a deterministic diff from the run base head to the
current head. A truncated diff fails closed and cannot be treated as reviewable evidence.

Nuncio classifies that diff's UI impact deterministically at capture time (pure path/extension
rules in `crew-ui-impact.ts` — no model judgment): the workspace-diff artifact metadata records
`uiTouched`, a bounded `uiFiles` list, and the true `uiFileCount`. When the current diff is
UI-touching, the Reviewer and Foreman envelopes carry a `uiImpact` signal so visual/UX fidelity is
scrutinized explicitly; public run detail exposes only `uiTouched` and `uiFileCount` (never the
file list), and the web run detail badges a UI-touching diff with its file count. This is the
foundation of the visual gate: later slices attach before/after screenshot evidence to the same
signal.

The read-only Reviewer returns typed findings tied to the current head. `warning` findings stay
visible but do not block. A `blocker` returns to the same Builder while the independent review
retry budget remains; the fixed sequence then passes through Verify again.

The existing Reviewer Session is reused during the feedback loop. When
`strictFreshFinalReviewer` is enabled, a fresh linked Reviewer incarnation is created only after a
review-fix loop has produced a blocker-free reused-reviewer result. A clean first review does not
create an unnecessary fresh Reviewer.

### Synthesize and Done

The Foreman produces a structured synthesis. Before terminal success, Nuncio rechecks:

- canonical clean worktree, branch, and current full head;
- current, intact, passing verify artifact;
- current, complete workspace-diff artifact;
- current blocker-free review result;
- fresh final Reviewer lineage when the strict post-feedback rule applies.

Only then does the reducer enter `DONE/TERMINAL/SUCCEEDED`. Other terminal outcomes are
`FAILED` and `CANCELLED`.

## Context and member-session semantics

Models do not share hidden reasoning, provider caches, or merged transcripts. The durable shared
spine consists of the run objective, context revisions, decisions, structured results, current
workspace head, gate evidence, artifact references, retry counters, and prior failure summary.

Each member receives a role-specific bounded envelope:

- Foreman: objective, decisions, member state, open questions, and bounded evidence;
- Builder: accepted goal, current head, prior verify/review failure, and write authority;
- Reviewer: requirements, deterministic diff, verify evidence, and read authority;
- Tester: the frozen command and exact workspace boundary, executed by Nuncio rather than a model.

Member work is scheduled through ordinary durable Tasks and Sessions with Crew correlation fields.
A logical member keeps a current incarnation plus explicit `priorMemberSessionId` lineage.
Healthy sessions receive context deltas. A missing or non-resumable thread creates a linked
replacement with the same frozen provider/model; it does not trigger a provider change.

Session memory is continuity, not authority. Git, append-only Crew events, structured results, and
artifact integrity remain authoritative.

A successor normally re-resolves the saved profile. If that profile was deleted after the prior
run, Nuncio re-resolves the prior immutable snapshot instead, preserving the same provider/model
bindings without silently selecting a replacement profile.

## Workspace and write authority

Every active run owns one retained worktree and branch. The run records the canonical worktree
path, base branch/head, branch, and current full head.

- Exactly one writer lease may exist per run.
- Only `builder:primary` may acquire it.
- Foreman and Reviewer receive read-only provider policies.
- Nuncio Tester runs separately under the verifier sandbox.
- Runtime writes cannot escape the canonical worktree or mutate `.git` metadata.
- A head change invalidates older verify and review evidence.
- Reconciliation never resets, checks out, deletes, or silently adopts an unexpected workspace.

Parallel writers and merge coordination are outside this baseline.

## Provider runtime-policy enforcement

Explicit Crew policy is stored on the ordinary Session and applied on every run and resume:

- **Pi:** exposes only path-confined read/grep/list tools for read-only members and adds confined
  edit/write tools for Builder. Workspace-write members also get a `bash` tool whose every command
  runs inside the shared OS sandbox (Seatbelt/bubblewrap: network denied, writes confined to the
  workspace, `.git` and `.nuncio` read-only) whenever a backend is available — so a Builder can run
  tests before submitting. `NUNCIO_ENGINE_POLICY_SHELL` selects `auto` (default; falls back to a
  plain shell that announces its confinement is advisory), `sandboxed-only`, or `off`. Read-only
  members never get a shell. Policy sessions also carry the in-repo `nuncio-engine` gate-guard rail
  (pre-execution `.nuncio` write blocking) while staying hermetic.
- **Codex:** maps to app-server read-only or workspace-write sandbox policy with network disabled,
  approval policy `never`, exact cwd, and one runtime workspace root.
- **Claude:** exposes only allowlisted read or read/write file tools, enforces canonical paths in a
  `PreToolUse` hook and permission callback, and admits only independently trusted Crew tools.

Unsupported enforcement rejects before prompting. Solo Sessions with no explicit runtime policy
retain their existing provider behavior.

## Deterministic verifier sandbox

The verifier refuses to run without a supported host sandbox. It checks the frozen full Git head,
then prepares an exact-head disposable Git snapshot instead of running inside the canonical Crew
worktree. Ignored files, generated output, and verifier writes are discarded with that snapshot.

Already installed Bun or pnpm dependencies may be projected from another Git worktree only when
the root lockfile bytes match. Dependency stores are mounted read-only and workspace-package links
resolve to the frozen snapshot. These installed bytes are trusted-host input: the boundary protects
against Crew members and the verifier mutating them, but it does not cryptographically attest
changes made by the machine owner or another host process.

Dependency projection is keyed by the ecosystem detected in the frozen snapshot, so a Python, Go,
or Rust repository verifies offline from an already-populated host cache the same way a JavaScript
repository verifies from `node_modules`. Each ecosystem projects only when its toolchain is
reachable in the sandbox and, where correctness depends on it, only when the cache provably matches
the frozen snapshot:

- **Python** (`poetry.lock` or `uv.lock`): a virtualenv is borrowed only from a worktree whose
  python lockfile bytes match the snapshot exactly — the same byte-equal check as the JavaScript
  store — so an ambient `$VIRTUAL_ENV` or a sibling `.venv` installed for a different lock never
  becomes gate evidence. The matched venv is mounted read-only at its original absolute path (so its
  console-script shebangs resolve) and exposed through `VIRTUAL_ENV` and a `bin/`-prefixed `PATH`.
- **Go** (`go.sum`): the module cache (`$GOMODCACHE`, else `$GOPATH/pkg/mod`, else
  `$HOME/go/pkg/mod`) is mounted read-only and exposed through `GOMODCACHE` with `-mod=readonly`
  and `GOPROXY=off`; the writable build cache stays under the sandbox's isolated cache dir. The `go`
  install root is mounted read-only and its `bin/` added to `PATH`, since the sandbox clears `PATH`.
- **Rust** (`Cargo.lock`): the crate registry (`$CARGO_HOME/registry`) is mounted read-only inside a
  writable `CARGO_HOME` with `CARGO_NET_OFFLINE=true`, so cargo may hold its package-cache lock while
  the registry cannot be mutated. When the lock references git dependencies, `$CARGO_HOME/git` is
  mounted read-only alongside it; if that cache is missing, Rust is not projected. The `cargo`
  install root is mounted read-only and its `bin/` added to `PATH`.

The toolchain binary is resolved on the host and projected only when it lives outside the
sandbox-denied home directory. A home-installed toolchain (rustup `~/.cargo/bin`, mise/asdf) cannot
be made visible under the cleared `PATH` and home deny, so that ecosystem is not projected here — the
container backend, which brings its own toolchain image, is the path for those.

A multi-ecosystem repository projects every detected ecosystem into distinct read-only mounts. An
ecosystem whose toolchain or cache is absent (or unmatched), and any unrecognized ecosystem, receive
no projection: the verify command runs unchanged and an uncached install simply fails closed under
the disabled network rather than reaching out. Every projected cache carries the same read-only,
trusted-host boundary as the JavaScript store; a cache projected from inside the source worktree
(such as its own `.venv`) is carved out of the macOS source-root read-deny so it stays readable
without weakening that deny. Because Seatbelt allows or denies paths but cannot remap them, macOS
reads each cache at its host path while Linux bind-mounts it read-only; both profiles deny writes to
the cache. Per-ecosystem projection through the container backend (which today mounts only the
JavaScript store at `/nuncio-deps`) is a follow-up: its Linux-namespace paths differ from the
host-resolved mount env, so the mount contract needs a container-namespace env before it can carry
these caches.

Supported host sandboxes are:

- macOS: Seatbelt through `/usr/bin/sandbox-exec`;
- Linux: bubblewrap through `/usr/bin/bwrap`.

Readiness runs and caches a minimal sandbox probe; binary existence alone is not enough. A host
that cannot actually apply Seatbelt or bubblewrap resolves `needs_setup` before a run is created.
On macOS, file data is denied globally outside the disposable snapshot, isolated temp/cache,
read-only dependency stores (the JavaScript store plus any projected Python/Go/Rust cache),
Nuncio's executable directory, and narrowly required system runtime paths. Host locations such as the user's home, sibling temp files, `/private/etc`, and `/Library`
remain unreadable. Both modes disable network, protect Git metadata and dependency stores, and
constrain filesystem access. Nuncio never falls back to an unsandboxed command.

Combined stdout/stderr uses a shared byte budget: 16 MiB by default, with the runner accepting no
configuration above 64 MiB. Overflow terminates the process group and fails verification. Timeout
or cancellation also kills the process group. Snapshot preparation and command execution share one
owner abort signal and total deadline; preparation failure is infrastructure evidence and does not
consume a verify-fix retry.

### Container sandbox backend

The confinement strategy is pluggable per profile. The default `host` backend uses Seatbelt or
bubblewrap as above. A profile may instead set `sandboxBackend: "container"` to confine the same
frozen verify command inside a Docker or Podman container. The container mounts the disposable
exact-head snapshot read-write at `/workspace` (the working directory), mounts any projected
dependency store read-only at `/nuncio-deps`, disables networking (`--network none`), drops all
capabilities with `no-new-privileges`, and applies memory, cpu, and pid limits. It runs as the host
uid/gid so files written into the bind-mounted snapshot stay host-owned and cleanable. The image and
resource limits are configured through the profile's optional `container` policy
(`{ image, memoryMb, cpus, pidsLimit }`); the image defaults to a slim base and is expected to be
overridden with a toolchain image the verify command needs, present on the host because the container
has no network.

Readiness probes the *selected* backend, not always the host sandbox: a container profile requires a
reachable Docker or Podman daemon (binary on `PATH` plus an answering `info` probe, mirroring the host
sandbox probe) and otherwise resolves `needs_setup` before a run is created, with a container-specific
issue message. Nuncio never falls back to an unsandboxed command. Because the runner terminates a
timed-out or cancelled verify by killing the client's process group — which does not stop a
daemon-owned container — the backend registers a bounded best-effort teardown that force-removes the
container on those paths; `--rm` covers normal exit.

Dependency projection uses the Linux mount layout (`/workspace`, `/nuncio-deps`), so container-backed
dependency resolution is correct when the host that prepared the snapshot is Linux (the CI target). On
a non-Linux host the default `git-snapshot` workspace projects dependency symlinks to host paths that
are not visible inside a Linux container; a project with no separately installed dependencies is
unaffected. The container backend does not change the reducer, authority model, or the host sandbox.

## Redacted artifacts and progressive reads

Nuncio retains the complete captured verify output and current workspace diff up to their
fail-closed bounds. Before writing a `0600` artifact file, it redacts high-confidence secrets,
API keys, forge tokens, Bearer values, and secret-like environment assignments. Metadata stores
SHA-256 and byte count; every range read rechecks both before returning bytes.

Public run detail exposes only allowlisted metadata. It never exposes the storage path, verify
command, or cwd.

`GET /api/crew-runs/:runId/artifacts/:artifactId?offset=<byte>&limit=<bytes>` returns:

```json
{
  "range": {
    "artifactId": "…",
    "offset": 0,
    "nextOffset": 16384,
    "eof": false,
    "text": "…"
  }
}
```

The default chunk is 16,384 bytes and the maximum is 65,536. Offsets are run-scoped,
non-negative, and must align to UTF-8 character boundaries. `nextOffset` is the server-provided
byte cursor; clients never derive progress from JavaScript string length. Web and mobile viewers
are bounded, progressive, retryable, and show loading/error/end states.

## Durability, recovery, and resume

`CrewTask` is the stable user intention. `CrewRun` is one immutable execution revision with an
append-only event stream, projected tuple, context revision, profile snapshot, workspace lineage,
member lineage, results, and artifacts. Commands use expected-revision compare-and-swap; event and
attempt idempotency keys prevent duplicate advancement.

Recovery is layered:

1. Clients resume the Crew event cursor with `since`; clients render server projection rather
   than inferring state from member transcripts.
2. On daemon boot, Crew task claiming remains closed until every queued Crew attempt is reconciled.
   Terminal, orphaned, wrong-role, stale-revision, and stale-member attempts are cancelled before
   ordinary task workers may claim them; reconciliation failure keeps the queue fail-closed.
3. Nuncio scans every non-terminal run, verifies event replay equals the stored projection, and
   reconciles the canonical worktree/branch/full head.
4. Builder recovery idempotently finishes the complete durable settlement chain before comparing
   heads or scheduling work: accepted intent, Git checkpoint (including a crash-created clean
   descendant), finalized structured result, then writer-lease release. Crashes at either side of
   result persistence converge without a duplicate commit or stale lease.
5. A resumable provider Session is continued. Otherwise Nuncio creates a linked member
   incarnation with the same frozen binding and current context/workspace.
6. An interrupted Verify may be queued again only after the exact current head and clean boundary
   are re-established. Build recovery and an acknowledged BUILD pause may preserve a dirty
   in-progress worktree only through the explicit recovery marker.
7. A pre-existing deterministic worktree is adopted only when its full HEAD equals the frozen base
   SHA. Missing, moved, symlinked, diverged, descendant, stale, or unavailable state blocks in
   Attention; it is not silently repaired or rerouted.

Pause preserves phase. Provider loss preserves phase in `BLOCKED_PROVIDER`; restoration passes
through `RECOVERING`. Cancellation quiesces member tasks/provider handles, aborts verification,
releases the writer lease, and creates an immutable terminal run.
Pause, cancel, resume, clarification, and extra-round commands serialize with member enqueue and
settlement on the same per-run chain. An owner-aborted Verify emits no gate result, is excluded from
gate projection, and consumes no retry; stale competing controls fail their exact revision check.

## Successor runs

A terminal run never reopens. A user change request creates one successor under the same
`CrewTask`, linked by `priorRunId` and exact expected base head. The prior snapshot, plan,
decisions, synthesis, and gate evidence are copied as bounded history; the retained clean worktree
becomes the successor base and all new gates start invalid.

Healthy Foreman and Builder Sessions may continue only when provider, model, policy, workspace,
and resumability still match. Reviewer continuity is not reused across successor runs. The prior
run, its events, results, and artifacts remain unchanged.

## API and client surfaces

The additive REST surface is:

- profile preset/CRUD/resolve under `/api/crew/presets` and `/api/crew/profiles`;
- task creation/history/successor under `/api/crew/tasks`;
- a bounded latest-per-task run-summary list under `/api/crew-runs` (`limit` defaults to 20 and
  caps at 100; `offset` paginates) that excludes snapshots, context, and host paths;
- full run detail/events/artifact ranges under `/api/crew-runs/:id`;
- guarded pause, resume, cancel, clarification, and gate-specific extra-round commands.

Web/PWA and Expo both default to Solo, require a server-resolved `ready` profile before Crew
creation, and let the user choose the exact base branch before that resolution is accepted. They
show the fixed phase order, member Sessions, current gate evidence, recovery/blocker state,
immutable history, and valid commands. They do not resolve provider/model bindings locally.
Crew lifecycle pushes are emitted from the Crew aggregate with both `crewTaskId` and `crewRunId`;
hidden member Session pushes are suppressed so notification navigation preserves run identity.

## Sau đó build thêm

These are deferred and are not part of the implemented baseline:

1. **Custom member prompts** and project-specific role prompt editing.
2. **DAG workflows and custom roles**, including multiple writers and an integration/merge role.
3. **Publish/PR/deploy actions** and their explicit authority, journaling, and reconciliation.
4. **Provider/model fallback only if separately approved** as a new visible policy; never silently.
5. **Deeper read coverage** beyond current bounded context, artifact metadata/ranges, and compact
   evidence, after clear demand and privacy limits are defined.
6. **Cleanup/retention automation** for worktrees, member Sessions, provider threads, events, and
   artifacts. Current Crew resources are retained.
7. **Content-attested dependency snapshots or a CAS** for deployments that must distrust other
   host processes, beyond the current byte-equal-lockfile and read-only trusted-host boundary.

## Verification state

The implementation includes unit contracts for reducer, profile resolution, runtime policies,
workspace/lease authority, structured results, verifier/artifacts, recovery/successors, API, core
transport/projections, and web/mobile surfaces. The local verification record is:

- 204 Crew server unit tests and 10 Crew HTTP e2e tests passed;
- the full 39-test server e2e layer, 350 core tests, 861 web tests, 89 mobile checks, and 126 script
  tests passed;
- `bun run gate:full` passed, including the existing level-5 real-browser smoke in headless mode
  across Solo and Crew, desktop and narrow layouts, pause/resume, fixed gates, and terminal success;
- independent high-reasoning review findings were regression-tested and addressed; the final
  follow-up review found no actionable correctness regressions.

GitHub records `dev` PR/CI integration separately. Stable promotion remains outside this baseline.
