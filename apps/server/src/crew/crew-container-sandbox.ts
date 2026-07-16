import { mkdtempSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { CrewContainerPolicy } from './domain/crew.types';
import type { CrewSandboxLaunch, CrewSandboxOptions } from './crew-command-sandbox';
import type { CrewSandboxBackend } from './crew-sandbox-backend';

// Confinement backend that runs the deterministic verify command inside a Docker/Podman container.
// The workspace snapshot is bind-mounted read-write at /workspace, any dependency store read-only at
// /nuncio-deps (the Linux dependency-projection layout), networking is disabled, and conservative
// memory/cpu/pid caps are applied. This is a peer of the host Seatbelt/bubblewrap backend, selected
// per profile; it neither weakens nor replaces the host sandbox.
export const CONTAINER_CREW_SANDBOX_BACKEND = 'container';

// A slim base image by default. It is meant to be overridden per profile with a toolchain image that
// carries whatever the verify command needs; the container has no network, so the image must already
// be present on the host (or pullable by the daemon before the run).
export const DEFAULT_CREW_CONTAINER_IMAGE = 'debian:stable-slim';

const CONTAINER_WORKDIR = '/workspace';
const CONTAINER_DEPS = '/nuncio-deps';
const DEFAULT_CONTAINER_MEMORY_MB = 2048;
const DEFAULT_CONTAINER_CPUS = 2;
const DEFAULT_CONTAINER_PIDS_LIMIT = 512;

export interface CrewContainerRuntime { bin: string; kind: 'docker' | 'podman' }

const runtimeProbeCache = new Map<string, boolean>();

export function resolveContainerRuntime(
  which: (bin: string) => string | null = (bin) => Bun.which(bin),
): CrewContainerRuntime | null {
  const docker = which('docker');
  if (docker) return { bin: docker, kind: 'docker' };
  const podman = which('podman');
  if (podman) return { bin: podman, kind: 'podman' };
  return null;
}

// Mirrors `isCrewVerifierSandboxAvailable`: a binary on PATH is not enough, the daemon must actually
// answer. The probe result is cached per resolved binary; tests inject a runtime and probe.
export function isCrewContainerRuntimeAvailable(
  runtime: CrewContainerRuntime | null = resolveContainerRuntime(),
  probe: (bin: string) => boolean = defaultDaemonProbe,
): boolean {
  if (!runtime?.bin) return false;
  const cached = runtimeProbeCache.get(runtime.bin);
  if (cached !== undefined) return cached;
  const available = probe(runtime.bin);
  runtimeProbeCache.set(runtime.bin, available);
  return available;
}

export function resetContainerRuntimeProbeCache(): void { runtimeProbeCache.clear(); }

export function buildContainerSandboxLaunch(
  command: string,
  cwd: string,
  options: CrewSandboxOptions = {},
  runtime: CrewContainerRuntime | null = resolveContainerRuntime(),
  probe: (bin: string) => boolean = defaultDaemonProbe,
): CrewSandboxLaunch {
  if (!isCrewContainerRuntimeAvailable(runtime, probe) || !runtime) {
    throw new Error('Crew container runtime is unavailable; refusing unsandboxed execution');
  }
  const canonicalCwd = realpathSync.native(cwd);
  const dependencyRoot = options.dependencyRoot ? realpathSync.native(options.dependencyRoot) : null;
  if (dependencyRoot && !statSync(dependencyRoot).isDirectory()) {
    throw new Error('Crew container dependency root is not a directory');
  }
  const container = options.container ?? {};
  const image = (container.image ?? '').trim() || DEFAULT_CREW_CONTAINER_IMAGE;
  const limits = resourceLimits(container);
  const tempDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'nuncio-crew-container-')));
  // Unique per launch, so concurrent verifies never collide on --name and teardown targets exactly
  // this container.
  const name = `nuncio-crew-verify-${basename(tempDir)}`;
  const hostEnv = hostRuntimeEnv();
  const argv = [
    runtime.bin, 'run', '--rm', '--name', name,
    '--network', 'none',
    '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,size=1g',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', `${limits.memoryMb}m`, '--memory-swap', `${limits.memoryMb}m`,
    '--cpus', String(limits.cpus), '--pids-limit', String(limits.pidsLimit),
    ...containerUserArgs(),
    '--mount', `type=bind,src=${canonicalCwd},dst=${CONTAINER_WORKDIR}`,
    ...(dependencyRoot
      ? ['--mount', `type=bind,src=${dependencyRoot},dst=${CONTAINER_DEPS},readonly`]
      : []),
    '--workdir', CONTAINER_WORKDIR,
    ...containerEnvArgs(),
    image, '/bin/sh', '-c', command,
  ];
  return {
    argv,
    cwd: canonicalCwd,
    env: hostEnv,
    tempDir,
    onTerminate: () => removeContainer(runtime.bin, name, hostEnv),
  };
}

export const containerCrewSandboxBackend: CrewSandboxBackend = {
  name: CONTAINER_CREW_SANDBOX_BACKEND,
  isAvailable: () => isCrewContainerRuntimeAvailable(),
  build: (command, cwd, options = {}) => buildContainerSandboxLaunch(command, cwd, options),
};

function defaultDaemonProbe(bin: string): boolean {
  try {
    return spawnSync(bin, ['info'], {
      stdio: 'ignore', timeout: 5000, env: hostRuntimeEnv(),
    }).status === 0;
  } catch {
    return false;
  }
}

// The docker/podman client is a trusted host tool; it needs the operator's env (DOCKER_HOST, PATH,
// HOME, podman CONTAINER_HOST, …) to reach its daemon. This env configures only the client — the
// container's own environment is set explicitly with --env below.
function hostRuntimeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

// Run as the host uid/gid so files the verify command writes into the bind-mounted snapshot stay
// host-owned; otherwise root-owned writes would defeat the host user's snapshot cleanup.
function containerUserArgs(): string[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const gid = typeof process.getgid === 'function' ? process.getgid() : null;
  return uid !== null && gid !== null ? ['--user', `${uid}:${gid}`] : [];
}

function containerEnvArgs(): string[] {
  const env: Record<string, string> = {
    HOME: '/tmp', TMPDIR: '/tmp', XDG_CACHE_HOME: '/tmp/.cache',
    BUN_INSTALL_CACHE_DIR: '/tmp/bun-install-cache',
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '/tmp/bun-runtime-cache',
    CI: '1', LANG: 'en_US.UTF-8', NO_COLOR: '1',
  };
  return Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
}

function resourceLimits(container: CrewContainerPolicy): {
  memoryMb: number; cpus: number; pidsLimit: number;
} {
  return {
    memoryMb: positiveOr(container.memoryMb, DEFAULT_CONTAINER_MEMORY_MB),
    cpus: positiveOr(container.cpus, DEFAULT_CONTAINER_CPUS),
    pidsLimit: positiveOr(container.pidsLimit, DEFAULT_CONTAINER_PIDS_LIMIT),
  };
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

// Best-effort teardown for the timeout/abort/overflow paths, where the runner SIGKILLs the docker
// client process group but the container is owned by the daemon and would otherwise survive. Bounded
// by its own timeout so it can never hang the runner; --rm already covers the normal-exit path.
function removeContainer(bin: string, name: string, env: Record<string, string>): void {
  try {
    spawnSync(bin, ['rm', '--force', name], { stdio: 'ignore', timeout: 5000, env });
  } catch {
    // The container is network-isolated and --rm-bound; a failed force-remove is not fatal.
  }
}
