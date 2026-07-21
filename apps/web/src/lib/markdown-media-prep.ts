/**
 * Forge / GitHub comment bodies often wrap media in <details><summary>…</summary>.
 * react-markdown does not parse raw HTML, so those wrappers would swallow the
 * inner markdown (images included). Strip the tags, keep the content.
 */
export function unwrapDetailsHtml(raw: string): string {
  return raw
    .replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/gi, '')
    .replace(/<\/?details\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const VIDEO_EXT = /\.(mp4|webm|mov)$/i;

/** True when the href path ends in a known video extension (query/hash ignored). */
export function isVideoUrl(href: string): boolean {
  try {
    const url = new URL(href);
    return VIDEO_EXT.test(url.pathname);
  } catch {
    return false;
  }
}
