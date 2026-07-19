import { byteLength } from '../../orchestration/byte-truncate';

/**
 * Nuncio's compaction policy on Pi's `session_before_compact` seam
 * (plans/260719-engine-shell-and-compaction, phase 05). Pi keeps the machinery
 * — trigger, cut point, session-file write, reload — while this handler owns
 * what survives, assembled on the Grok Build principle that critical state is
 * re-injected verbatim rather than trusted to a summarizer:
 *
 *   [pinned session state (survivors, verbatim)]
 *   [recent user instructions (verbatim, byte budget)]
 *   [cheap-model narrative of the discarded remainder (incremental)]
 *   [files touched ledger]
 *   [durable-history pointer]
 *
 * Every failure path returns `undefined`, which hands compaction back to Pi's
 * default path — this layer can degrade, never brick a session.
 */

interface CompactionPreparationLike {
  firstKeptEntryId: string;
  tokensBefore: number;
  isSplitTurn: boolean;
  messagesToSummarize: unknown[];
  turnPrefixMessages: unknown[];
  previousSummary?: string;
  fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> };
  settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
}

export interface SessionBeforeCompactEventLike {
  type: 'session_before_compact';
  reason: 'manual' | 'threshold' | 'overflow';
  willRetry: boolean;
  preparation: CompactionPreparationLike;
  customInstructions?: string;
  signal?: AbortSignal;
}

export interface CompactionSummarizeInput {
  /** Discarded messages (turn-prefix messages folded in on a split turn). */
  messages: unknown[];
  previousSummary?: string;
  customInstructions?: string;
  signal?: AbortSignal;
  /** Token reserve from the live compaction settings (bounds the summary length). */
  reserveTokens?: number;
}

/** Appended last to every Nuncio-assembled compaction summary. */
export const COMPACTION_TRANSCRIPT_POINTER =
  'Note: the full pre-compaction conversation survives in the durable Nuncio event log. '
  + 'Use the read_session_history tool to re-read compacted turns when a detail above is not enough.';

export interface CompactionHandlerDeps {
  /** Live toggle — resolved per compaction, not baked at session creation. */
  enabled(): boolean;
  /** Pinned-state block from the durable event log ('' when nothing to pin). */
  buildSurvivors(): string;
  /** Narrative summarizer (cheap model preferred); may throw — handler fails open. */
  summarize(input: CompactionSummarizeInput): Promise<string>;
  /** Appended last: where the full history lives and how to re-read it. */
  transcriptPointer: string;
  /** Byte budget for verbatim user messages (~4K tokens by default). */
  verbatimUserBudgetBytes?: number;
}

export interface CompactionHandlerResult {
  compaction?: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
  };
}

const DEFAULT_VERBATIM_USER_BUDGET_BYTES = 16_000;
const MAX_FILES_PER_LINE = 30;
const MIN_SUMMARY_CHARS = 20;
const MIN_DISTINCT_CHARS = 3;

function messageText(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null;
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== 'user') return null;
  if (typeof record.content === 'string') return record.content;
  if (Array.isArray(record.content)) {
    const text = record.content
      .filter((block): block is { type: string; text: string } =>
        typeof block === 'object' && block !== null
        && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
    return text || null;
  }
  return null;
}

/**
 * Render discarded user messages verbatim, newest-first selection within the
 * byte budget (whole messages only), displayed oldest-first. The Codex lesson:
 * user intent must never exist only inside a summary.
 */
export function renderVerbatimUserMessages(messages: unknown[], budgetBytes: number): string {
  const texts = messages
    .map(messageText)
    .filter((text): text is string => text !== null && text.trim().length > 0);
  if (texts.length === 0) return '';
  const header = '## Recent user instructions (verbatim)';
  const kept: string[] = [];
  let used = byteLength(header);
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    const line = `- ${texts[i]!.trim()}`;
    const cost = byteLength(line) + 1;
    if (used + cost > budgetBytes) break;
    kept.push(line);
    used += cost;
  }
  if (kept.length === 0) return '';
  kept.reverse();
  return [header, ...kept].join('\n');
}

/**
 * Conservative garbage detector for the narrative summary: empty, trivially
 * short, or near-single-character output. Anything borderline passes — the
 * skeleton already carries everything critical verbatim.
 */
export function isDegenerateSummary(summary: string): boolean {
  const trimmed = summary.trim();
  if (trimmed.length < MIN_SUMMARY_CHARS) return true;
  const distinct = new Set(trimmed.replace(/\s/g, '').split(''));
  return distinct.size < MIN_DISTINCT_CHARS;
}

function fileOpsSection(fileOps: CompactionPreparationLike['fileOps']): string {
  const lines: string[] = [];
  const read = [...fileOps.read].slice(0, MAX_FILES_PER_LINE);
  const edited = [...new Set([...fileOps.written, ...fileOps.edited])].slice(0, MAX_FILES_PER_LINE);
  if (read.length > 0) lines.push(`Files read: ${read.join(', ')}`);
  if (edited.length > 0) lines.push(`Files edited: ${edited.join(', ')}`);
  return lines.join('\n');
}

export function buildCompactionHandler(
  deps: CompactionHandlerDeps,
): (event: SessionBeforeCompactEventLike) => Promise<CompactionHandlerResult | undefined> {
  const verbatimBudget = deps.verbatimUserBudgetBytes ?? DEFAULT_VERBATIM_USER_BUDGET_BYTES;
  return async (event) => {
    try {
      if (!deps.enabled()) return undefined;
      const preparation = event.preparation;
      if (typeof preparation?.firstKeptEntryId !== 'string' || !preparation.firstKeptEntryId) {
        return undefined;
      }
      if (typeof preparation.tokensBefore !== 'number') return undefined;

      const survivors = deps.buildSurvivors();
      const verbatimUsers = renderVerbatimUserMessages(
        preparation.messagesToSummarize,
        verbatimBudget,
      );
      const narrativeInput: CompactionSummarizeInput = {
        messages: preparation.isSplitTurn
          ? [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]
          : preparation.messagesToSummarize,
        ...(preparation.previousSummary ? { previousSummary: preparation.previousSummary } : {}),
        ...(event.customInstructions ? { customInstructions: event.customInstructions } : {}),
        ...(event.signal ? { signal: event.signal } : {}),
        ...(typeof preparation.settings?.reserveTokens === 'number'
          ? { reserveTokens: preparation.settings.reserveTokens }
          : {}),
      };
      let narrative = await deps.summarize(narrativeInput);
      if (isDegenerateSummary(narrative)) {
        narrative = await deps.summarize(narrativeInput);
        if (isDegenerateSummary(narrative)) return undefined;
      }

      const summary = [
        survivors,
        verbatimUsers,
        narrative.trim(),
        fileOpsSection(preparation.fileOps),
        deps.transcriptPointer,
      ]
        .filter((section) => section.trim().length > 0)
        .join('\n\n');

      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
        },
      };
    } catch {
      // Fail open on every path: Pi's default compaction takes over.
      return undefined;
    }
  };
}
