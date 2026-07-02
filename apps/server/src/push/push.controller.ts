import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { PushService } from './push.service';

interface RegisterBody {
  token?: unknown;
  platform?: unknown;
  deviceName?: unknown;
}

@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Post('register')
  register(@Body() body: RegisterBody): { ok: true } {
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) throw new BadRequestException('token is required');
    this.push.register(
      token,
      typeof body.platform === 'string' ? body.platform : undefined,
      typeof body.deviceName === 'string' ? body.deviceName : undefined,
    );
    return { ok: true };
  }

  @Post('unregister')
  unregister(@Body() body: RegisterBody): { ok: true } {
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) throw new BadRequestException('token is required');
    this.push.unregister(token);
    return { ok: true };
  }
}
