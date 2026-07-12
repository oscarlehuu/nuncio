import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module';
import { TailscaleModule } from '../tailscale/tailscale.module';
import { CandidateUrlsService } from './candidate-urls.service';
import { PairingController } from './pairing.controller';
import { PairingService } from './pairing.service';

@Module({
  imports: [DevicesModule, TailscaleModule],
  controllers: [PairingController],
  providers: [PairingService, CandidateUrlsService],
  exports: [CandidateUrlsService],
})
export class PairingModule {}
