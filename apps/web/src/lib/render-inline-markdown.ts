/**
 * Minimal inline-markdown tokenizer for changelog entry text.
 *
 * Handles the three constructs that appear in Changesets entries:
 *   - **bold**
 *   - `code`
 *   - [label](href)
 *
 * Returns a flat token list the UI maps to React nodes. Intentionally not a
 * full CommonMark parser — changelog entries are single-line and simple.
 */

export type InlineToken =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; label: string; href: string };

const TOKEN_RE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;

export function tokenizeInlineMarkdown(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) tokens.push({ type: 'text', value: text.slice(last, m.index) });
    if (m[1] !== undefined) tokens.push({ type: 'bold', value: m[1] });
    else if (m[2] !== undefined) tokens.push({ type: 'code', value: m[2] });
    else if (m[3] !== undefined) tokens.push({ type: 'link', label: m[3], href: m[4] });
    last = TOKEN_RE.lastIndex;
  }
  if (last < text.length) tokens.push({ type: 'text', value: text.slice(last) });
  return tokens;
}
