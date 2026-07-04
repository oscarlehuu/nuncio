/**
 * A media attachment carried alongside a chat message.
 *
 * Discriminated by `kind` so new media types (video, file, …) slot in without
 * touching existing call sites. The wire shape mirrors the server's
 * `AgentAttachment` 1:1 — exactly what the create-session and `/steer`
 * endpoints already accept — so a `MessageAttachment[]` can be sent as-is.
 *
 * `data` is always raw base64 (no `data:` prefix); rebuild a browser-usable URL
 * with {@link attachmentDataUrl}.
 */
export interface ImageAttachment {
  kind: 'image';
  /** MIME type, e.g. "image/png". */
  mimeType: string;
  /** Base64-encoded bytes, no `data:` prefix. */
  data: string;
}

/** Any attachment a chat message can carry. Extend the union as providers gain
 * support (e.g. `| VideoAttachment`) — capability gating stays in the DTO. */
export type MessageAttachment = ImageAttachment;

export function isImageAttachment(a: MessageAttachment): a is ImageAttachment {
  return a.kind === 'image';
}

/** Reconstruct a `data:` URL an `<img src>` / CSS background can consume. */
export function attachmentDataUrl(a: ImageAttachment): string {
  return `data:${a.mimeType};base64,${a.data}`;
}

/**
 * An image as it appears in a transcript event — either a media-store `id`
 * reference (the durable form; bytes are served on demand) or inline base64
 * `data` (legacy / write-failure fallback). The render layer resolves whichever
 * is present with {@link transcriptImageSrc}.
 */
export interface TranscriptImage {
  mimeType: string;
  id?: string;
  data?: string;
}

/** Resolve a transcript image to a usable `<img src>`: the media endpoint when
 * it carries an id, otherwise an inline data URL. `base` targets a remote hub
 * machine when set. Returns '' when neither is present. */
export function transcriptImageSrc(image: TranscriptImage, sessionId: string, base = ''): string {
  if (image.id) return `${base}/api/sessions/${sessionId}/media/${image.id}`;
  if (image.data) return `data:${image.mimeType};base64,${image.data}`;
  return '';
}
