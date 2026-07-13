import type { EvidenceCapturedPayload } from '../sessions/domain/events.types';

export type EvidencePhase = 'before' | 'after';

export interface BrowserCaptureEvidenceDto {
  target?: 'browser';
  url: string;
  route?: string;
  phase: EvidencePhase;
}

export interface SimulatorCaptureEvidenceDto {
  target: 'simulator';
  phase: EvidencePhase;
}

export type CaptureEvidenceDto = BrowserCaptureEvidenceDto | SimulatorCaptureEvidenceDto;

export interface EvidenceCaptureUnavailable {
  unavailable: true;
  reason: string;
}

export type EvidenceCaptureResult = EvidenceCapturedPayload | EvidenceCaptureUnavailable;

export interface EvidencePage {
  goto(url: string, options: { waitUntil: 'load'; timeout: number }): Promise<unknown>;
  screenshot(options: { type: 'png'; fullPage: true }): Promise<Buffer>;
  url(): string;
}

export interface EvidenceBrowser {
  newPage(options: { viewport: { width: number; height: number } }): Promise<EvidencePage>;
  close(): Promise<void>;
}

export interface EvidenceBrowserServer {
  wsEndpoint(): string;
  close(): Promise<void>;
  kill(): Promise<void>;
}

export interface EvidenceChromium {
  launchServer(options: { channel: 'chrome'; headless: true }): Promise<EvidenceBrowserServer>;
  connect(wsEndpoint: string): Promise<EvidenceBrowser>;
}

export type EvidenceGitHeadReader = (cwd: string) => Promise<string | null>;

export type SimulatorCapability =
  | { available: true }
  | { available: false; reason: string };

export type SimulatorCapture =
  | { ok: true; bytes: Buffer; viewport: { w: number; h: number }; route: string }
  | { ok: false; reason: string };

export type SimulatorExec = (argv: string[]) => Promise<{ ok: boolean; stderr?: string }>;

export const EVIDENCE_CHROMIUM = Symbol('EVIDENCE_CHROMIUM');
export const EVIDENCE_GIT_HEAD = Symbol('EVIDENCE_GIT_HEAD');
