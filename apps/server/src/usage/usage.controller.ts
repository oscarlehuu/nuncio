import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { UsageService } from './usage.service';
import {
  USAGE_PROVIDER_IDS,
  type UsageHistoryDto,
  type UsageProviderId,
  type UsageSnapshotDto,
} from './usage.types';

function isUsageProviderId(value: string): value is UsageProviderId {
  return (USAGE_PROVIDER_IDS as readonly string[]).includes(value);
}

function parseForceRefresh(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function parseDays(value: string | undefined): number {
  const parsed = value ? Number.parseInt(value, 10) : 90;
  if (!Number.isFinite(parsed)) return 90;
  return Math.max(1, Math.min(90, parsed));
}

@Controller('usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  list(@Query('forceRefresh') forceRefresh?: string): Promise<UsageSnapshotDto[]> {
    return this.usage.list({ forceRefresh: parseForceRefresh(forceRefresh) });
  }

  /** Must be registered before `:provider` so `history` is not captured as an id. */
  @Get('history')
  history(
    @Query('days') days?: string,
    @Query('forceRefresh') forceRefresh?: string,
  ): Promise<UsageHistoryDto> {
    return this.usage.history({
      days: parseDays(days),
      forceRefresh: parseForceRefresh(forceRefresh),
    });
  }

  @Get(':provider')
  get(
    @Param('provider') provider: string,
    @Query('forceRefresh') forceRefresh?: string,
  ): Promise<UsageSnapshotDto> {
    if (!isUsageProviderId(provider)) {
      throw new NotFoundException(`Unknown usage provider: ${provider}`);
    }
    return this.usage.get(provider, { forceRefresh: parseForceRefresh(forceRefresh) });
  }
}
