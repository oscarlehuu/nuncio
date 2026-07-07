import { Injectable } from '@nestjs/common';
import { BrowserService } from './browser.service';
import type { BrowserBackend, BrowserInputDto, BrowserStateDto } from './browser.types';

@Injectable()
export class ExternalBrowserBackend implements BrowserBackend {
  readonly id = 'external' as const;

  constructor(private readonly browser: BrowserService) {}

  isAvailable(): boolean {
    return true;
  }

  open(sessionId: string, url?: string): Promise<BrowserStateDto> {
    return this.browser.open(sessionId, url);
  }

  state(sessionId: string): Promise<BrowserStateDto> {
    return this.browser.state(sessionId);
  }

  screenshot(sessionId: string): Promise<Buffer> {
    return this.browser.screenshot(sessionId);
  }

  input(sessionId: string, input: BrowserInputDto): Promise<BrowserStateDto> {
    return this.browser.input(sessionId, input);
  }
}
