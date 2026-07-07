import { BadRequestException, Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { BROWSER_TOOL_DEFINITIONS } from './browser-tool-contract';
import { InAppBrowserBackend } from './in-app-browser.backend';
import { SettingsService } from '../settings/settings.service';
import type {
  BrowserBackend,
  BrowserInputDto,
  BrowserResolvedTarget,
  BrowserTargetPreference,
  BrowserToolCallInput,
  BrowserToolName,
  BrowserToolOptions,
  BrowserToolResult,
  BrowserToolStateDto,
} from './browser.types';

export const EXTERNAL_BROWSER_BACKEND = Symbol('EXTERNAL_BROWSER_BACKEND');

@Injectable()
export class BrowserToolService {
  readonly toolDefinitions = BROWSER_TOOL_DEFINITIONS;
  private readonly selectedTargets = new Map<string, BrowserResolvedTarget>();

  constructor(
    @Inject(EXTERNAL_BROWSER_BACKEND) private readonly external: BrowserBackend,
    private readonly inApp: InAppBrowserBackend,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  async open(sessionId: string, url?: string, options: BrowserToolOptions = {}): Promise<BrowserToolStateDto> {
    const backend = this.resolveBackend(sessionId, options.target);
    const state = await backend.open(sessionId, url);
    return this.withTarget(sessionId, backend, state);
  }

  async state(sessionId: string, options: BrowserToolOptions = {}): Promise<BrowserToolStateDto> {
    const backend = this.resolveBackend(sessionId, options.target);
    const state = await backend.state(sessionId);
    return this.withTarget(sessionId, backend, state);
  }

  async screenshot(sessionId: string, options: BrowserToolOptions = {}): Promise<Buffer> {
    const backend = this.resolveBackend(sessionId, options.target);
    this.selectedTargets.set(sessionId, backend.id);
    return backend.screenshot(sessionId);
  }

  async input(
    sessionId: string,
    input: BrowserInputDto,
    options: BrowserToolOptions = {},
  ): Promise<BrowserToolStateDto> {
    const backend = this.resolveBackend(sessionId, options.target);
    const state = await backend.input(sessionId, input);
    return this.withTarget(sessionId, backend, state);
  }

  async execute(toolName: string, input: BrowserToolCallInput): Promise<BrowserToolResult> {
    const sessionId = requireString(input.sessionId, 'sessionId');
    const target = optionalTarget(input.target);

    switch (toolName as BrowserToolName) {
      case 'browser_open':
        return { type: 'state', state: await this.open(sessionId, optionalString(input.url), { target }) };
      case 'browser_get_state':
        return { type: 'state', state: await this.state(sessionId, { target }) };
      case 'browser_screenshot': {
        const image = await this.screenshot(sessionId, { target });
        return {
          type: 'screenshot',
          target: this.selectedTargets.get(sessionId) ?? 'external',
          mimeType: 'image/png',
          data: image.toString('base64'),
        };
      }
      case 'browser_click':
        return { type: 'state', state: await this.input(sessionId, clickInput(input), { target }) };
      case 'browser_type':
        return { type: 'state', state: await this.input(sessionId, textInput(input), { target }) };
      case 'browser_key':
        return { type: 'state', state: await this.input(sessionId, keyInput(input), { target }) };
      case 'browser_scroll':
        return { type: 'state', state: await this.input(sessionId, scrollInput(input), { target }) };
      default:
        throw new BadRequestException(`Unknown browser tool: ${toolName}`);
    }
  }

  private resolveBackend(sessionId: string, requested?: BrowserTargetPreference): BrowserBackend {
    const target = parseTarget(requested ?? this.defaultTarget());
    if (target === 'external') return this.external;
    if (target === 'in_app') return this.requireInApp();

    const selected = this.selectedTargets.get(sessionId);
    if (selected === 'external') return this.external;
    if (selected === 'in_app' && this.inApp.isAvailable()) return this.inApp;

    return this.inApp.isAvailable() ? this.inApp : this.external;
  }

  private defaultTarget(): BrowserTargetPreference {
    const value = this.settings?.resolve('NUNCIO_BROWSER_DEFAULT_TARGET');
    return isBrowserTargetPreference(value) ? value : 'auto';
  }

  private requireInApp(): BrowserBackend {
    if (!this.inApp.isAvailable()) {
      throw new ServiceUnavailableException('Nuncio desktop in-app browser is not connected');
    }
    return this.inApp;
  }

  private withTarget(
    sessionId: string,
    backend: BrowserBackend,
    state: Omit<BrowserToolStateDto, 'target'>,
  ): BrowserToolStateDto {
    this.selectedTargets.set(sessionId, backend.id);
    return { ...state, target: backend.id };
  }
}

function parseTarget(value: unknown): BrowserTargetPreference {
  if (value === undefined || value === null || value === '') return 'auto';
  if (isBrowserTargetPreference(value)) return value;
  throw new BadRequestException('browser target must be auto, in_app, or external');
}

function optionalTarget(value: unknown): BrowserTargetPreference | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return parseTarget(value);
}

function isBrowserTargetPreference(value: unknown): value is BrowserTargetPreference {
  return value === 'auto' || value === 'in_app' || value === 'external';
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException(`${field} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new BadRequestException('url must be a string');
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BadRequestException(`${field} must be a finite number`);
  }
  return value;
}

function clickInput(input: BrowserToolCallInput): BrowserInputDto {
  return { type: 'click', x: requireNumber(input.x, 'x'), y: requireNumber(input.y, 'y') };
}

function textInput(input: BrowserToolCallInput): BrowserInputDto {
  return { type: 'text', text: requireString(input.text, 'text') };
}

function keyInput(input: BrowserToolCallInput): BrowserInputDto {
  return {
    type: 'key',
    key: requireString(input.key, 'key'),
    code: optionalString(input.code),
    altKey: optionalBoolean(input.altKey),
    ctrlKey: optionalBoolean(input.ctrlKey),
    metaKey: optionalBoolean(input.metaKey),
    shiftKey: optionalBoolean(input.shiftKey),
  };
}

function scrollInput(input: BrowserToolCallInput): BrowserInputDto {
  return {
    type: 'scroll',
    x: requireNumber(input.x, 'x'),
    y: requireNumber(input.y, 'y'),
    deltaX: requireNumber(input.deltaX, 'deltaX'),
    deltaY: requireNumber(input.deltaY, 'deltaY'),
  };
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new BadRequestException('keyboard modifiers must be booleans');
  return value;
}
