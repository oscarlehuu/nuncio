// In-browser measurement probes for the UI smoothness ratchet. Every timing is
// captured with the PAGE clock (performance.now, monotonic) and the send action
// is dispatched from INSIDE the page so no Playwright round-trip leaks into the
// numbers. The harness (scripts/perf-ui-harness.mjs) drives these against a
// large seeded mock session so streaming + scroll are measured under realistic
// DOM weight. All metrics are ms, lower is better.

/** Turns of user+assistant seeded into the transcript before measuring (kept
 *  well under DETAIL_EVENT_TAIL=1000 so the whole thing renders un-capped). */
export const SEED_TURNS = 300;

const STEER_TIMEOUT_MS = 15000;

/** Tag the Send button in-page so the timing probe can dispatch it without a
 *  Playwright round-trip. Uses Playwright's robust role query to find it. */
async function tagSendButton(page) {
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await send.evaluate((el) => el.setAttribute('data-perf-send', '1'));
}

/**
 * One streaming sample: fill a steer, dispatch it from inside the page, and time
 * (a) time-to-first-delta — send → the assistant reply's first chunk visible in
 * the transcript — and (b) total main-thread blocking (sum of long-task time
 * over 50 ms) across the whole streamed reply. Returns { ttfdMs, streamBlockingMs }.
 */
export async function measureStreamingSample(page, i) {
  const steerText = `perf-steer-${i}-${Math.random().toString(36).slice(2, 8)}`;
  const composer = page.getByPlaceholder(/Steer the agent/i);
  await composer.click();
  await composer.fill(steerText);
  await tagSendButton(page);
  // The mock steer reply is `Steer received: "<steerText>". Continuing in mock
  // mode.` — assistant-only text. Earlier samples already left "Steer received"
  // in this durable transcript, so a plain includes() would fire on THIS
  // sample's user echo, not the reply. We instead count occurrences of the
  // reply head and fire when the count grows past the pre-send baseline — the
  // moment the NEW reply's first chunk lands. `fullReply` carries the unique
  // steerText, so completion can use a plain includes().
  const replyHead = 'Steer received';
  const fullReply = `Steer received: "${steerText}". Continuing in mock mode.`;

  const sample = await page.evaluate(
    async ({ replyHead, fullReply, timeout }) => {
      const transcript = document.querySelector('[data-chat-transcript]');
      const send = document.querySelector('[data-perf-send]');
      if (!transcript || !send) throw new Error('perf: transcript or send button missing');
      const countHead = (text) => {
        let n = 0;
        let idx = text.indexOf(replyHead);
        while (idx !== -1) {
          n += 1;
          idx = text.indexOf(replyHead, idx + replyHead.length);
        }
        return n;
      };
      const baseHeadCount = countHead(transcript.textContent);
      const perf = { firstDeltaAt: null };
      let blocking = 0;
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) blocking += Math.max(0, e.duration - 50);
      });
      po.observe({ entryTypes: ['longtask'] });
      const observer = new MutationObserver(() => {
        if (perf.firstDeltaAt === null && countHead(transcript.textContent) > baseHeadCount) {
          perf.firstDeltaAt = performance.now();
        }
      });
      observer.observe(transcript, { childList: true, subtree: true, characterData: true });

      const sendAt = performance.now();
      send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

      const deadline = sendAt + timeout;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      while (
        (perf.firstDeltaAt === null || !transcript.textContent.includes(fullReply)) &&
        performance.now() < deadline
      ) {
        await sleep(4);
      }
      observer.disconnect();
      po.disconnect();
      if (perf.firstDeltaAt === null) throw new Error('perf: first delta never rendered');
      if (!transcript.textContent.includes(fullReply)) throw new Error('perf: reply never completed');
      return { ttfdMs: perf.firstDeltaAt - sendAt, streamBlockingMs: blocking };
    },
    { replyHead, fullReply, timeout: STEER_TIMEOUT_MS },
  );
  return sample;
}

/**
 * One composer input-latency sample: the time from committing one keystroke into
 * the (controlled React) textarea to the browser painting the echoed character.
 * Uses the native value setter + input event so React's onChange fires, then a
 * double-rAF to the paint boundary. Frame-quantized, so treat as report-only
 * unless it proves stable on the runner.
 */
export async function measureKeyEchoSample(page) {
  const composer = page.getByPlaceholder(/Steer the agent/i);
  await composer.click();
  await composer.fill('');
  return page.evaluate(async () => {
    const textarea = document.querySelector('textarea');
    if (!textarea) throw new Error('perf: composer textarea missing');
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    ).set;
    const t0 = performance.now();
    setter.call(textarea, `${textarea.value}x`);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { keyEchoMs: performance.now() - t0 };
  });
}

/**
 * One scroll sample on the large seeded transcript: sweep the scroll position
 * top → bottom and, at each step, force the O(blocks) reflow the browser pays
 * whenever this long transcript's geometry changes — a streamed insert, a
 * resize, a scroll-into-view. (Setting scrollTop alone only dirties paint, not
 * layout, so we dirty a layout property and read it back to make the real cost
 * land inside the timed window.) This forced-reflow sweep scales cleanly with
 * transcript length and is far more stable across a shared CI runner than raw
 * per-frame timing, which is why it — not fps — is the gated smoothness budget.
 * Returns { scrollSweepMs, scrollBlocks }.
 */
export async function measureScrollSample(page) {
  return page.evaluate(() => {
    const transcript = document.querySelector('[data-chat-transcript]');
    if (!transcript) throw new Error('perf: transcript missing');
    let scroller = transcript.parentElement;
    while (scroller) {
      const oy = getComputedStyle(scroller).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && scroller.scrollHeight > scroller.clientHeight) break;
      scroller = scroller.parentElement;
    }
    if (!scroller) scroller = document.scrollingElement;
    const blocks = transcript.children.length;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const STEPS = 40;
    const prevPad = transcript.style.paddingTop;
    scroller.scrollTop = 0;
    void transcript.offsetHeight;
    const t0 = performance.now();
    for (let s = 1; s <= STEPS; s += 1) {
      scroller.scrollTop = (max * s) / STEPS;
      // Shift every child by toggling container padding → whole-subtree relayout;
      // the offsetHeight read forces it synchronously so the cost is measured.
      transcript.style.paddingTop = s % 2 ? '0px' : '1px';
      void transcript.offsetHeight;
    }
    const sweepMs = performance.now() - t0;
    transcript.style.paddingTop = prevPad; // leave the DOM as we found it
    void transcript.offsetHeight;
    return { scrollSweepMs: sweepMs, scrollBlocks: blocks };
  });
}
