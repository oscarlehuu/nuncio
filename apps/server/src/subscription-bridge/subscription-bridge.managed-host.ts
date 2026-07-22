import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnWithParentControl } from './subscription-bridge.process-launcher';

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

interface StartFlight {
  key: string;
  stopGeneration: number;
  promise: Promise<void>;
}

/**
 * Supervises a Nuncio-owned CLIProxyAPI process (mode=managed).
 * External installs are never spawned here — case 1 stays out-of-process.
 */
@Injectable()
export class CliproxyManagedHost implements OnModuleDestroy {
  private readonly logger = new Logger(CliproxyManagedHost.name);
  private child: CliproxyChildHandle | null = null;
  private configPath: string | null = null;
  private lifecycleChain: Promise<void> = Promise.resolve();
  private startFlight: StartFlight | null = null;
  private stopGeneration = 0;

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

  start(bin: string, configPath: string, opts?: { forceRestart?: boolean }): Promise<void> {
    const key = JSON.stringify([bin, configPath, opts?.forceRestart === true]);
    const stopGeneration = this.stopGeneration;
    if (
      this.startFlight?.key === key &&
      this.startFlight.stopGeneration === stopGeneration
    ) {
      return this.startFlight.promise;
    }

    const promise = this.enqueueLifecycle(() => this.startOwned(bin, configPath, opts));
    const flight: StartFlight = { key, stopGeneration, promise };
    this.startFlight = flight;
    void promise.then(
      () => {
        if (this.startFlight === flight) this.startFlight = null;
      },
      () => {
        if (this.startFlight === flight) this.startFlight = null;
      },
    );
    return promise;
  }

  stop(): Promise<void> {
    this.stopGeneration += 1;
    return this.enqueueLifecycle(() => this.stopOwned());
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleChain.then(operation, operation);
    this.lifecycleChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async startOwned(
    bin: string,
    configPath: string,
    opts?: { forceRestart?: boolean },
  ): Promise<void> {
    if (this.isRunning()) {
      if (this.configPath === configPath && !opts?.forceRestart) return;
      await this.stopOwned();
    }
    if (!existsSync(bin)) {
      throw new Error(`CLIProxyAPI binary not found: ${bin}`);
    }
    if (!existsSync(configPath)) {
      throw new Error(`CLIProxyAPI config not found: ${configPath}`);
    }

    const child = await this.spawnImpl({
      bin,
      configPath,
      cwd: dirname(configPath),
    });
    this.child = child;
    this.configPath = configPath;
    this.logger.log(`Started managed CLIProxyAPI pid=${child.pid} config=${configPath}`);

    void child.exited.then(
      (code) => this.clearExitedChild(child, `code=${code}`),
      (error) =>
        this.clearExitedChild(
          child,
          `observation failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  }

  private clearExitedChild(child: CliproxyChildHandle, detail: string): void {
    if (this.child !== child) return;
    this.logger.warn(`Managed CLIProxyAPI exited ${detail}`);
    this.child = null;
    this.configPath = null;
  }

  private async stopOwned(): Promise<void> {
    const child = this.child;
    if (!child) return;
    // Detach first so a late exit from this child cannot clear a later start.
    this.child = null;
    this.configPath = null;
    try {
      if (!child.hasExited) child.kill('SIGTERM');
    } catch {
      // already gone
    }
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, this.stopGraceMs));
    const observedExit = child.exited.then(
      () => undefined,
      () => undefined,
    );
    await Promise.race([observedExit, timeout]);
    // `killed` flips on signal delivery; only `hasExited` proves the child left.
    if (!child.hasExited) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
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
  return spawnWithParentControl(opts);
}
