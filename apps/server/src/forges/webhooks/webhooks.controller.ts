import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ForgeRegistry } from '../forges.registry';
import { WebhooksService } from './webhooks.service';

/**
 * Public, signature-verified inbound webhook endpoint. Requires the raw request
 * body (enabled via `rawBody: true` in main.ts) so the HMAC is computed over the
 * exact bytes GitHub/GitLab signed. Responds 202 fast; 401 on a bad signature.
 */
@Controller('webhooks/forge')
export class WebhooksController {
  constructor(
    private readonly registry: ForgeRegistry,
    private readonly webhooks: WebhooksService,
  ) {}

  @Post(':provider')
  @HttpCode(202)
  async receive(
    @Param('provider') providerId: string,
    @Headers() headers: Record<string, string | undefined>,
    @Body() payload: unknown,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const provider = this.registry.get(providerId);
    const rawBody = req.rawBody?.toString('utf8') ?? '';

    if (!provider.verifyWebhookSignature(headers, rawBody)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const event = provider.parseWebhookEvent(headers, payload);
    if (!event) return { ok: true, ignored: true };

    const result = await this.webhooks.handleEvent(providerId, event);
    return { ok: true, ...result };
  }
}
