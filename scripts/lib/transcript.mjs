// The session-detail chat transcript container. Reply/steer assertions MUST be
// scoped here, never to the whole page: the desktop sidebar's recent-session
// rows render each session's live preview — which is the assistant reply text
// itself (see the provider's touchPreview) — so the same short mock reply/steer
// strings appear in the sidebar unchanged. A whole-page getByText().count()
// could therefore satisfy a transcript assertion off the sidebar even when the
// detail transcript failed to render (e.g. a broken durable replay after a
// server restart). Anchoring to this container keeps every reply assertion
// honest, and the stable-node-count dedup technique intact — the count is just
// taken within the transcript subtree instead of the whole document.
export const TRANSCRIPT_SELECTOR = '[data-chat-transcript]';

/** `page.getByText` scoped to the session-detail transcript, not the whole page. */
export function transcriptText(page, text, options) {
  return page.locator(TRANSCRIPT_SELECTOR).getByText(text, options);
}
