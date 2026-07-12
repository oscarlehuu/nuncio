import { Module } from '@nestjs/common';
import { AttentionModule } from '../attention/attention.module';
import { TailscaleModule } from '../tailscale/tailscale.module';
import { RelayHealthService } from './relay-health.service';
import { RelayWatchdogService } from './relay-watchdog.service';
import { RelayController } from './relay.controller';

@Module({
  imports: [TailscaleModule, AttentionModule],
  controllers: [RelayController],
  providers: [RelayHealthService, RelayWatchdogService],
  exports: [RelayHealthService],
})
export class RelayModule {}
