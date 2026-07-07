import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { BrowserToolService } from '../../../src/browser/browser-tool.service';
import { InAppBrowserBackend } from '../../../src/browser/in-app-browser.backend';
import type {
  BrowserBackend,
  BrowserResolvedTarget,
  BrowserToolStateDto,
} from '../../../src/browser/browser.types';
import type { SettingsService } from '../../../src/settings/settings.service';

function stateFor(target: BrowserResolvedTarget, url = 'https://example.com/'): BrowserToolStateDto {
  return {
    connected: true,
    url,
    title: target,
    loading: false,
    screenshotVersion: 1,
    target,
  };
}

function fakeBackend(target: BrowserResolvedTarget): BrowserBackend & {
  calls: string[];
  availableValue: boolean;
} {
  const backend = {
    id: target,
    calls: [] as string[],
    availableValue: true,
    isAvailable() {
      return this.availableValue;
    },
    async open(_sessionId: string, url?: string) {
      this.calls.push(`open:${url ?? ''}`);
      return stateFor(target, url ?? 'about:blank');
    },
    async state() {
      this.calls.push('state');
      return stateFor(target);
    },
    async screenshot() {
      this.calls.push('screenshot');
      return Buffer.from(target);
    },
    async input() {
      this.calls.push('input');
      return stateFor(target);
    },
  };
  return backend;
}

describe('BrowserToolService', () => {
  function settings(defaultTarget?: string): SettingsService {
    return {
      resolve: (key: string) => (key === 'NUNCIO_BROWSER_DEFAULT_TARGET' ? defaultTarget : undefined),
    } as unknown as SettingsService;
  }

  it('routes auto browser calls to the in-app backend when desktop is connected', async () => {
    const inApp = new InAppBrowserBackend();
    const inAppBackend = fakeBackend('in_app');
    const external = fakeBackend('external');
    inApp.connect(inAppBackend);
    const service = new BrowserToolService(external, inApp);

    const state = await service.open('s1', 'https://example.com', { target: 'auto' });

    expect(state.target).toBe('in_app');
    expect(inAppBackend.calls).toEqual(['open:https://example.com']);
    expect(external.calls).toEqual([]);
  });

  it('uses the configured default browser target when target is omitted', async () => {
    const inApp = new InAppBrowserBackend();
    const inAppBackend = fakeBackend('in_app');
    const external = fakeBackend('external');
    inApp.connect(inAppBackend);
    const service = new BrowserToolService(external, inApp, settings('external'));

    const state = await service.open('s1', 'https://example.com');

    expect(state.target).toBe('external');
    expect(external.calls).toEqual(['open:https://example.com']);
    expect(inAppBackend.calls).toEqual([]);
  });

  it('lets explicit browser targets override the configured default', async () => {
    const inApp = new InAppBrowserBackend();
    const inAppBackend = fakeBackend('in_app');
    const external = fakeBackend('external');
    inApp.connect(inAppBackend);
    const service = new BrowserToolService(external, inApp, settings('external'));

    const state = await service.open('s1', 'https://example.com', { target: 'in_app' });

    expect(state.target).toBe('in_app');
    expect(inAppBackend.calls).toEqual(['open:https://example.com']);
    expect(external.calls).toEqual([]);
  });

  it('falls back to auto when the configured default browser target is invalid', async () => {
    const inApp = new InAppBrowserBackend();
    const inAppBackend = fakeBackend('in_app');
    const external = fakeBackend('external');
    inApp.connect(inAppBackend);
    const service = new BrowserToolService(external, inApp, settings('personal-chrome'));

    const state = await service.open('s1', 'https://example.com');

    expect(state.target).toBe('in_app');
    expect(inAppBackend.calls).toEqual(['open:https://example.com']);
    expect(external.calls).toEqual([]);
  });

  it('falls back to the external backend when auto is requested and in-app is unavailable', async () => {
    const inApp = new InAppBrowserBackend();
    const external = fakeBackend('external');
    const service = new BrowserToolService(external, inApp);

    const state = await service.open('s1', 'example.com');

    expect(state.target).toBe('external');
    expect(external.calls).toEqual(['open:example.com']);
  });

  it('fails explicit in-app requests when the desktop backend is unavailable', async () => {
    const service = new BrowserToolService(fakeBackend('external'), new InAppBrowserBackend());

    await expect(service.open('s1', 'example.com', { target: 'in_app' })).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('keeps auto follow-up calls on the session-selected backend', async () => {
    const inApp = new InAppBrowserBackend();
    const inAppBackend = fakeBackend('in_app');
    const external = fakeBackend('external');
    inApp.connect(inAppBackend);
    const service = new BrowserToolService(external, inApp);

    await service.open('s1', 'https://example.com', { target: 'external' });
    await service.input('s1', { type: 'click', x: 10, y: 20 });
    const screenshot = await service.screenshot('s1');

    expect(inAppBackend.calls).toEqual([]);
    expect(external.calls).toEqual(['open:https://example.com', 'input', 'screenshot']);
    expect(screenshot.toString()).toBe('external');
  });

  it('executes stable browser tool names for MCP/provider adapters', async () => {
    const service = new BrowserToolService(fakeBackend('external'), new InAppBrowserBackend());

    const result = await service.execute('browser_open', {
      sessionId: 's1',
      url: 'example.com',
      target: 'external',
    });

    expect(result).toMatchObject({
      type: 'state',
      state: { target: 'external', url: 'example.com' },
    });
  });

  it('rejects unknown browser tool calls', async () => {
    const service = new BrowserToolService(fakeBackend('external'), new InAppBrowserBackend());

    await expect(service.execute('browser_drag', { sessionId: 's1' })).rejects.toThrow(BadRequestException);
  });
});
