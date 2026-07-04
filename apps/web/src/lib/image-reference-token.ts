/**
 * Prompt-text references for staged images. Pasting an image drops a token like
 * `[image 1]` into the prompt so the agent can correlate prose ("fix the bug in
 * [image 1]") with the Nth attached image. The label is owned by the attachment
 * (monotonic, never reused), so tokens stay unambiguous even after a removal.
 */

export function imageReferenceToken(label: string): string {
  return `[${label}]`;
}

/** Append reference tokens to the prompt, spaced so they never fuse with a word. */
export function appendImageTokens(text: string, labels: string[]): string {
  if (labels.length === 0) return text;
  const tokens = labels.map(imageReferenceToken).join(' ');
  if (text.length === 0) return tokens;
  const sep = /\s$/.test(text) ? '' : ' ';
  return `${text}${sep}${tokens}`;
}

/** Remove a single image's token from the prompt (used when its thumbnail is
 * removed) and collapse the whitespace it leaves behind. */
export function stripImageToken(text: string, label: string): string {
  const token = imageReferenceToken(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .replace(new RegExp(`\\s?${token}`), '')
    .replace(/[ \t]{2,}/g, ' ')
    .trimEnd();
}
