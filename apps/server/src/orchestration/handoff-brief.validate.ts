import type { HandoffBrief } from './handoff-brief.types';

const MAX_BRIEF_BYTES = 8192;

/**
 * Validate an untrusted brief arriving over the API. Returns the brief when it
 * is well-formed, or throws with a caller-facing message. `goal` is required
 * and non-empty; list fields must be arrays of strings; the serialized brief
 * must stay under the 8 KB pre-render ceiling.
 */
export function validateHandoffBrief(input: unknown): HandoffBrief {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('contextBrief must be an object');
  }
  const brief = input as Record<string, unknown>;

  if (typeof brief.goal !== 'string' || brief.goal.trim().length === 0) {
    throw new Error('contextBrief.goal is required and must be a non-empty string');
  }

  for (const field of ['constraints', 'decisions', 'files', 'doneCriteria'] as const) {
    const value = brief[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new Error(`contextBrief.${field} must be an array of strings`);
    }
  }

  if (brief.verifyCommand !== undefined && typeof brief.verifyCommand !== 'string') {
    throw new Error('contextBrief.verifyCommand must be a string');
  }

  const bytes = new TextEncoder().encode(JSON.stringify(brief)).byteLength;
  if (bytes > MAX_BRIEF_BYTES) {
    throw new Error('contextBrief exceeds the 8KB limit');
  }

  return brief as unknown as HandoffBrief;
}
