import { Controller, Get } from '@nestjs/common';
import { TailscaleService } from './tailscale.service';
import type { TailscaleStatusDto } from './tailscale.types';

@Controller('tailscale')
export class TailscaleController {
  constructor(private readonly tailscale: TailscaleService) {}

  @Get('status')
  status(): Promise<TailscaleStatusDto> {
    return this.tailscale.status();
  }
}
