import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { SubscriptionBridgeController } from './subscription-bridge.controller';
import { CliproxyManagedHost } from './subscription-bridge.managed-host';
import { SubscriptionBridgeService } from './subscription-bridge.service';

@Module({
  imports: [SettingsModule],
  controllers: [SubscriptionBridgeController],
  providers: [CliproxyManagedHost, SubscriptionBridgeService],
  exports: [SubscriptionBridgeService],
})
export class SubscriptionBridgeModule {}
