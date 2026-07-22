import { Injectable, Optional } from '@nestjs/common';
import { AgentRegistry } from '../agents/agents.registry';
import { truncateHeadBytes } from '../orchestration/byte-truncate';
import { SettingsService } from '../settings/settings.service';

const AUTO_TITLE_SETTING = 'NUNCIO_AUTO_TITLE';
const AUTO_BRANCH_NAME_SETTING = 'NUNCIO_AUTO_BRANCH_NAME';
const SESSION_TITLE_MODEL_SETTING = 'NUNCIO_SESSION_TITLE_MODEL';

const REQUEST_PROMPT_MAX_BYTES = 2 * 1024;
const TITLE_MAX_CHARS = 80;
const COMPLETION_TIMEOUT_MS = 30_000;

// Rules adapted from Synara's thread-title prompt (open source), which is the
// strongest naming prompt we found in the field: identifiers keep two similar
// tasks distinguishable, and the phrase constraint keeps titles scannable.
const TITLE_SYSTEM_PROMPT =
  'You name coding-agent sessions. Given the task request, return ONLY a concise 3-8 word ' +
  "title in the request's language — a short noun or verb phrase, not a full sentence. " +
  'Be specific: keep distinguishing identifiers from the request (PR/issue numbers, branch ' +
  'names, file or feature names, error codes). Two different requests should never produce ' +
  'the same title. No quotes, no code fence, no markdown, no emoji, no trailing punctuation.';

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

  /** True unless the user switched the branch-naming toggle off. */
  branchNamingEnabled(): boolean {
    return this.settings?.resolve(AUTO_BRANCH_NAME_SETTING) !== '0';
  }

  /**
   * A 2-6 word branch fragment describing the requested work (Synara's
   * branch-name recipe: plain words, no prefixes, sanitized to a git-safe
   * slug). Null on any failure — the create-time branch name simply stays.
   */
  async generateBranchSlug(request: string, preferredProviderId?: string): Promise<string | null> {
    try {
      const capable = (await this.agents.available()).filter((p) => p.completeOneShot);
      const provider = capable.find((p) => p.id === preferredProviderId) ?? capable[0];
      if (!provider?.completeOneShot) return null;

      const raw = await withTimeout(
        provider.completeOneShot({
          prompt: truncateHeadBytes(request.trim(), REQUEST_PROMPT_MAX_BYTES),
          systemPrompt: BRANCH_SYSTEM_PROMPT,
          model: this.settings?.resolve(SESSION_TITLE_MODEL_SETTING)?.trim() || null,
        }),
        COMPLETION_TIMEOUT_MS,
      );
      return sanitizeBranchFragment(raw);
    } catch {
      return null;
    }
  }

  /**
   * `preferredProviderId` (the session's own engine) wins when it implements
   * one-shot completions — Synara's resolution order — so the title bills to
   * and matches the engine the user picked; any capable engine is the fallback.
   */
  async generateTitle(request: string, preferredProviderId?: string): Promise<string | null> {
    try {
      const capable = (await this.agents.available()).filter((p) => p.completeOneShot);
      const provider = capable.find((p) => p.id === preferredProviderId) ?? capable[0];
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

// Synara's branch-name rules verbatim (their open-source recipe): describe the
// requested work, short and specific, plain words only.
const BRANCH_SYSTEM_PROMPT =
  'You generate concise git branch names. Return ONLY the branch name — it should describe ' +
  'the requested work from the user message in 2-6 short plain lowercase words joined by ' +
  'hyphens. No issue prefixes, no punctuation-heavy text, no quotes, no code fence.';

/**
 * Port of Synara's buildGeneratedWorktreeBranchName sanitizer: lowercase,
 * strip refs/heads/ + quotes + an echoed nuncio/ prefix, collapse everything
 * outside [a-z0-9/_-] to hyphens, trim separator runs at the edges, cap at 64.
 * Null (not a default) when nothing usable remains — the caller keeps the
 * create-time branch name instead.
 */
function sanitizeBranchFragment(raw: string): string | null {
  const normalized = (raw.split('\n')[0] ?? '')
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, '')
    .replace(/^refs\/heads\//, '');
  const withoutPrefix = normalized.replace(/^nuncio\//, '');
  const fragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/-+/g, '-')
    .replace(/^[./_-]+|[./_-]+$/g, '')
    .slice(0, 64)
    .replace(/[./_-]+$/g, '');
  return fragment.length > 0 ? fragment : null;
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
