const SLOT = '{{content}}';

/**
 * Apply a profile wrapper to canonical content: every `{{content}}` occurrence
 * is replaced with `content`. The ONLY templating — no conditionals, no loops
 * (a wrapper needing logic means the canonical renderer is the right place).
 * Fail-open: a wrapper with no slot appends the content after the wrapper text
 * and warns, so a malformed wrapper never drops the canonical content. An absent
 * or empty wrapper returns the content unchanged (pass-through).
 */
export function applyWrapper(
  wrapper: string | undefined,
  content: string,
  warn: (message: string) => void,
): string {
  const w = wrapper?.trim();
  if (!w) return content;
  if (!w.includes(SLOT)) {
    warn('prompt profile wrapper has no {{content}} slot; appending content after the wrapper text');
    return `${w}\n\n${content}`;
  }
  return w.split(SLOT).join(content);
}
