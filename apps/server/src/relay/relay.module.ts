import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DevicesModule } from '../devices/devices.module';
import { PairingModule } from '../pairing/pairing.module';
import { ConnectionTicketService } from './connection-ticket.service';
import { RelayController } from './relay.controller';

@Module({
  imports: [AuthModule, DevicesModule, PairingModule],
  controllers: [RelayController],
  providers: [ConnectionTicketService],
  exports: [ConnectionTicketService],
})
export class RelayModule {}
