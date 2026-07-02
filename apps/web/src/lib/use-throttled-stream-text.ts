import { useEffect, useRef, useState } from 'react';

/** Floor reveal speed when the display is nearly caught up (~reading pace). */
export const BASE_CHARS_PER_SECOND = 60;
/** Any backlog is drained linearly across this window, so the display never trails far. */
const CATCH_UP_MS = 400;
const TICK_MS = 50;
const CATCH_UP_TICKS = Math.max(1, Math.round(CATCH_UP_MS / TICK_MS));
/** Mounting into an already-streaming message animates only this much tail. */
export const MOUNT_TAIL_CHARS = 200;

/**
 * Gradually reveals `fullText` while `active` is true; flushes immediately when
 * streaming ends. Reveal speed adapts to the backlog: near-live streams read at
 * a natural pace, while a large backlog (e.g. opening a mid-stream session)
 * drains within ~400ms instead of crawling and then snapping.
 */
export function useThrottledStreamText(
  fullText: string,
  active: boolean,
  baseCharsPerSecond = BASE_CHARS_PER_SECOND,
): string {
  const [revealedLen, setRevealedLen] = useState(() =>
    active ? Math.max(0, fullText.length - MOUNT_TAIL_CHARS) : fullText.length,
  );
  const targetRef = useRef(fullText);
  const remainingTicksRef = useRef(CATCH_UP_TICKS);
  if (targetRef.current.length !== fullText.length) {
    // Fresh growth restarts the catch-up window so the drain stays linear.
    remainingTicksRef.current = CATCH_UP_TICKS;
  }
  targetRef.current = fullText;

  useEffect(() => {
    if (!active) {
      setRevealedLen(fullText.length);
      return;
    }

    const floorPerTick = Math.max(1, Math.round((baseCharsPerSecond * TICK_MS) / 1000));
    const id = setInterval(() => {
      setRevealedLen((prev) => {
        const target = targetRef.current.length;
        if (prev >= target) return prev;
        const backlog = target - prev;
        const ticksLeft = Math.max(1, remainingTicksRef.current);
        remainingTicksRef.current = ticksLeft - 1;
        const catchUpPerTick = Math.ceil(backlog / ticksLeft);
        return Math.min(target, prev + Math.max(floorPerTick, catchUpPerTick));
      });
    }, TICK_MS);

    return () => clearInterval(id);
    // fullText is intentionally not a dependency: growth is handled via targetRef
    // so the interval survives across deltas instead of resetting per token.
  }, [active, baseCharsPerSecond]);

  if (!active) return fullText;
  return revealedLen >= fullText.length ? fullText : fullText.slice(0, revealedLen);
}
