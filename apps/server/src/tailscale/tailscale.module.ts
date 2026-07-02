import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { TailscaleController } from './tailscale.controller';
import { TailscaleService } from './tailscale.service';

@Module({
  imports: [SettingsModule],
  controllers: [TailscaleController],
  providers: [TailscaleService],
  exports: [TailscaleService],
})
export class TailscaleModule {}
