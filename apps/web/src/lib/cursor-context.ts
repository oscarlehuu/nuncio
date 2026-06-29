/**
 * Detects and parses Cursor-generated context messages (from the Checks panel,
 * skills attachment, etc.) that were stored as `user` messages in the transcript.
 *
 * These messages contain Cursor-specific XML tags like `<pr_shared_context>`,
 * `<untrusted_ci_metadata>`, `<pr_check_annotations>`, `<pr_check_log_excerpt>`.
 * They're not user-typed text — Cursor composed them on the user's behalf.
 */

export interface CursorContextSection {
  tag: string;
  label: string;
  content: string;
}

export interface CursorContextMessage {
  summary: string;
  instruction: string;
  sections: CursorContextSection[];
}

const CURSOR_TAGS = [
  'pr_shared_context',
  'untrusted_ci_metadata',
  'pr_check_annotations',
  'pr_check_log_excerpt',
  'manually_attached_skills',
] as const;

const TAG_LABELS: Record<string, string> = {
  pr_shared_context: 'PR Context',
  untrusted_ci_metadata: 'CI Metadata',
  pr_check_annotations: 'Check Annotations',
  pr_check_log_excerpt: 'Check Log',
  manually_attached_skills: 'Attached Skills',
};

/** True if the text contains Cursor-specific context tags. */
export function isCursorContextMessage(text: string): boolean {
  return CURSOR_TAGS.some((tag) => text.includes(`<${tag}>`));
}

/** Extracts a PR number from a GitHub URL in the text, e.g. "PR #5". */
function extractPrLabel(text: string): string | undefined {
  const m = text.match(/pull\/(\d+)/);
  return m ? `PR #${m[1]}` : undefined;
}

/** Derives a short action label from the instruction text. */
function deriveActionLabel(instruction: string): string {
  const lower = instruction.toLowerCase();
  if (lower.includes('ci-investigator') || lower.includes('ci failure') || lower.includes('failing check')) {
    return 'CI investigation';
  }
  if (lower.includes('investigate')) return 'Investigation';
  if (lower.includes('dispatch')) return 'Subagent dispatch';
  const firstLine = instruction.split('\n')[0]?.trim() ?? '';
  if (firstLine.length <= 60) return firstLine;
  return firstLine.slice(0, 57) + '…';
}

export function parseCursorContextMessage(text: string): CursorContextMessage {
  const sections: CursorContextSection[] = [];
  let instruction = text;

  for (const tag of CURSOR_TAGS) {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    let searchFrom = 0;
    while (true) {
      const start = text.indexOf(open, searchFrom);
      if (start === -1) break;
      // Skip backtick-quoted tag names (e.g. `<untrusted_ci_metadata>` in SECURITY NOTE text)
      const charBefore = start > 0 ? text[start - 1] : '';
      if (charBefore === '`') {
        searchFrom = start + open.length;
        continue;
      }
      const end = text.indexOf(close, start);
      if (end === -1) break;
      const content = text.slice(start + open.length, end).trim();
      sections.push({ tag, label: TAG_LABELS[tag] ?? tag, content });
      // Remove this tag block from the instruction
      instruction = instruction.replace(text.slice(start, end + close.length), '');
      searchFrom = end + close.length;
    }
  }

  instruction = instruction.trim();
  const prLabel = extractPrLabel(text);
  const actionLabel = deriveActionLabel(instruction);
  const summary = prLabel ? `${actionLabel} — ${prLabel}` : actionLabel;

  return { summary, instruction, sections };
}
