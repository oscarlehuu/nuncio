import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserService, type BrowserPageClient } from '../../../src/browser/browser.service';
import type { DatabaseService } from '../../../src/db/database.service';

function fakeClient(overrides: Partial<BrowserPageClient> = {}): BrowserPageClient {
  return {
    navigate: jest.fn(async () => undefined),
    state: jest.fn(async () => ({
      connected: true,
      url: 'https://example.com/',
      title: 'Example',
      loading: false,
      screenshotVersion: 0,
    })),
    screenshot: jest.fn(async () => Buffer.from('png')),
    click: jest.fn(async () => undefined),
    typeText: jest.fn(async () => undefined),
    pressKey: jest.fn(async () => undefined),
    scroll: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe('BrowserService', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nuncio-browser-data-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.NUNCIO_BROWSER_PROFILE_DIR;
    delete process.env.NUNCIO_CHROME_BIN;
  });

  it('uses a persistent Nuncio-owned Chrome profile under the data directory', () => {
    const service = new BrowserService({ dataDir } as DatabaseService);

    expect(service.profileDir()).toBe(join(dataDir, 'browser', 'chrome-profile'));
  });

  it('allows an explicit persistent profile directory override', () => {
    process.env.NUNCIO_BROWSER_PROFILE_DIR = join(dataDir, 'custom-profile');
    const service = new BrowserService({ dataDir } as DatabaseService);

    expect(service.profileDir()).toBe(join(dataDir, 'custom-profile'));
  });

  it('launches Chrome with remote debugging and the persistent user-data-dir', async () => {
    const service = new BrowserService({ dataDir } as DatabaseService);
    const launched: { command?: string; args?: string[] } = {};
    const page = fakeClient();
    service.chromeBinary = () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    service.allocatePort = async () => 9333;
    service.waitForDebugger = async () => undefined;
    service.spawnChrome = (command, args) => {
      launched.command = command;
      launched.args = args;
      return { kill: jest.fn() };
    };
    service.createTarget = async () => ({
      id: 'target-1',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/target-1',
    });
    service.clientFactory = async () => page;

    await service.open('session-1', 'example.com');

    expect(launched.command).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(launched.args).toContain('--remote-debugging-port=9333');
    expect(launched.args).toContain('--remote-debugging-address=127.0.0.1');
    expect(launched.args).toContain(`--user-data-dir=${join(dataDir, 'browser', 'chrome-profile')}`);
    expect(launched.args).toContain('--headless=new');
    expect(launched.args).toContain('--disable-gpu');
    expect(launched.args).toContain('--no-first-run');
    expect(launched.args).toContain('--no-default-browser-check');
    expect(page.navigate).toHaveBeenCalledWith('https://example.com');
  });

  it('explains profile lock failures when Chrome debugging never becomes available', async () => {
    const service = new BrowserService({ dataDir } as DatabaseService);
    const kill = jest.fn();
    mkdirSync(service.profileDir(), { recursive: true });
    symlinkSync('host-12345', join(service.profileDir(), 'SingletonLock'));
    service.allocatePort = async () => 9333;
    service.waitForDebugger = async () => {
      throw new Error('not ready');
    };
    service.spawnChrome = () => ({ kill });

    await expect(service.open('session-1', 'example.com')).rejects.toThrow(
      /Nuncio browser profile appears to be in use/,
    );
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('reuses the same tab client for a session', async () => {
    const service = new BrowserService({ dataDir } as DatabaseService);
    const page = fakeClient();
    let targetCount = 0;
    service.allocatePort = async () => 9333;
    service.waitForDebugger = async () => undefined;
    service.spawnChrome = () => ({ kill: jest.fn() });
    service.createTarget = async () => {
      targetCount += 1;
      return { id: `target-${targetCount}`, webSocketDebuggerUrl: `ws://target-${targetCount}` };
    };
    service.clientFactory = async () => page;

    await service.open('session-1', 'https://example.com');
    await service.open('session-1', 'https://openai.com');

    expect(targetCount).toBe(1);
    expect(page.navigate).toHaveBeenCalledTimes(2);
    expect(page.navigate).toHaveBeenLastCalledWith('https://openai.com');
  });

  it('forwards click, text, key, and scroll input to the session tab', async () => {
    const service = new BrowserService({ dataDir } as DatabaseService);
    const page = fakeClient();
    service.allocatePort = async () => 9333;
    service.waitForDebugger = async () => undefined;
    service.spawnChrome = () => ({ kill: jest.fn() });
    service.createTarget = async () => ({ id: 'target-1', webSocketDebuggerUrl: 'ws://target-1' });
    service.clientFactory = async () => page;

    await service.open('session-1', 'https://example.com');
    await service.input('session-1', { type: 'click', x: 10, y: 20 });
    await service.input('session-1', { type: 'text', text: 'hello' });
    await service.input('session-1', { type: 'key', key: 'Enter', code: 'Enter' });
    await service.input('session-1', { type: 'scroll', x: 1, y: 2, deltaX: 0, deltaY: 120 });

    expect(page.click).toHaveBeenCalledWith(10, 20);
    expect(page.typeText).toHaveBeenCalledWith('hello');
    expect(page.pressKey).toHaveBeenCalledWith({ type: 'key', key: 'Enter', code: 'Enter' });
    expect(page.scroll).toHaveBeenCalledWith(1, 2, 0, 120);
  });
});
