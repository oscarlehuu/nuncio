import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

export interface SubscriptionHostChildHandle {
  pid: number;
  /** True as soon as a kill signal is sent (Bun/Node set this immediately). */
  killed: boolean;
  /** True only after the process has actually exited. */
  hasExited: boolean;
  kill: (signal?: NodeJS.Signals | number) => void;
  exited: Promise<number | null>;
}

export interface SubscriptionHostSpawnOptions {
  bin: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export type SubscriptionHostSpawnImpl = (
  opts: SubscriptionHostSpawnOptions,
) => Promise<SubscriptionHostChildHandle>;

export type SubscriptionHostProcessName = 'broker' | 'router';

export interface SubscriptionHostStartSpec {
  bin: string;
  cwd: string;
  env?: Record<string, string>;
  processes: Array<{ name: SubscriptionHostProcessName; args: string[] }>;
}

/**
 * Supervises the Nuncio-owned subscription model host — the sign-in store
 * ("broker") and the model-router ("router") — as two child processes.
 * Mirrors CliproxyManagedHost: SIGTERM→SIGKILL teardown, `hasExited`-gated
 * (never `killed`-gated) SIGKILL, and an idempotent start. Adds supervised
 * restart: if either child exits unexpectedly the whole pair is respawned.
 */
@Injectable()
export class SubscriptionHostManagedHost implements OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionHostManagedHost.name);
  private readonly children = new Map<SubscriptionHostProcessName, SubscriptionHostChildHandle>();
  private spec: SubscriptionHostStartSpec | null = null;
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  /** Overridable for unit tests. */
  spawnImpl: SubscriptionHostSpawnImpl = defaultSpawn;
  /** Grace period before SIGKILL after SIGTERM. Overridable for unit tests. */
  stopGraceMs = 2_000;
  /** Backoff before respawning after an unexpected child exit. */
  restartDelayMs = 1_000;

  isRunning(): boolean {
    if (!this.spec) return false;
    if (this.children.size !== this.spec.processes.length) return false;
    return [...this.children.values()].every((child) => !child.hasExited);
  }

  pid(name: SubscriptionHostProcessName): number | null {
    const child = this.children.get(name);
    return child && !child.hasExited ? child.pid : null;
  }

  async start(spec: SubscriptionHostStartSpec): Promise<void> {
    // Idempotent restart: tear the previous pair down first.
    await this.stop();
    this.stopping = false;
    this.spec = spec;
    for (const proc of spec.processes) {
      const handle = await this.spawnImpl({
        bin: spec.bin,
        args: proc.args,
        cwd: spec.cwd,
        ...(spec.env ? { env: spec.env } : {}),
      });
      this.children.set(proc.name, handle);
      this.watchExit(proc.name, handle);
      this.logger.log(`Started subscription host ${proc.name} pid=${handle.pid}`);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.spec = null;
    const handles = [...this.children.values()];
    this.children.clear();
    await Promise.all(handles.map((handle) => this.stopChild(handle)));
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  private watchExit(name: SubscriptionHostProcessName, handle: SubscriptionHostChildHandle): void {
    void handle.exited.then((code) => {
      // Ignore stale exits after stop()/restart replaced this child.
      if (this.stopping || this.children.get(name) !== handle) return;
      this.logger.warn(`Subscription host ${name} exited code=${code}; scheduling restart`);
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer || !this.spec) return;
    const spec = this.spec;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      void this.start(spec).catch((error) => {
        this.logger.error(
          `Subscription host restart failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, this.restartDelayMs);
  }

  private async stopChild(child: SubscriptionHostChildHandle): Promise<void> {
    try {
      if (!child.hasExited) child.kill('SIGTERM');
    } catch {
      // already gone
    }
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, this.stopGraceMs));
    await Promise.race([child.exited.then(() => undefined), timeout]);
    // Guard SIGKILL on `hasExited`, not `killed` — `killed` is true the instant
    // SIGTERM was sent.
    if (!child.hasExited) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      await child.exited.catch(() => undefined);
    }
  }
}

function defaultSpawn(opts: SubscriptionHostSpawnOptions): Promise<SubscriptionHostChildHandle> {
  const proc = Bun.spawn([opts.bin, ...opts.args], {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdout: 'ignore',
    stderr: 'pipe',
    stdin: 'ignore',
  });

  let settled = false;
  const exited = new Promise<number | null>((resolve) => {
    void proc.exited.then((code) => {
      settled = true;
      resolve(code);
    });
  });

  return Promise.resolve({
    get pid() {
      return proc.pid;
    },
    get killed() {
      return proc.killed || settled;
    },
    get hasExited() {
      return settled;
    },
    kill(signal?: NodeJS.Signals | number) {
      try {
        proc.kill(signal ?? 'SIGTERM');
      } catch {
        // ignore
      }
    },
    exited,
  });
}
