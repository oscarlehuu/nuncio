import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthTokenService } from './auth-token.service';
import { isAuthorizedRequest, type AuthRequestLike } from './auth-request';
import { deviceAuthDecision } from './device-token';
import { isLoopbackAddress } from '../terminal/loopback';
import { IS_PUBLIC_KEY } from './public.decorator';
import { TailscaleService } from '../tailscale/tailscale.service';
import { DevicesService } from '../devices/devices.service';

/**
 * Global guard over every /api route. Loopback requests pass with no token so
 * local use stays zero-config; tailnet peers owned by the same Tailscale
 * account pass via `tailscale whois` identity (when auto-trust is on); other
 * remote clients authenticate once via POST /api/auth/login (cookie) or a
 * per-request Bearer header. Routes with their own auth (webhook HMAC) opt
 * out with @Public().
 *
 * Precedence invariant: a presented device credential DECIDES the outcome — a
 * parseable `nd1.` bearer is verified and never falls back to broader
 * credentials, so an invalid/revoked device bearer 401s even alongside a valid
 * cookie. REST and WS agree on this ordering.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AuthTokenService,
    private readonly tailscale: TailscaleService,
    private readonly devices: DevicesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthRequestLike>();
    // Loopback is the owner's machine — always trusted, no credential needed.
    if (isLoopbackAddress(request.socket?.remoteAddress)) {
      return true;
    }
    // A presented device credential decides the outcome and never falls back to
    // the global token/cookie or tailnet branches below.
    const device = deviceAuthDecision(request, this.devices);
    if (device.kind === 'accept') {
      return true;
    }
    if (device.kind !== 'reject') {
      if (isAuthorizedRequest(request, this.tokens)) {
        return true;
      }
      if (await this.tailscale.isTrustedRemote(request.socket?.remoteAddress)) {
        return true;
      }
    }
    throw new UnauthorizedException('Access token required');
  }
}
