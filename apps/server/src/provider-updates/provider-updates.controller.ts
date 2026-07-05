import { BadRequestException, Controller, Get, Param, Post } from '@nestjs/common';
import { ProviderUpdatesService } from './provider-updates.service';
import type { ProviderToolId } from './provider-updates.types';

@Controller('provider-updates')
export class ProviderUpdatesController {
  constructor(private readonly providerUpdates: ProviderUpdatesService) {}

  @Get()
  list() {
    return this.providerUpdates.list();
  }

  @Post(':provider/update')
  update(@Param('provider') provider: string) {
    if (!isProviderToolId(provider)) {
      throw new BadRequestException(`Unknown provider tool: ${provider}`);
    }
    return this.providerUpdates.update(provider);
  }
}

function isProviderToolId(provider: string): provider is ProviderToolId {
  return provider === 'pi' || provider === 'codex';
}
