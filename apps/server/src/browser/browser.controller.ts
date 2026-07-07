import { BadRequestException, Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { BrowserToolService } from './browser-tool.service';
import type { BrowserInputDto, BrowserTargetPreference } from './browser.types';

@Controller('sessions/:sessionId/browser')
export class BrowserController {
  constructor(private readonly browser: BrowserToolService) {}

  @Post('open')
  open(@Param('sessionId') sessionId: string, @Body() body: { url?: string; target?: BrowserTargetPreference }) {
    return this.browser.open(sessionId, body?.url, { target: body?.target });
  }

  @Get('state')
  state(@Param('sessionId') sessionId: string, @Query() query: { target?: BrowserTargetPreference }) {
    return this.browser.state(sessionId, { target: query?.target });
  }

  @Get('screenshot')
  async screenshot(
    @Param('sessionId') sessionId: string,
    @Query() query: { target?: BrowserTargetPreference },
    @Res() res: Response,
  ) {
    const image = await this.browser.screenshot(sessionId, { target: query?.target });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(image);
  }

  @Post('input')
  input(@Param('sessionId') sessionId: string, @Body() body: BrowserInputDto & { target?: BrowserTargetPreference }) {
    if (!body || !['click', 'text', 'key', 'scroll'].includes((body as { type?: string }).type ?? '')) {
      throw new BadRequestException('Unknown browser input type');
    }
    const { target: _target, ...input } = body;
    return this.browser.input(sessionId, input as BrowserInputDto, { target: body.target });
  }
}
