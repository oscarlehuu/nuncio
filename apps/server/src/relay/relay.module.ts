import { Module } from '@nestjs/common';
import { AttentionModule } from '../attention/attention.module';
import { AuthModule } from '../auth/auth.module';
import { DevicesModule } from '../devices/devices.module';
import { PairingModule } from '../pairing/pairing.module';
import { TailscaleModule } from '../tailscale/tailscale.module';
import { ConnectionTicketService } from './connection-ticket.service';
import { RelayHealthService } from './relay-health.service';
import { RelayWatchdogService } from './relay-watchdog.service';
import { RelayController } from './relay.controller';

@Module({
  imports: [AuthModule, DevicesModule, PairingModule, TailscaleModule, AttentionModule],
  controllers: [RelayController],
  providers: [ConnectionTicketService, RelayHealthService, RelayWatchdogService],
  exports: [ConnectionTicketService, RelayHealthService],
})
export class RelayModule {}
