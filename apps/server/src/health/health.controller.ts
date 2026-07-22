import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';

const SMOKE_NONCE_PATTERN = /^[a-f0-9]{64}$/;

type HealthEnvironment = Readonly<Record<string, string | undefined>>;

export function buildHealthResponse(env: HealthEnvironment = process.env) {
  const health = { status: 'ok', service: 'nuncio-server' } as const;
  const smokeNonce = env.NUNCIO_DESKTOP_SMOKE_NONCE;
  if (!smokeNonce || !SMOKE_NONCE_PATTERN.test(smokeNonce)) return health;
  return { ...health, smokeNonce };
}

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  getHealth() {
    return buildHealthResponse();
  }
}
