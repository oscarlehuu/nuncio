import { Controller, Get, Post } from '@nestjs/common';
import { SubscriptionBridgeService } from './subscription-bridge.service';

@Controller('subscription-bridge')
export class SubscriptionBridgeController {
  constructor(private readonly bridge: SubscriptionBridgeService) {}

  @Get('status')
  status() {
    return this.bridge.status({ forceRefresh: true });
  }

  @Get('claude-code-env')
  claudeCodeEnv() {
    return this.bridge.claudeCodeEnv();
  }

  @Post('refresh')
  async refresh() {
    this.bridge.bustCache();
    return this.bridge.status({ forceRefresh: true });
  }
}
