import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CliproxyChildHandle {
  pid: number;
  killed: boolean;
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

  isRunning(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  pid(): number | null {
    return this.isRunning() ? (this.child?.pid ?? null) : null;
  }

  activeConfigPath(): string | null {
    return this.isRunning() ? this.configPath : null;
  }

  async start(bin: string, configPath: string): Promise<void> {
    if (this.isRunning()) {
      if (this.configPath === configPath) return;
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
    this.logger.log(`Started managed CLIProxyAPI pid=${this.child.pid} config=${configPath}`);

    void this.child.exited.then((code) => {
      if (this.child?.pid === undefined) return;
      this.logger.warn(`Managed CLIProxyAPI exited code=${code}`);
      this.child = null;
      this.configPath = null;
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      if (!child.killed) child.kill('SIGTERM');
    } catch {
      // already gone
    }
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    await Promise.race([child.exited.then(() => undefined), timeout]);
    if (!child.killed) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    this.child = null;
    this.configPath = null;
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
