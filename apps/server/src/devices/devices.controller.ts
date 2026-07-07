import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthRequestLike } from '../auth/auth-request';
import { parseDeviceBearer } from '../auth/device-token';
import { Public } from '../auth/public.decorator';
import { DevicesService, type DeviceSummary } from './devices.service';

@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  list(): DeviceSummary[] {
    return this.devices.list();
  }

  @Delete(':id')
  revoke(@Param('id') id: string): { ok: true } {
    this.devices.revoke(id);
    return { ok: true };
  }

  /**
   * Device-bearer callers ONLY: rotation must prove possession of the current
   * secret, so this route is exempt from the global guard (which would trust
   * loopback / the global token / a tailnet peer) and authenticates the caller
   * itself via the `nd1.` bearer.
   */
  @Public()
  @Post('rotate')
  rotate(@Req() req: AuthRequestLike): { deviceId: string; deviceSecret: string } {
    const bearer = parseDeviceBearer(req.headers?.authorization);
    if (!bearer || !this.devices.verifyDevice(bearer.deviceId, bearer.secret)) {
      throw new UnauthorizedException('Device bearer token required');
    }
    const rotated = this.devices.rotate(bearer.deviceId, bearer.secret);
    if (!rotated) {
      throw new UnauthorizedException('Device bearer token required');
    }
    return { deviceId: rotated.id, deviceSecret: rotated.secret };
  }
}
