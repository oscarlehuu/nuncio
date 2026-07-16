// Journey (regression guard): highlighting text in the chat transcript keeps
// the selection AND auto-copies it to the clipboard on release — no Cmd/Ctrl+C.
import { createMockSession, waitSessionIdle } from '../lib/mock-session.mjs';
import { transcriptText } from '../lib/transcript.mjs';

const MARKER = 'I received your task';

export async function runTranscriptSelectionCopy(ctx) {
  const { page, baseUrl, waitFor, record } = ctx;

  const setup = record('selection: open a settled mock session with a reply to highlight');
  const session = await createMockSession(baseUrl, 'Selection smoke: produce a reply to highlight');
  await page.goto(`${baseUrl}/session/${session.id}`, { waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await transcriptText(page, MARKER, { exact: false }).count()) > 0, {
    label: 'assistant reply to highlight',
  });
  await waitSessionIdle(baseUrl, session.id, waitFor);
  setup.ok = true;

  const highlight = record('selection: highlight survives release and auto-copies to clipboard');
  // Programmatically select the reply text inside the transcript root, then fire
  // the same mouseup the drag-select would — deterministic, no real drag/sleep.
  const selected = await page.evaluate((marker) => {
    const root = document.querySelector('[data-chat-transcript]');
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let textNode = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.textContent && n.textContent.includes(marker)) {
        textNode = n;
        break;
      }
    }
    if (!textNode) return null;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return sel.toString();
  }, MARKER);
  if (!selected || !selected.includes(MARKER)) {
    throw new Error(`could not select the reply text inside the transcript (got: ${selected})`);
  }

  // The selection must NOT be cleared by the highlight/copy handler.
  await waitFor(
    async () => {
      const survived = await page.evaluate(() => window.getSelection()?.toString() ?? '');
      return survived.includes(MARKER);
    },
    { label: 'selection survives after release' },
  );

  // Auto-copy landed on the clipboard (context granted clipboard permissions).
  await waitFor(
    async () => {
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
      return clip.includes(MARKER);
    },
    { label: 'selection auto-copied to clipboard' },
  );

  // And the user got the "Copied" confirmation toast.
  await waitFor(async () => (await page.getByText('Copied', { exact: true }).count()) > 0, {
    label: '"Copied" toast shown',
  });
  highlight.ok = true;
  highlight.detail = 'highlight retained + auto-copied + toast';
}
