import type { AgentAttachment } from './agents.types';

/** The image shape stored on a transcript event: a media-store `id` reference
 * when the image was persisted, otherwise inline base64 `data` as a fallback. */
export interface EventImage {
  mimeType: string;
  id?: string;
  data?: string;
}

/**
 * The images to persist on a `user_message` / `steer_message` event so the web
 * can replay what the user sent, not just the text. Prefers the media-store
 * `id` (keeps the event log small); falls back to inline base64 when the image
 * was never persisted. Returns `undefined` when there are none, so callers
 * spread it conditionally and keep text-only payloads unchanged.
 */
export function eventImagesFromAttachments(
  attachments?: AgentAttachment[],
): EventImage[] | undefined {
  const images = (attachments ?? [])
    .filter((a) => a.kind === 'image')
    .map((a): EventImage =>
      a.id ? { mimeType: a.mimeType, id: a.id } : { mimeType: a.mimeType, data: a.data },
    );
  return images.length > 0 ? images : undefined;
}
