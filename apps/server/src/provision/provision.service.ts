import { BadRequestException, Injectable } from '@nestjs/common';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SettingsService } from '../settings/settings.service';
import { SETTING_DEFINITIONS, getSettingDefinition } from '../settings/settings.registry';
import type {
  ProvisionApplyResult,
  ProvisionPayload,
  ProvisionPushResult,
} from './provision.types';

/** Only these Pi agent files travel — never sessions/ (per-machine history). */
const PI_FILES = ['auth.json', 'models.json', 'settings.json'] as const;
const MAX_FILE_BYTES = 256 * 1024;
const PUSH_TIMEOUT_MS = 15_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Config sync between the user's own nuncio servers ("Sync config" in the
 * Remote access settings). push() runs on the SOURCE: it collects the local
 * Pi agent files + DB-configured settings and POSTs them to the target's
 * /api/provision, authenticated by the tailnet identity of this server
 * (whois trust) or the caller-supplied token. apply() runs on the TARGET:
 * it backs up then overwrites the Pi files and stores the settings.
 * Path-type settings never travel — they are machine-specific.
 */
@Injectable()
export class ProvisionService {
  /** Injectable for tests. */
  fetchImpl: FetchLike = (url, init) => fetch(url, init);

  constructor(private readonly settings: SettingsService) {}

  piAgentDir(): string {
    return (
      this.settings.resolve('PI_AGENT_DIR') ??
      process.env.PI_CODING_AGENT_DIR ??
      process.env.PI_AGENT_DIR ??
      join(homedir(), '.pi', 'agent')
    );
  }

  collect(): ProvisionPayload {
    const piAgent: Record<string, string> = {};
    const dir = this.piAgentDir();
    for (const name of PI_FILES) {
      const filePath = join(dir, name);
      if (existsSync(filePath)) {
        piAgent[name] = readFileSync(filePath, 'utf8');
      }
    }

    const settings: Record<string, string> = {};
    for (const def of SETTING_DEFINITIONS) {
      if (def.type === 'path') continue;
      const { value, source } = this.settings.resolveSource(def.key);
      if (source === 'db' && value !== undefined) {
        settings[def.key] = value;
      }
    }

    return { piAgent, settings };
  }

  apply(payload: ProvisionPayload): ProvisionApplyResult {
    if (!payload || typeof payload !== 'object') {
      throw new BadRequestException('Invalid provision payload');
    }

    const result: ProvisionApplyResult = {
      piFilesWritten: [],
      piFilesBackedUp: [],
      settingsApplied: [],
      settingsSkipped: [],
    };

    const piAgent = payload.piAgent ?? {};
    const dir = this.piAgentDir();
    for (const name of PI_FILES) {
      const content = piAgent[name];
      if (content === undefined) continue;
      if (typeof content !== 'string' || content.length > MAX_FILE_BYTES) {
        throw new BadRequestException(`Invalid content for ${name}`);
      }
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, name);
      if (existsSync(filePath)) {
        const backupPath = `${filePath}.backup-${Date.now()}`;
        copyFileSync(filePath, backupPath);
        result.piFilesBackedUp.push(name);
      }
      writeFileSync(filePath, content, { mode: 0o600 });
      // writeFileSync's mode only applies on create; enforce it on overwrite too.
      chmodSync(filePath, 0o600);
      result.piFilesWritten.push(name);
    }

    for (const [key, value] of Object.entries(payload.settings ?? {})) {
      const def = getSettingDefinition(key);
      if (!def || def.type === 'path' || typeof value !== 'string') {
        result.settingsSkipped.push(key);
        continue;
      }
      this.settings.set(key, value);
      result.settingsApplied.push(key);
    }

    console.log(
      `[provision] applied: pi files [${result.piFilesWritten.join(', ')}], settings [${result.settingsApplied.join(', ')}]`,
    );
    return result;
  }

  async push(target: string): Promise<ProvisionPushResult> {
    const base = normalizeTargetUrl(target);
    if (!base) {
      throw new BadRequestException('Invalid provision target URL');
    }

    const payload = this.collect();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(`${base}/api/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      throw new BadRequestException(
        `Could not reach ${base}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new BadRequestException(
        `Target refused the provision (${response.status}) — is it on the same Tailscale account?`,
      );
    }

    const applied = (await response.json()) as ProvisionApplyResult;
    return {
      target: base,
      sent: {
        piFiles: Object.keys(payload.piAgent ?? {}),
        settings: Object.keys(payload.settings ?? {}),
      },
      applied,
    };
  }
}

export function normalizeTargetUrl(input: unknown): string | null {
  const value = typeof input === 'string' ? input.trim() : '';
  if (!value) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value) ? value : `http://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}
