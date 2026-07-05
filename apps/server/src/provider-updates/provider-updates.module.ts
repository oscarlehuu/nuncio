import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { ProviderUpdatesController } from './provider-updates.controller';
import { ProviderUpdatesService } from './provider-updates.service';

@Module({
  imports: [SettingsModule],
  controllers: [ProviderUpdatesController],
  providers: [ProviderUpdatesService],
})
export class ProviderUpdatesModule {}
