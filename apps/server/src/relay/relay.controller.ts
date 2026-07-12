import { Controller, Get, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { AuthRequestLike } from '../auth/auth-request';
import { bearerToken } from '../auth/auth-request';
import { parseDeviceBearer } from '../auth/device-token';
import { Public } from '../auth/public.decorator';
import { DevicesService } from '../devices/devices.service';
import { CandidateUrlsService, type RelayEndpoints } from '../pairing/candidate-urls.service';
import { ConnectionTicketService } from './connection-ticket.service';

export interface LiveRelayEndpoints extends RelayEndpoints {
  updatedAt: number;
}

@Public()
@Controller('relay')
export class RelayController {
  private now: () => number = () => Date.now();

  constructor(
    private readonly candidates: CandidateUrlsService,
    private readonly devices: DevicesService,
    private readonly tickets: ConnectionTicketService,
  ) {}

  setClock(now: () => number): void {
    this.now = now;
  }

  @Post('ticket')
  ticket(@Req() req: AuthRequestLike): { ticket: string; expiresAt: number } {
    const bearer = parseDeviceBearer(req.headers?.authorization);
    if (!bearer || !this.devices.verifyDevice(bearer.deviceId, bearer.secret)) {
      throw new UnauthorizedException('Device bearer token required');
    }
    return this.tickets.mint(bearer.deviceId);
  }

  @Get('endpoints')
  async endpoints(@Req() req: AuthRequestLike): Promise<LiveRelayEndpoints> {
    if (!this.authorize(req)) {
      throw new UnauthorizedException('Device bearer or connection ticket required');
    }
    const endpoints = await this.candidates.discover();
    return { ...endpoints, updatedAt: this.now() };
  }

  private authorize(req: AuthRequestLike): boolean {
    const device = parseDeviceBearer(req.headers?.authorization);
    if (device) return this.devices.verifyDevice(device.deviceId, device.secret);
    const ticket = bearerToken(req.headers?.authorization);
    return ticket !== null && this.tickets.verify(ticket, 'relay:endpoints') !== null;
  }
}
