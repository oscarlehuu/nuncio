import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseProfileDocument, type WarnFn } from './prompt-profile.parser';
import { EMPTY_PROFILE, type PromptProfile } from './prompt-profile.types';

/** Compile a shell-style glob (only `*`) to an anchored, regex-safe matcher. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? '.*' : `\\${c}`));
  return new RegExp(`^${escaped}$`);
}

/** Specificity = pattern length minus wildcards; a longer, less-wildcarded pattern wins. */
function specificity(pattern: string): number {
  return pattern.replace(/\*/g, '').length - (pattern.match(/\*/g)?.length ?? 0);
}

const DEFAULT_WARN: WarnFn = (message) => console.warn(`[prompt-profile] ${message}`);

/**
 * Resolves an engine-specific prompt profile for `(provider, model)` with
 * precedence: DB override (settings key) > model-specific repo file > provider
 * repo file > built-in empty pass-through. Cached per process; bustCache()
 * re-reads from disk/settings (wired to the provider-registry bust path).
 */
export class PromptProfileLoader {
  private readonly cache = new Map<string, PromptProfile>();

  constructor(
    private readonly profilesDir: string,
    private readonly resolveSetting: (key: string) => string | undefined,
    private readonly warn: WarnFn = DEFAULT_WARN,
  ) {}

  bustCache(): void {
    this.cache.clear();
  }

  resolve(provider: string, model: string | null | undefined): PromptProfile {
    const cacheKey = `${provider}::${model ?? ''}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const profile = this.compute(provider, model ?? '');
    this.cache.set(cacheKey, profile);
    return profile;
  }

  private compute(provider: string, model: string): PromptProfile {
    // 1. DB override wins outright.
    const overrideDoc = this.resolveSetting(`NUNCIO_PROMPT_PROFILE_${provider.toUpperCase()}`);
    if (overrideDoc?.trim()) {
      const parsed = parseProfileDocument(overrideDoc, this.warn);
      if (parsed) return parsed;
    }

    // 2/3. Repo files: all candidates for this provider, best modelPattern match wins.
    const candidates = this.repoCandidates(provider);
    let best: PromptProfile | null = null;
    let bestScore = -Infinity;
    for (const profile of candidates) {
      if (!globToRegExp(profile.modelPattern).test(model)) continue;
      const score = specificity(profile.modelPattern);
      if (score > bestScore) {
        best = profile;
        bestScore = score;
      }
    }
    if (best) return best;

    // 4. Built-in pass-through.
    return EMPTY_PROFILE;
  }

  private repoCandidates(provider: string): PromptProfile[] {
    if (!existsSync(this.profilesDir)) return [];
    const prefix = provider.toLowerCase();
    let files: string[];
    try {
      files = readdirSync(this.profilesDir);
    } catch {
      return [];
    }
    // Sort lexicographically so equal-specificity modelPattern ties resolve
    // deterministically to the lexicographically-first file (the strict
    // `score > bestScore` comparison keeps the first candidate), regardless
    // of filesystem/readdir order.
    files.sort();
    const out: PromptProfile[] = [];
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const base = file.slice(0, -3).toLowerCase();
      // <provider>.md or <provider>--<model-slug>.md
      if (base !== prefix && !base.startsWith(`${prefix}--`)) continue;
      let text: string;
      try {
        text = readFileSync(join(this.profilesDir, file), 'utf8');
      } catch {
        continue;
      }
      const parsed = parseProfileDocument(text, this.warn);
      if (parsed && parsed.provider.toLowerCase() === prefix) out.push(parsed);
    }
    return out;
  }
}
