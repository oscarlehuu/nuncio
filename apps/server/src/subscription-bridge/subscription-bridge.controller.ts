import { Body, Controller, Get, Post } from '@nestjs/common';
import { SubscriptionBridgeService } from './subscription-bridge.service';
import type {
  AdoptExternalDto,
  InitManagedDto,
  MigrateManagedDto,
} from './subscription-bridge.types';

@Controller('subscription-bridge')
export class SubscriptionBridgeController {
  constructor(private readonly bridge: SubscriptionBridgeService) {}

  @Get('status')
  status() {
    return this.bridge.status({ forceRefresh: true });
  }

  @Get('discover')
  discover() {
    return { installs: this.bridge.discover() };
  }

  /**
   * Explicit user action (Copy Claude Code env). POST so a casual GET cannot
   * scrape the CLIProxyAPI API key the way Settings never returns raw secrets.
   */
  @Post('claude-code-env')
  claudeCodeEnv() {
    return this.bridge.claudeCodeEnv();
  }

  @Post('refresh')
  async refresh() {
    this.bridge.bustCache();
    return this.bridge.status({ forceRefresh: true });
  }

  /** Case 1 — point Nuncio at an already-running / self-hosted CLIProxyAPI. */
  @Post('adopt-external')
  adoptExternal(@Body() body: AdoptExternalDto) {
    return this.bridge.adoptExternal(body ?? { configPath: '' });
  }

  /** Case 2 — copy an existing config into Nuncio-managed cliproxyapi-nuncio. */
  @Post('migrate-managed')
  migrateManaged(@Body() body: MigrateManagedDto) {
    return this.bridge.migrateManaged(body ?? { configPath: '' });
  }

  /** Case 3 — fresh managed config + start. */
  @Post('init-managed')
  initManaged(@Body() body: InitManagedDto) {
    return this.bridge.initManaged(body ?? {});
  }

  @Post('managed/start')
  startManaged() {
    return this.bridge.startManaged();
  }

  @Post('managed/stop')
  stopManaged() {
    return this.bridge.stopManaged();
  }
}
