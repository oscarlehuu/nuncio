import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthTokenService } from './auth-token.service';
import { isAuthorizedRequest, type AuthRequestLike } from './auth-request';
import { IS_PUBLIC_KEY } from './public.decorator';
import { TailscaleService } from '../tailscale/tailscale.service';

/**
 * Global guard over every /api route. Loopback requests pass with no token so
 * local use stays zero-config; tailnet peers owned by the same Tailscale
 * account pass via `tailscale whois` identity (when auto-trust is on); other
 * remote clients authenticate once via POST /api/auth/login (cookie) or a
 * per-request Bearer header. Routes with their own auth (webhook HMAC) opt
 * out with @Public().
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AuthTokenService,
    private readonly tailscale: TailscaleService,
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
    if (isAuthorizedRequest(request, this.tokens)) {
      return true;
    }
    if (await this.tailscale.isTrustedRemote(request.socket?.remoteAddress)) {
      return true;
    }
    throw new UnauthorizedException('Access token required');
  }
}
