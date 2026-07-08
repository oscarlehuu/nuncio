import { byteLength } from '../orchestration/byte-truncate';
import type { ProfileSections, ProfileStatus, PromptProfile } from './prompt-profile.types';

export type WarnFn = (message: string) => void;

/**
 * Ceiling per profile section (serialized bytes) — an oversized section is
 * dropped with a warning (pass-through for that section), never truncated.
 */
const SECTION_MAX_BYTES = 2048;

/** Section heading (kebab) → the ProfileSections field it fills. */
const SECTION_FIELDS: Record<string, keyof ProfileSections> = {
  'brief-wrapper': 'briefWrapper',
  'facts-wrapper': 'factsWrapper',
  'digest-wrapper': 'digestWrapper',
  'tools-preamble': 'toolsPreamble',
  idioms: 'idioms',
};

/** Parse a flat `key: value` scalar line; ignores nested/complex YAML (evalScore is informational). */
function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    // Strip surrounding quotes.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Strip HTML comments and trim a section body to its meaningful text. */
function cleanSection(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

const STATUSES: readonly ProfileStatus[] = ['draft', 'active', 'retired'];

/** A context file name must be a bare filename — no separators, no traversal, not absolute. */
function isBareFileName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    name !== '.' &&
    name !== '..'
  );
}

/**
 * Parse a profile document (YAML frontmatter + `## section` bodies). Returns null
 * (skip) with a single warning on malformed input — the caller falls through to
 * the next precedence level. Unknown sections warn but do not fail, so an old
 * daemon tolerates a newer profile.
 */
export function parseProfileDocument(text: string, warn: WarnFn): PromptProfile | null {
  // Normalize CRLF / lone CR to LF so Windows-authored profiles parse identically.
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const trimmedStart = normalized.replace(/^\uFEFF/, '');
  if (!trimmedStart.startsWith('---')) {
    warn('prompt profile skipped: missing YAML frontmatter');
    return null;
  }
  // Find the closing '---' on its own line after the opening.
  const rest = trimmedStart.slice(3);
  const closeMatch = rest.match(/\n---[ \t]*(?:\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) {
    warn('prompt profile skipped: unterminated frontmatter block');
    return null;
  }
  const frontmatterBlock = rest.slice(0, closeMatch.index);
  const body = rest.slice(closeMatch.index + closeMatch[0].length);

  const fm = parseFrontmatter(frontmatterBlock);
  const provider = fm.provider?.trim();
  if (!provider) {
    warn('prompt profile skipped: missing required `provider`');
    return null;
  }

  const versionNum = Number(fm.version);
  const version = Number.isInteger(versionNum) ? versionNum : 1;
  const status: ProfileStatus = STATUSES.includes(fm.status as ProfileStatus)
    ? (fm.status as ProfileStatus)
    : 'draft';

  const sections: ProfileSections = {};
  // Split the body on `## heading` lines.
  const parts = body.split(/\n(?=## )/);
  for (const part of parts) {
    const headingMatch = part.match(/^##[ \t]+([^\n]+)\n?([\s\S]*)$/);
    if (!headingMatch) continue;
    const heading = headingMatch[1]!.trim();
    const field = SECTION_FIELDS[heading];
    if (!field) {
      warn(`prompt profile: unknown section "${heading}" ignored`);
      continue;
    }
    const cleaned = cleanSection(headingMatch[2] ?? '');
    if (byteLength(cleaned) > SECTION_MAX_BYTES) {
      warn(`prompt profile: section "${heading}" exceeds ${SECTION_MAX_BYTES} bytes; section dropped`);
      continue;
    }
    sections[field] = cleaned;
  }

  const rawContextFileName = fm.contextFileName?.trim();
  let contextFileName: string | undefined;
  if (rawContextFileName) {
    if (isBareFileName(rawContextFileName)) {
      contextFileName = rawContextFileName;
    } else {
      warn(`prompt profile: contextFileName "${rawContextFileName}" is not a bare filename; field dropped`);
    }
  }

  return {
    provider,
    modelPattern: fm.modelPattern?.trim() || '*',
    version,
    status,
    ...(contextFileName ? { contextFileName } : {}),
    sections,
  };
}
