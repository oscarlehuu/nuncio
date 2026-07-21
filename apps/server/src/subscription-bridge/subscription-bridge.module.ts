import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { SubscriptionBridgeController } from './subscription-bridge.controller';
import { SubscriptionBridgeService } from './subscription-bridge.service';

@Module({
  imports: [SettingsModule],
  controllers: [SubscriptionBridgeController],
  providers: [SubscriptionBridgeService],
  exports: [SubscriptionBridgeService],
})
export class SubscriptionBridgeModule {}
