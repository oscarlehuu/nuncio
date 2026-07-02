import { BadRequestException, Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { BrowserService } from './browser.service';
import type { BrowserInputDto } from './browser.types';

@Controller('sessions/:sessionId/browser')
export class BrowserController {
  constructor(private readonly browser: BrowserService) {}

  @Post('open')
  open(@Param('sessionId') sessionId: string, @Body() body: { url?: string }) {
    return this.browser.open(sessionId, body?.url);
  }

  @Get('state')
  state(@Param('sessionId') sessionId: string) {
    return this.browser.state(sessionId);
  }

  @Get('screenshot')
  async screenshot(@Param('sessionId') sessionId: string, @Res() res: Response) {
    const image = await this.browser.screenshot(sessionId);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(image);
  }

  @Post('input')
  input(@Param('sessionId') sessionId: string, @Body() body: BrowserInputDto) {
    if (!body || !['click', 'text', 'key', 'scroll'].includes((body as { type?: string }).type ?? '')) {
      throw new BadRequestException('Unknown browser input type');
    }
    return this.browser.input(sessionId, body);
  }
}
