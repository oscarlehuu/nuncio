import { useEffect, useRef, useState } from 'react';
import { RevealScheduler } from './reveal-scheduler';

/**
 * Reveal streamed assistant text smoothly.
 *
 * Returns a growing prefix of `text` that fills in character-by-character while
 * the message streams, at a rate adapted to the provider's chunk cadence (see
 * {@link RevealScheduler}). Text already present at mount is shown immediately
 * (opening an in-progress session, re-hydration); only growth that lands while
 * watching animates. The reveal flushes to the full buffer the instant the
 * stream settles, the user selects text, or motion is reduced — so the rendered
 * text always equals the durable transcript whenever a user can act on it.
 *
 * @param text          durable assistant text so far (grows as deltas arrive)
 * @param streaming     true while this message is actively streaming
 * @param reduceMotion  true when the appearance setting disables motion
 */
export function useRevealedText(
  text: string,
  streaming: boolean | undefined,
  reduceMotion: boolean,
): string {
  const schedulerRef = useRef<RevealScheduler | null>(null);
  if (schedulerRef.current === null) {
    schedulerRef.current = new RevealScheduler(text.length);
  }
  const [count, setCount] = useState(text.length);
  const textRef = useRef(text);
  textRef.current = text;

  const animate = !!streaming && !reduceMotion;

  // Passthrough: historical, settled, or reduce-motion text mirrors the whole
  // durable buffer immediately (this is also the flush on turn end/interrupt/error).
  useEffect(() => {
    if (animate) return;
    schedulerRef.current!.reset(text.length);
    setCount(text.length);
  }, [animate, text]);

  // Reveal loop: only runs while streaming with motion enabled. Reads the
  // latest text via ref so a delta never restarts the loop, and is torn down
  // (no frame left scheduled) the moment the message settles or unmounts.
  useEffect(() => {
    if (!animate) return;
    let raf = requestAnimationFrame(function frame(now: number) {
      const scheduler = schedulerRef.current!;
      scheduler.observe(textRef.current.length, now);
      setCount(scheduler.tick(now));
      raf = requestAnimationFrame(frame);
    });
    return () => cancelAnimationFrame(raf);
  }, [animate]);

  // Truthful when acted upon: any pointer press flushes the reveal BEFORE the
  // browser can build a selection range against the truncated DOM, so
  // drag-select and the mouseup copy path always see the full durable text.
  // selectionchange stays as a fallback flush for keyboard selection
  // (shift+arrows, select-all).
  useEffect(() => {
    if (!animate || typeof document === 'undefined') return;
    const flush = () => setCount(schedulerRef.current!.flush());
    const onSelectionChange = () => {
      const selection = document.getSelection?.();
      if (selection && !selection.isCollapsed && selection.toString().length > 0) {
        flush();
      }
    };
    document.addEventListener('pointerdown', flush, true);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('pointerdown', flush, true);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [animate]);

  return count >= text.length ? text : text.slice(0, count);
}
