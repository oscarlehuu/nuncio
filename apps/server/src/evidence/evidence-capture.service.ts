import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { SessionDto } from '../sessions/domain/sessions.types';
import { MediaStore } from '../sessions/media.store';
import {
  EVIDENCE_CHROMIUM,
  EVIDENCE_GIT_HEAD,
  type CaptureEvidenceDto,
  type EvidenceCaptureResult,
  type EvidenceChromium,
  type EvidenceGitHeadReader,
  type EvidencePhase,
} from './evidence.types';

const VIEWPORT = { width: 1440, height: 900 } as const;
const NAVIGATION_TIMEOUT_MS = 15_000;

interface KnownTarget {
  url: string;
  route?: string;
}

@Injectable()
export class EvidenceCaptureService {
  private readonly knownTargets = new Map<string, KnownTarget>();

  constructor(
    @Inject(EVIDENCE_CHROMIUM) private readonly chromium: EvidenceChromium,
    private readonly media: MediaStore,
    @Inject(EVIDENCE_GIT_HEAD) private readonly readHead: EvidenceGitHeadReader,
  ) {}

  async capture(session: SessionDto, input: CaptureEvidenceDto): Promise<EvidenceCaptureResult> {
    const target = this.resolveTarget(input);
    const cwd = session.worktreePath ?? session.workspace ?? session.projectPath;
    if (!cwd) throw new BadRequestException('Session has no workspace to witness');
    const headBefore = await this.readHead(cwd);
    if (!headBefore) throw new BadRequestException('Session workspace has no readable git HEAD');

    this.knownTargets.set(session.id, { url: input.url, ...(input.route ? { route: input.route } : {}) });
    const browser = await this.chromium.launch({ channel: 'chrome', headless: true });
    const bytes = await (async () => {
      try {
        const page = await browser.newPage({ viewport: VIEWPORT });
        await page.goto(target.href, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });
        return await page.screenshot({ type: 'png', fullPage: true });
      } finally {
        await browser.close();
      }
    })();
    const workspaceHead = await this.readHead(cwd);
    if (!workspaceHead || workspaceHead !== headBefore) {
      throw new BadRequestException('Workspace HEAD changed during evidence capture');
    }

    const ref = { id: this.media.write(session.id, bytes.toString('base64')), mimeType: 'image/png' as const };
    return {
      ...(input.phase === 'before' ? { beforeRef: ref } : { afterRef: ref }),
      route: target.route,
      viewport: { w: VIEWPORT.width, h: VIEWPORT.height },
      workspaceHead,
    };
  }

  captureKnown(session: SessionDto, phase: EvidencePhase): Promise<EvidenceCaptureResult | null> {
    const target = this.knownTargets.get(session.id);
    return target ? this.capture(session, { ...target, phase }) : Promise.resolve(null);
  }

  forget(sessionId: string): void {
    this.knownTargets.delete(sessionId);
  }

  private resolveTarget(input: CaptureEvidenceDto): { href: string; route: string } {
    if (input.phase !== 'before' && input.phase !== 'after') {
      throw new BadRequestException('phase must be before or after');
    }
    let base: URL;
    try {
      base = new URL(input.url);
    } catch {
      throw new BadRequestException('url must be a valid HTTP(S) URL');
    }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      throw new BadRequestException('url must be a valid HTTP(S) URL');
    }
    const target = input.route ? new URL(input.route, base) : base;
    if (target.origin !== base.origin) throw new BadRequestException('route must stay on the preview origin');
    return { href: target.href, route: `${target.pathname}${target.search}${target.hash}` };
  }
}
