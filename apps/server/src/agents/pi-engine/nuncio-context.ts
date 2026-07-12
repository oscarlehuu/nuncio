import { Injectable } from '@nestjs/common';
import { ContextFactsService } from '../../context/context-facts.service';
import type { ContextFactDto } from '../../context/context-facts.types';
import { DatabaseService } from '../../db/database.service';
import { byteLength, truncateHeadBytes } from '../../orchestration/byte-truncate';
import { renderHandoffBrief } from '../../orchestration/handoff-brief.renderer';
import type { HandoffBrief } from '../../orchestration/handoff-brief.types';
import { validateHandoffBrief } from '../../orchestration/handoff-brief.validate';

export const NUNCIO_CONTEXT_MAX_BYTES = 4096;

const HEADER = '## Nuncio project context';
const FACTS_HEADER = '### Project facts';
const FACTS_OMITTED = '_(additional project facts omitted)_';
const TRUNCATED = '_(Nuncio context truncated)_';

export interface NuncioContextInput {
  facts: ContextFactDto[];
  brief?: HandoffBrief | null;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function orderedFacts(facts: ContextFactDto[]): ContextFactDto[] {
  return [...facts].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return compareText(a.key, b.key) || compareText(a.id, b.id);
  });
}

function renderFacts(facts: ContextFactDto[], maxBytes: number): string {
  const prefix = `${HEADER}\n\n${FACTS_HEADER}`;
  const lines: string[] = [];
  let omitted = 0;

  for (const fact of orderedFacts(facts)) {
    const line = `- **${fact.key}**: ${fact.value}`;
    if (byteLength([prefix, ...lines, line].join('\n')) <= maxBytes) lines.push(line);
    else omitted += 1;
  }

  if (omitted > 0) {
    while (
      lines.length > 0 &&
      byteLength([prefix, ...lines, FACTS_OMITTED].join('\n')) > maxBytes
    ) {
      lines.pop();
    }
    if (byteLength([prefix, ...lines, FACTS_OMITTED].join('\n')) <= maxBytes) {
      lines.push(FACTS_OMITTED);
    }
  }

  return [prefix, ...lines].join('\n');
}

function completeSentencePrefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const head = truncateHeadBytes(text, maxBytes);
  const endings = /[.!?](?=\s|$)/g;
  let end = 0;
  for (const match of head.matchAll(endings)) end = (match.index ?? 0) + match[0].length;
  return end > 0 ? head.slice(0, end).trimEnd() : '';
}

/**
 * Build the Pi-only managed context. Facts are authoritative and consume the
 * budget first; the latest brief uses only the remaining complete sentences.
 */
export function buildNuncioContext(
  input: NuncioContextInput,
  maxBytes = NUNCIO_CONTEXT_MAX_BYTES,
): string {
  if (input.facts.length === 0 || maxBytes <= byteLength(`${HEADER}\n\n${FACTS_HEADER}`)) return '';

  const facts = renderFacts(input.facts, maxBytes);
  if (!input.brief) return facts;

  const renderedBrief = renderHandoffBrief(input.brief);
  const separator = '\n\n';
  const full = `${facts}${separator}${renderedBrief}`;
  if (byteLength(full) <= maxBytes) return full;

  const suffix = `\n\n${TRUNCATED}`;
  const available = maxBytes - byteLength(facts) - byteLength(separator) - byteLength(suffix);
  const briefPrefix = completeSentencePrefix(renderedBrief, available);
  if (!briefPrefix) return facts;

  return `${facts}${separator}${briefPrefix}${suffix}`;
}

type BriefRow = { context_json: string };

@Injectable()
export class NuncioContextRepository {
  constructor(private readonly database: DatabaseService) {}

  latestBrief(projectPath: string): HandoffBrief | null {
    const rows = this.database.db
      .prepare<BriefRow, [string]>(
        `SELECT context_json FROM tasks
         WHERE project_path = ? AND context_json IS NOT NULL
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(projectPath);

    for (const row of rows) {
      try {
        return validateHandoffBrief(JSON.parse(row.context_json));
      } catch {
        // Older or hand-edited rows fail closed; keep looking for the latest valid brief.
      }
    }
    return null;
  }
}

@Injectable()
export class NuncioContextService {
  constructor(
    private readonly facts: ContextFactsService,
    private readonly contextRepository: NuncioContextRepository,
  ) {}

  buildForProject(
    projectPath: string | null,
    maxBytes = NUNCIO_CONTEXT_MAX_BYTES,
  ): string {
    if (!projectPath) return '';
    const facts = this.facts.list(projectPath);
    if (facts.length === 0) return '';
    return buildNuncioContext({
      facts,
      brief: this.contextRepository.latestBrief(projectPath),
    }, maxBytes);
  }
}
