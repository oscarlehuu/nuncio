import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CliproxyChildHandle {
  pid: number;
  /**
   * True after a kill signal was sent (Bun/Node set this immediately).
   * Do not use this to decide whether to SIGKILL — use `hasExited`.
   */
  killed: boolean;
  /** True only after the process has actually exited. */
  hasExited: boolean;
  kill: (signal?: NodeJS.Signals | number) => void;
  exited: Promise<number | null>;
}

export type CliproxySpawnImpl = (opts: {
  bin: string;
  configPath: string;
  cwd: string;
}) => Promise<CliproxyChildHandle>;

/**
 * Supervises a Nuncio-owned CLIProxyAPI process (mode=managed).
 * External installs are never spawned here — case 1 stays out-of-process.
 */
@Injectable()
export class CliproxyManagedHost implements OnModuleDestroy {
  private readonly logger = new Logger(CliproxyManagedHost.name);
  private child: CliproxyChildHandle | null = null;
  private configPath: string | null = null;

  /** Overridable for unit tests. */
  spawnImpl: CliproxySpawnImpl = defaultSpawn;
  /** Grace period before SIGKILL after SIGTERM. Overridable for unit tests. */
  stopGraceMs = 2_000;

  isRunning(): boolean {
    return Boolean(this.child && !this.child.hasExited);
  }

  pid(): number | null {
    return this.isRunning() ? (this.child?.pid ?? null) : null;
  }

  activeConfigPath(): string | null {
    return this.isRunning() ? this.configPath : null;
  }

  async start(bin: string, configPath: string, opts?: { forceRestart?: boolean }): Promise<void> {
    if (this.isRunning()) {
      if (this.configPath === configPath && !opts?.forceRestart) return;
      await this.stop();
    }
    if (!existsSync(bin)) {
      throw new Error(`CLIProxyAPI binary not found: ${bin}`);
    }
    if (!existsSync(configPath)) {
      throw new Error(`CLIProxyAPI config not found: ${configPath}`);
    }

    this.child = await this.spawnImpl({
      bin,
      configPath,
      cwd: dirname(configPath),
    });
    this.configPath = configPath;
    const startedPid = this.child.pid;
    this.logger.log(`Started managed CLIProxyAPI pid=${startedPid} config=${configPath}`);

    void this.child.exited.then((code) => {
      // Ignore stale exit handlers after stop()/restart replaced the child.
      if (this.child?.pid !== startedPid) return;
      this.logger.warn(`Managed CLIProxyAPI exited code=${code}`);
      this.child = null;
      this.configPath = null;
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    // Detach first so a late `exited` from a timed-out kill cannot clear a newer child.
    this.child = null;
    this.configPath = null;
    try {
      if (!child.hasExited) child.kill('SIGTERM');
    } catch {
      // already gone
    }
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, this.stopGraceMs));
    await Promise.race([child.exited.then(() => undefined), timeout]);
    // `child.killed` is true as soon as SIGTERM was sent — only `hasExited` means the
    // process actually left. Guard SIGKILL on exit, not on the signal-sent flag.
    if (!child.hasExited) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      await child.exited.catch(() => undefined);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }
}

async function defaultSpawn(opts: {
  bin: string;
  configPath: string;
  cwd: string;
}): Promise<CliproxyChildHandle> {
  const proc = Bun.spawn([opts.bin, '--config', opts.configPath], {
    cwd: opts.cwd,
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

  return {
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
  };
}
