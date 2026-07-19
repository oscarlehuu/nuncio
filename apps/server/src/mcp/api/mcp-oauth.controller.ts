import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../auth/public.decorator';
import { McpOAuthService } from '../oauth/mcp-oauth.service';

/** Public OAuth callback — browser lands here after the user authorizes. */
@Controller('mcp/oauth')
export class McpOAuthController {
  constructor(private readonly oauth: McpOAuthService) {}

  @Public()
  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Res() res: Response,
  ) {
    if (!code?.trim() || !state?.trim()) {
      return res.redirect('/?mcp_oauth=error');
    }
    try {
      await this.oauth.finish(state.trim(), code.trim());
      return res.redirect('/?mcp_oauth=ok');
    } catch {
      return res.redirect('/?mcp_oauth=error');
    }
  }
}
