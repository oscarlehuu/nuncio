import {
  BadRequestException, Inject, Injectable, OnModuleDestroy, Optional, ServiceUnavailableException,
} from '@nestjs/common';
import { BrowserToolService } from '../browser/browser-tool.service';
import type { SessionDto } from '../sessions/domain/sessions.types';
import { MediaStore } from '../sessions/media.store';
import {
  EVIDENCE_CHROMIUM,
  EVIDENCE_GIT_HEAD,
  type CaptureEvidenceDto,
  type BrowserCaptureEvidenceDto,
  type EvidenceBrowser,
  type EvidenceBrowserServer,
  type EvidenceCaptureOutcome,
  type EvidenceCaptureResult,
  type EvidenceChromium,
  type EvidenceGitHeadReader,
  type EvidencePhase,
} from './evidence.types';
import { SimulatorEvidenceCaptureService } from './simulator-evidence-capture.service';

const VIEWPORT = { width: 1440, height: 900 } as const;
const NAVIGATION_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 1_000;

interface KnownTarget { url: string; route?: string }

@Injectable()
export class EvidenceCaptureService implements OnModuleDestroy {
  private readonly knownTargets = new Map<string, KnownTarget>();
  private readonly targetRevisions = new Map<string, number>();
  private readonly activeServers = new Set<EvidenceBrowserServer>();
  private captureTail: Promise<void> = Promise.resolve();
  private destroying = false;

  constructor(
    @Inject(EVIDENCE_CHROMIUM) private readonly chromium: EvidenceChromium | null,
    private readonly media: MediaStore,
    @Inject(EVIDENCE_GIT_HEAD) private readonly readHead: EvidenceGitHeadReader,
    private readonly browserTools: BrowserToolService,
    @Optional() private readonly simulator?: SimulatorEvidenceCaptureService,
  ) {}

  capture(session: SessionDto, input: CaptureEvidenceDto): Promise<EvidenceCaptureOutcome> {
    const targetRevision = this.targetRevisions.get(session.id) ?? 0;
    const result = this.captureTail.then(() => this.captureOnce(session, input, targetRevision));
    this.captureTail = result.then(() => undefined, () => undefined);
    return result;
  }

  captureKnown(session: SessionDto, phase: EvidencePhase): Promise<EvidenceCaptureOutcome | null> {
    const target = this.knownTargets.get(session.id);
    return target ? this.capture(session, { ...target, phase }) : Promise.resolve(null);
  }

  forget(sessionId: string): void {
    this.knownTargets.delete(sessionId);
    this.targetRevisions.set(sessionId, (this.targetRevisions.get(sessionId) ?? 0) + 1);
  }

  async onModuleDestroy(): Promise<void> {
    this.destroying = true;
    await Promise.allSettled([...this.activeServers].map((server) => this.killServer(server)));
  }

  private async captureOnce(
    session: SessionDto,
    input: CaptureEvidenceDto,
    targetRevision: number,
  ): Promise<EvidenceCaptureOutcome> {
    this.assertCaptureCurrent(session.id, targetRevision);
    if (input.phase !== 'before' && input.phase !== 'after') {
      throw new BadRequestException('phase must be before or after');
    }
    if (input.target !== 'simulator' && !this.chromium) {
      return { unavailable: true, reason: 'Browser capture unavailable' };
    }
    const cwd = session.worktreePath ?? session.workspace ?? session.projectPath;
    if (!cwd) throw new BadRequestException('Session has no workspace to witness');
    const headBefore = await this.readHead(cwd);
    if (!headBefore) throw new BadRequestException('Session workspace has no readable git HEAD');
    this.assertCaptureCurrent(session.id, targetRevision);

    const captured = input.target === 'simulator'
      ? await this.captureSimulator()
      : await this.captureBrowser(session.id, input, targetRevision);
    if ('unavailable' in captured && captured.unavailable === true) return captured;
    const workspaceHead = await this.readHead(cwd);
    if (!workspaceHead || workspaceHead !== headBefore) {
      throw new BadRequestException('Workspace HEAD changed during evidence capture');
    }
    this.assertCaptureCurrent(session.id, targetRevision);

    if ('origin' in captured) {
      this.knownTargets.set(session.id, { url: captured.origin, route: captured.route });
    }
    const ref = { id: this.media.write(session.id, captured.bytes.toString('base64')),
      mimeType: 'image/png' as const };
    return {
      ...(input.phase === 'before' ? { beforeRef: ref } : { afterRef: ref }),
      route: captured.route,
      viewport: captured.viewport,
      workspaceHead,
    };
  }

  private async captureSimulator() {
    if (!this.simulator) throw new ServiceUnavailableException('Simulator capture is unavailable');
    const result = await this.simulator.captureScreenshot();
    if (!result.ok) throw new ServiceUnavailableException(result.reason);
    return result;
  }

  private async captureBrowser(
    sessionId: string,
    input: BrowserCaptureEvidenceDto,
    targetRevision: number,
  ): Promise<EvidenceCaptureResult> {
    if (!this.chromium) {
      return { unavailable: true as const, reason: 'Browser capture unavailable' };
    }
    const allowedOrigin = await this.resolveAllowedOrigin(sessionId);
    const target = this.resolveTarget(input, allowedOrigin);
    const server = await this.chromium.launchServer({ channel: 'chrome', headless: true });
    this.activeServers.add(server);
    let browser: EvidenceBrowser | undefined;
    try {
      this.assertCaptureCurrent(sessionId, targetRevision);
      browser = await this.chromium.connect(server.wsEndpoint());
      const page = await browser.newPage({ viewport: VIEWPORT });
      await page.goto(target.href, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });
      target.route = this.resolveFinalRoute(page.url(), allowedOrigin);
      const bytes = await page.screenshot({ type: 'png', fullPage: true });
      return { bytes, route: target.route,
        viewport: { w: VIEWPORT.width, h: VIEWPORT.height }, origin: allowedOrigin };
    } finally {
      await this.closeRuntime(browser, server);
      this.activeServers.delete(server);
    }
  }

  private async resolveAllowedOrigin(sessionId: string): Promise<string> {
    const known = this.knownTargets.get(sessionId);
    if (known) return this.httpUrl(known.url, 'Registered preview URL').origin;
    const state = await this.browserTools.state(sessionId);
    if (!state.connected || !state.url) {
      throw new BadRequestException('Session has no registered preview origin');
    }
    return this.httpUrl(state.url, 'Registered preview URL').origin;
  }

  private assertCaptureCurrent(sessionId: string, targetRevision: number): void {
    if (this.destroying) throw new BadRequestException('Evidence capture is shutting down');
    if ((this.targetRevisions.get(sessionId) ?? 0) !== targetRevision) {
      throw new BadRequestException('Session evidence target was cleared during capture');
    }
  }

  private resolveTarget(input: BrowserCaptureEvidenceDto, allowedOrigin: string) {
    const base = this.httpUrl(input.url, 'url');
    if (base.origin !== allowedOrigin) throw new BadRequestException('url must match the session preview origin');
    const target = input.route ? new URL(input.route, base) : base;
    if (target.origin !== allowedOrigin) throw new BadRequestException('route must stay on the preview origin');
    return { href: target.href, route: this.routeOf(target) };
  }

  private resolveFinalRoute(raw: string, allowedOrigin: string): string {
    const target = this.httpUrl(raw, 'Final preview URL');
    if (target.origin !== allowedOrigin) {
      throw new BadRequestException('Preview redirected outside the registered origin');
    }
    return this.routeOf(target);
  }

  private httpUrl(raw: string, label: string): URL {
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw new BadRequestException(`${label} must be a valid HTTP(S) URL`); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException(`${label} must be a valid HTTP(S) URL`);
    }
    return parsed;
  }

  private routeOf(url: URL): string {
    return `${url.pathname}${url.search}${url.hash}`;
  }

  private async closeRuntime(browser: EvidenceBrowser | undefined, server: EvidenceBrowserServer): Promise<void> {
    if (this.destroying) {
      await this.killServer(server);
      return;
    }
    const browserClosed = !browser || await this.settles(browser.close());
    const serverClosed = browserClosed && await this.settles(server.close());
    if (!browserClosed || !serverClosed) await this.killServer(server);
  }

  private async killServer(server: EvidenceBrowserServer): Promise<void> {
    await this.settles(server.kill());
  }

  private async settles(promise: Promise<void>): Promise<boolean> {
    return Promise.race([
      promise.then(() => true, () => false),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS)),
    ]);
  }
}
