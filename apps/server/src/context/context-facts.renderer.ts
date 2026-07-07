import { byteLength } from '../orchestration/byte-truncate';
import type { ContextFactDto } from './context-facts.types';

const HEADER = '## Project facts (managed by nuncio)';

export interface RenderFactsOptions {
  /** When true, the omission footer points the engine at the read tools. */
  toolsEnabled: boolean;
}

function factLine(fact: ContextFactDto): string {
  return `- **${fact.key}**: ${fact.value}`;
}

/** Pinned first, then updated_at desc (stable by key for ties). */
function ordered(facts: ContextFactDto[]): ContextFactDto[] {
  return [...facts].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return a.key.localeCompare(b.key);
  });
}

/**
 * Render the project's facts as a compact, budgeted markdown block for a session
 * preamble. Empty store → '' (no header). Facts are packed greedily (pinned
 * first, then newest); a fact that would exceed the budget is skipped WHOLE
 * (never truncated mid-fact), and an omission footer notes the count — pointing
 * at the context tools only when they are enabled for this session.
 */
export function renderContextFacts(
  facts: ContextFactDto[],
  budgetBytes: number,
  options: RenderFactsOptions,
): string {
  if (facts.length === 0) return '';

  const sorted = ordered(facts);
  const kept: string[] = [];
  let used = byteLength(HEADER);
  let omitted = 0;

  for (const fact of sorted) {
    const line = factLine(fact);
    const cost = byteLength(line) + 1; // + joining newline
    // Reserve room for a possible footer so the byte ceiling holds even when the
    // last-fitting fact leaves no space for the omission note.
    if (used + cost <= budgetBytes) {
      kept.push(line);
      used += cost;
    } else {
      omitted += 1;
    }
  }

  if (kept.length === 0) {
    // Nothing fit at all — surface only the omission note under the header.
    return [HEADER, footer(facts.length, options)].join('\n');
  }

  const parts = [HEADER, ...kept];
  if (omitted > 0) {
    // Make room for the footer by shedding the oldest kept lines if needed.
    let note = footer(omitted, options);
    while (byteLength([...parts, note].join('\n')) > budgetBytes && parts.length > 1) {
      parts.splice(1, 1); // drop the oldest kept fact
      omitted += 1;
      note = footer(omitted, options);
    }
    parts.push(note);
  }
  return parts.join('\n');
}

function footer(count: number, options: RenderFactsOptions): string {
  return options.toolsEnabled
    ? `_(${count} more facts omitted — ask via context tools)_`
    : `_(${count} more facts omitted)_`;
}
