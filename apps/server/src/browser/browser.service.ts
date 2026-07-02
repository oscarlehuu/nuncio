import { BadRequestException, Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { execFile, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync } from 'node:fs';
import net from 'node:net';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseService } from '../db/database.service';
import { CdpPageClient } from './browser-cdp.client';
import type { BrowserInputDto, BrowserKeyInputDto, BrowserStateDto, BrowserTargetDto } from './browser.types';

const execFileAsync = promisify(execFile);
const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'] as const;

type ManagedProcess = {
  kill(signal?: NodeJS.Signals | number): unknown;
};

export interface BrowserPageClient {
  navigate(url: string): Promise<void>;
  state(): Promise<BrowserStateDto>;
  screenshot(): Promise<Buffer>;
  click(x: number, y: number): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKey(input: BrowserKeyInputDto): Promise<void>;
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  close?(): void;
}

interface SessionPage {
  targetId: string;
  client: BrowserPageClient;
}

@Injectable()
export class BrowserService implements OnModuleDestroy {
  private chromeProcess: ManagedProcess | null = null;
  private remotePort: number | null = null;
  private readonly pages = new Map<string, SessionPage>();

  constructor(private readonly database: DatabaseService) {}

  chromeBinary = (): string => {
    const configured = process.env.NUNCIO_CHROME_BIN?.trim();
    if (configured) return configured;
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/opt/homebrew/bin/chromium',
      '/usr/local/bin/chromium',
      '/usr/bin/google-chrome',
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? 'google-chrome';
  };

  allocatePort = () => findFreePort();

  spawnChrome = (command: string, args: string[]): ManagedProcess => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.unref();
    return child;
  };

  waitForDebugger = (port: number) => waitForDebugger(port);

  reclaimLockedProfile = (profileDir: string): Promise<void> => reclaimLockedProfile(profileDir);

  createTarget = async (port: number, url: string): Promise<BrowserTargetDto> => {
    const targetUrl = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`;
    let response = await fetch(targetUrl, { method: 'PUT' });
    if (!response.ok) response = await fetch(targetUrl);
    if (!response.ok) throw new Error(`Chrome target creation failed (${response.status})`);
    const target = (await response.json()) as Partial<BrowserTargetDto>;
    if (!target.id || !target.webSocketDebuggerUrl) {
      throw new Error('Chrome target response did not include a websocket URL');
    }
    return { id: target.id, webSocketDebuggerUrl: target.webSocketDebuggerUrl };
  };

  clientFactory = (target: BrowserTargetDto): Promise<BrowserPageClient> =>
    CdpPageClient.connect(target.webSocketDebuggerUrl);

  profileDir(): string {
    const configured = process.env.NUNCIO_BROWSER_PROFILE_DIR?.trim();
    return resolve(configured || join(this.database.dataDir, 'browser', 'chrome-profile'));
  }

  async open(sessionId: string, url?: string): Promise<BrowserStateDto> {
    const normalizedUrl = normalizeBrowserUrl(url);
    const port = await this.ensureChrome();
    let page = this.pages.get(sessionId);
    if (!page) {
      const target = await this.createTarget(port, normalizedUrl);
      page = {
        targetId: target.id,
        client: await this.clientFactory(target),
      };
      this.pages.set(sessionId, page);
    }
    await page.client.navigate(normalizedUrl);
    return page.client.state();
  }

  async state(sessionId: string): Promise<BrowserStateDto> {
    const page = this.pages.get(sessionId);
    if (!page) return disconnectedState();
    return page.client.state();
  }

  async screenshot(sessionId: string): Promise<Buffer> {
    const page = await this.requirePage(sessionId);
    return page.client.screenshot();
  }

  async input(sessionId: string, input: BrowserInputDto): Promise<BrowserStateDto> {
    const page = await this.requirePage(sessionId);
    validateInput(input);
    switch (input.type) {
      case 'click':
        await page.client.click(input.x, input.y);
        break;
      case 'text':
        await page.client.typeText(input.text);
        break;
      case 'key':
        await page.client.pressKey(input);
        break;
      case 'scroll':
        await page.client.scroll(input.x, input.y, input.deltaX, input.deltaY);
        break;
      default: {
        const _exhaustive: never = input;
        return _exhaustive;
      }
    }
    return page.client.state();
  }

  async onModuleDestroy(): Promise<void> {
    for (const page of this.pages.values()) {
      page.client.close?.();
    }
    this.pages.clear();
    this.chromeProcess?.kill('SIGTERM');
    this.chromeProcess = null;
  }

  private async requirePage(sessionId: string): Promise<SessionPage> {
    const existing = this.pages.get(sessionId);
    if (existing) return existing;
    await this.open(sessionId);
    const page = this.pages.get(sessionId);
    if (!page) throw new Error('Browser page was not created');
    return page;
  }

  private async ensureChrome(): Promise<number> {
    if (this.remotePort !== null) return this.remotePort;
    const port = await this.allocatePort();
    const profileDir = this.profileDir();
    mkdirSync(profileDir, { recursive: true });
    await this.reclaimLockedProfile(profileDir);
    this.chromeProcess = this.spawnChrome(this.chromeBinary(), [
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profileDir}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,1600',
      'about:blank',
    ]);
    this.remotePort = port;
    try {
      await this.waitForDebugger(port);
    } catch {
      this.remotePort = null;
      this.chromeProcess?.kill('SIGTERM');
      this.chromeProcess = null;
      throw new ServiceUnavailableException(chromeLaunchErrorMessage(profileDir));
    }
    return port;
  }
}

function disconnectedState(): BrowserStateDto {
  return {
    connected: false,
    url: null,
    title: null,
    loading: false,
    screenshotVersion: 0,
  };
}

function normalizeBrowserUrl(raw?: string): string {
  const value = raw?.trim();
  if (!value) return 'about:blank';
  if (/^(about:|https?:\/\/)/i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(value)) {
    return `http://${value}`;
  }
  return `https://${value}`;
}

function validateInput(input: BrowserInputDto): void {
  if (input.type === 'click') {
    assertFinite(input.x, 'x');
    assertFinite(input.y, 'y');
    return;
  }
  if (input.type === 'text') {
    if (typeof input.text !== 'string') throw new BadRequestException('text is required');
    return;
  }
  if (input.type === 'key') {
    if (typeof input.key !== 'string' || input.key.length === 0) {
      throw new BadRequestException('key is required');
    }
    return;
  }
  if (input.type === 'scroll') {
    assertFinite(input.x, 'x');
    assertFinite(input.y, 'y');
    assertFinite(input.deltaX, 'deltaX');
    assertFinite(input.deltaY, 'deltaY');
    return;
  }
  throw new BadRequestException('Unknown browser input type');
}

function assertFinite(value: number, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BadRequestException(`${field} must be a finite number`);
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error('Unable to allocate a Chrome debugging port'));
          return;
        }
        resolvePort(port);
      });
    });
  });
}

async function waitForDebugger(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Chrome remote debugging endpoint did not become ready');
}

function chromeLaunchErrorMessage(profileDir: string): string {
  const lock = chromeProfileLockHint(profileDir);
  if (lock) {
    return `Nuncio browser profile appears to be in use (${lock}). Close the old Nuncio Chrome window/process, then retry.`;
  }
  return 'Chrome remote debugging did not start. Check NUNCIO_CHROME_BIN or the local Chrome installation, then retry.';
}

function chromeProfileLockHint(profileDir: string): string | null {
  const lock = readChromeProfileLock(profileDir);
  if (lock?.target) return `SingletonLock -> ${lock.target}`;
  if (lock) return 'SingletonLock exists';
  return null;
}

async function reclaimLockedProfile(profileDir: string): Promise<void> {
  const lock = readChromeProfileLock(profileDir);
  if (!lock?.pid || !sameHost(lock.host)) return;
  if (!(await processUsesProfile(lock.pid, profileDir))) return;

  try {
    process.kill(lock.pid, 'SIGTERM');
  } catch {
    return;
  }

  const released = await waitForProfileRelease(lock.pid, profileDir, 2_000);
  if (!released) {
    try {
      process.kill(lock.pid, 'SIGKILL');
    } catch {
      return;
    }
    await waitForProfileRelease(lock.pid, profileDir, 2_000);
  }
  removeChromeSingletonFiles(profileDir);
}

function readChromeProfileLock(profileDir: string): { target?: string; host?: string; pid?: number } | null {
  const lockPath = join(profileDir, 'SingletonLock');
  try {
    const stat = lstatSync(lockPath);
    if (!stat.isSymbolicLink()) return {};
    const target = readlinkSync(lockPath);
    const match = /^(.*)-(\d+)$/.exec(target);
    if (!match) return { target };
    return { target, host: match[1], pid: Number(match[2]) };
  } catch {
    return null;
  }
}

function sameHost(host?: string): boolean {
  if (!host) return false;
  const current = hostname();
  const shortCurrent = current.split('.')[0];
  return host === current || host === shortCurrent;
}

async function processUsesProfile(pid: number, profileDir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-p', String(pid)], { timeout: 1_500 });
    return stdout.includes(profileDir) && /Google Chrome|Chromium|Google/i.test(stdout);
  } catch {
    return false;
  }
}

async function waitForProfileRelease(pid: number, profileDir: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!(await processUsesProfile(pid, profileDir))) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return false;
}

function removeChromeSingletonFiles(profileDir: string): void {
  for (const file of SINGLETON_FILES) {
    try {
      rmSync(join(profileDir, file), { force: true });
    } catch {
      // Chrome singleton files are best-effort cleanup after the owning process exits.
    }
  }
}
