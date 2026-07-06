import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { BrowserBackend, BrowserInputDto, BrowserStateDto } from './browser.types';

type InAppBrowserDelegate = Omit<BrowserBackend, 'id' | 'isAvailable'> & {
  isAvailable?: () => boolean;
};

@Injectable()
export class InAppBrowserBackend implements BrowserBackend {
  readonly id = 'in_app' as const;
  private delegate: InAppBrowserDelegate | null = null;

  connect(delegate: InAppBrowserDelegate): void {
    this.delegate = delegate;
  }

  disconnect(delegate?: InAppBrowserDelegate): void {
    if (!delegate || this.delegate === delegate) this.delegate = null;
  }

  isAvailable(): boolean {
    return Boolean(this.delegate && (this.delegate.isAvailable?.() ?? true));
  }

  open(sessionId: string, url?: string): Promise<BrowserStateDto> {
    return this.requireDelegate().open(sessionId, url);
  }

  state(sessionId: string): Promise<BrowserStateDto> {
    return this.requireDelegate().state(sessionId);
  }

  screenshot(sessionId: string): Promise<Buffer> {
    return this.requireDelegate().screenshot(sessionId);
  }

  input(sessionId: string, input: BrowserInputDto): Promise<BrowserStateDto> {
    return this.requireDelegate().input(sessionId, input);
  }

  private requireDelegate(): InAppBrowserDelegate {
    if (!this.isAvailable() || !this.delegate) {
      throw new ServiceUnavailableException('Nuncio desktop in-app browser is not connected');
    }
    return this.delegate;
  }
}
