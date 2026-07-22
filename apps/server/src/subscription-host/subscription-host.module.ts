import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { SubscriptionHostController } from './subscription-host.controller';
import { SubscriptionHostManagedHost } from './subscription-host.managed-host';
import { SubscriptionHostService } from './subscription-host.service';

@Module({
  imports: [SettingsModule],
  controllers: [SubscriptionHostController],
  providers: [SubscriptionHostManagedHost, SubscriptionHostService],
  exports: [SubscriptionHostService],
})
export class SubscriptionHostModule {}
