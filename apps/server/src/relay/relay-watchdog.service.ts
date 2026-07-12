import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AttentionService } from '../attention/attention.service';
import { TailscaleService } from '../tailscale/tailscale.service';
import { RelayHealthService } from './relay-health.service';
import type { RelayPathHealth } from './relay.types';

const DEFAULT_INTERVAL_MS = 60_000;
type DownProbe = RelayPathHealth & { status: 'down' };

function isDownProbe(probe: RelayPathHealth): probe is DownProbe {
  return probe.status === 'down';
}

@Injectable()
export class RelayWatchdogService implements OnModuleInit, OnModuleDestroy {
  failureThreshold = 3;
  private failures = 0;
  private attentionRaised = false;
  private probing = false;
  private destroyed = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly health: RelayHealthService,
    private readonly tailscale: TailscaleService,
    private readonly attention: AttentionService,
  ) {}

  onModuleInit(): void {
    const configured = Number(process.env.NUNCIO_RELAY_WATCHDOG_INTERVAL_MS);
    const intervalMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_INTERVAL_MS;
    this.scheduleTick();
    this.timer = setInterval(() => this.scheduleTick(), intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.destroyed || this.probing) return;
    this.probing = true;
    try {
      const health = await this.health.probeAll();
      if (this.destroyed) return;
      const probe = health.funnel;
      if (probe.status === 'up') {
        this.clearFailure();
        return;
      }
      // Guardrail: neither healthy nor indeterminate observations can reach recovery.
      if (!isDownProbe(probe)) {
        this.failures = 0;
        return;
      }
      if (health.tailnet.status !== 'up') {
        this.recordFailure(probe, 'tailnet is not available');
        return;
      }
      await this.recoverDownFunnel(probe);
    } finally {
      this.probing = false;
    }
  }

  private scheduleTick(): void {
    void this.tick().catch((error) => {
      console.warn(`[relay] watchdog probe failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    });
  }

  private async recoverDownFunnel(probe: DownProbe): Promise<void> {
    if (this.destroyed) return;
    const port = Number(process.env.PORT ?? 3000);
    let enabled: Awaited<ReturnType<TailscaleService['enableFunnel']>>;
    try {
      enabled = await this.tailscale.enableFunnel(port);
    } catch (error) {
      this.recordFailure(probe, error instanceof Error ? error.message : 'recovery failed');
      return;
    }
    if (this.destroyed) return;
    if (enabled.ok) {
      const confirmed = await this.health.probeAll();
      if (confirmed.funnel.status === 'up') {
        this.clearFailure();
        return;
      }
    }
    this.recordFailure(probe, enabled.ok ? 'recovery could not be confirmed' : enabled.reason);
  }

  private recordFailure(probe: DownProbe, reason: string): void {
    this.failures += 1;
    if (this.failures < this.failureThreshold || this.attentionRaised) return;
    this.attentionRaised = true;
    this.attention.raise({
      kind: 'relay-down',
      subjectId: 'funnel',
      title: 'Public relay path is down',
      payload: {
        path: 'funnel', attempts: this.failures, reason,
        lastProbeAt: probe.probedAt,
      },
    });
  }

  private clearFailure(): void {
    this.failures = 0;
    this.attentionRaised = false;
    this.attention.onConditionCleared('relay-down', 'funnel');
  }
}
