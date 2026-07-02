import { Body, Controller, Post } from '@nestjs/common';
import { ProvisionService } from './provision.service';
import type { ProvisionPayload } from './provision.types';

/** Both routes sit behind the global AuthGuard — loopback, token, or
 * same-account tailnet identity. Server-to-server pushes arrive from the
 * source machine's tailscale address and pass via whois trust. */
@Controller('provision')
export class ProvisionController {
  constructor(private readonly provision: ProvisionService) {}

  @Post()
  apply(@Body() payload: ProvisionPayload) {
    return this.provision.apply(payload);
  }

  @Post('push')
  push(@Body() body: { target?: unknown }) {
    return this.provision.push(typeof body?.target === 'string' ? body.target : '');
  }
}
