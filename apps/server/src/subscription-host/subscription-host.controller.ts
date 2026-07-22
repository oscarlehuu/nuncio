import { Controller, Get, Post } from '@nestjs/common';
import { SubscriptionHostService } from './subscription-host.service';

@Controller('subscription-host')
export class SubscriptionHostController {
  constructor(private readonly host: SubscriptionHostService) {}

  @Get('status')
  status() {
    return this.host.status({ forceRefresh: true });
  }

  /** Reinstall (if the pin changed) + restart the supervised broker/router pair. */
  @Post('restart')
  restart() {
    return this.host.restart();
  }
}
