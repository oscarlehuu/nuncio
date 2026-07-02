import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthTokenService } from './auth-token.service';
import { AUTH_COOKIE_NAME, isAuthorizedRequest, type AuthRequestLike } from './auth-request';
import { Public } from './public.decorator';
import { TailscaleService } from '../tailscale/tailscale.service';

const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

interface CookieResponseLike {
  cookie(name: string, value: string, options: Record<string, unknown>): void;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly tokens: AuthTokenService,
    private readonly tailscale: TailscaleService,
  ) {}

  @Public()
  @Post('login')
  login(
    @Body() body: { token?: unknown },
    @Req() req: AuthRequestLike & { secure?: boolean },
    @Res({ passthrough: true }) res: CookieResponseLike,
  ) {
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!this.tokens.isValidToken(token)) {
      throw new UnauthorizedException('Invalid access token');
    }
    // HttpOnly keeps the token away from page scripts; SameSite=Lax blocks
    // cross-site POSTs from carrying it (the CSRF control for cookie auth).
    res.cookie(AUTH_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE_MS,
      secure: req.secure === true,
    });
    return { ok: true };
  }

  @Public()
  @Get('status')
  async status(@Req() req: AuthRequestLike) {
    const authenticated =
      isAuthorizedRequest(req, this.tokens) ||
      (await this.tailscale.isTrustedRemote(req.socket?.remoteAddress));
    return { authenticated };
  }

  /** Guarded (non-public): lets an already-authenticated client read the token
   * to hand it to another device — the Remote access settings section. */
  @Get('token')
  token() {
    return { token: this.tokens.token, source: this.tokens.source };
  }
}
