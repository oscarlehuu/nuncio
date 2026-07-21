import { Injectable, Optional } from '@nestjs/common';
import { AgentRegistry } from '../agents/agents.registry';
import { truncateHeadBytes } from '../orchestration/byte-truncate';
import { SettingsService } from '../settings/settings.service';

export const AUTO_TITLE_SETTING = 'NUNCIO_AUTO_TITLE';
export const SESSION_TITLE_MODEL_SETTING = 'NUNCIO_SESSION_TITLE_MODEL';

const REQUEST_PROMPT_MAX_BYTES = 2 * 1024;
const TITLE_MAX_CHARS = 80;
const COMPLETION_TIMEOUT_MS = 30_000;

const TITLE_SYSTEM_PROMPT =
  'You name coding-agent sessions. Given the task request, return ONLY a concise 3-8 word ' +
  "title in the request's language — no quotes, no code fence, no trailing period.";

/**
 * Engine-neutral automatic session naming (what Claude Code / Codex / Cursor /
 * Devin do natively): a cheap tool-less one-shot turns the user's first
 * request into a concise title. Best-effort by design — any failure returns
 * null and the first-line-derived title simply stays.
 */
@Injectable()
export class SessionTitleService {
  constructor(
    private readonly agents: AgentRegistry,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  /** True unless the user switched the toggle off. */
  enabled(): boolean {
    return this.settings?.resolve(AUTO_TITLE_SETTING) !== '0';
  }

  async generateTitle(request: string): Promise<string | null> {
    try {
      const provider = (await this.agents.available()).find((p) => p.completeOneShot);
      if (!provider?.completeOneShot) return null;

      const raw = await withTimeout(
        provider.completeOneShot({
          prompt: truncateHeadBytes(request.trim(), REQUEST_PROMPT_MAX_BYTES),
          systemPrompt: TITLE_SYSTEM_PROMPT,
          model: this.settings?.resolve(SESSION_TITLE_MODEL_SETTING)?.trim() || null,
        }),
        COMPLETION_TIMEOUT_MS,
      );
      return cleanTitle(raw);
    } catch {
      return null;
    }
  }
}

/** First line only, fences/quotes/trailing period stripped, length-capped. */
function cleanTitle(raw: string): string | null {
  let text = raw.trim();
  const fence = text.match(/^```[a-z]*\n([\s\S]*?)\n?```$/);
  if (fence) text = fence[1]!.trim();
  text = (text.split('\n')[0] ?? '').trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/\.+$/, '').trim();
  if (!text) return null;
  return text.length > TITLE_MAX_CHARS ? text.slice(0, TITLE_MAX_CHARS).trimEnd() : text;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`title generation timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer!)) as Promise<T>;
}
