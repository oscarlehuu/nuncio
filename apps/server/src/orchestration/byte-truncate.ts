/** UTF-8-aware byte-budget truncation shared across handoff/digest payloads. */

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Keep the leading `maxBytes` bytes of `text`, dropping any trailing partial
 * multi-byte sequence so the result never ends in a broken character.
 */
export function truncateHeadBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  return new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.slice(0, Math.max(0, maxBytes)))
    .replace(/�+$/, '');
}

/**
 * Keep the trailing `maxBytes` bytes of `text`, dropping any leading partial
 * multi-byte sequence so the result never starts with a broken character.
 */
export function truncateTailBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  return new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.slice(bytes.byteLength - Math.max(0, maxBytes)))
    .replace(/^�+/, '');
}
