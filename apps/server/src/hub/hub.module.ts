import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { TailscaleModule } from '../tailscale/tailscale.module';
import { HubController } from './hub.controller';
import { HubService } from './hub.service';
import { HubRegistryService } from './hub-registry.service';

@Module({
  imports: [SettingsModule, TailscaleModule],
  controllers: [HubController],
  providers: [HubService, HubRegistryService],
  exports: [HubService, HubRegistryService],
})
export class HubModule {}
