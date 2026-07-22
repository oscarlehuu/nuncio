import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { hostname } from 'node:os';
import type { AuthRequestLike } from '../auth/auth-request';
import { Public } from '../auth/public.decorator';
import { DevicesService } from '../devices/devices.service';
import { CandidateUrlsService } from './candidate-urls.service';
import type { RelayEndpoints } from './candidate-urls.service';
import { PairingService } from './pairing.service';
import { FixedWindowRateLimiter } from './rate-limit';

/** claim is public (reachable over Funnel) so it is rate-limited per source address. */
const CLAIM_RATE = { max: 10, windowMs: 60_000 };

interface ClaimBody {
  code?: unknown;
  deviceName?: unknown;
  platform?: unknown;
}

@Controller('pairing')
export class PairingController {
  private readonly claimLimiter = new FixedWindowRateLimiter();

  constructor(
    private readonly pairing: PairingService,
    private readonly devices: DevicesService,
    private readonly candidateUrls: CandidateUrlsService,
  ) {}

  @Post('start')
  async start(): Promise<{
    code: string;
    expiresAt: number;
    urls: string[];
    hints: string[];
    endpoints: RelayEndpoints;
  }> {
    // Build the URLs BEFORE minting the code: minting invalidates any prior code,
    // so a slow/failed build must not leave a fresh code stranded on an error
    // response. build() is designed never to throw, but ordering keeps the
    // invariant even if that ever changes.
    const { urls, hints, endpoints } = await this.candidateUrls.build();
    const { code, expiresAt } = this.pairing.start();
    return { code, expiresAt, urls, hints, endpoints };
  }

  @Public()
  @Post('claim')
  claim(
    @Body() body: ClaimBody,
    @Req() req: AuthRequestLike,
  ): { deviceId: string; deviceSecret: string; serverName: string } {
    const key = req.socket?.remoteAddress ?? 'unknown';
    if (!this.claimLimiter.allow(key, CLAIM_RATE)) {
      throw new HttpException('Too many pairing attempts', HttpStatus.TOO_MANY_REQUESTS);
    }
    const reservation = this.pairing.reserve(body.code);
    if (!reservation) {
      throw new UnauthorizedException('Invalid or expired pairing code');
    }
    const deviceName = typeof body.deviceName === 'string' && body.deviceName.trim()
      ? body.deviceName.trim()
      : 'Paired device';
    const platform = typeof body.platform === 'string' ? body.platform : undefined;
    let created: ReturnType<DevicesService['create']>;
    try {
      created = this.devices.create(deviceName, platform);
    } catch (error) {
      this.pairing.rollback(reservation);
      throw error;
    }
    if (!this.pairing.commit(reservation)) {
      throw new Error('Pairing reservation was replaced before commit');
    }
    return { deviceId: created.id, deviceSecret: created.secret, serverName: hostname() };
  }
}
