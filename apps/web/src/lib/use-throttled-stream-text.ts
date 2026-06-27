import { useEffect, useRef, useState } from 'react';

/** Target reveal speed for streamed assistant tokens (~readable pace). */
export const CHARS_PER_SECOND = 40;

/**
 * Gradually reveals `fullText` while `active` is true; flushes immediately when
 * streaming ends or `active` becomes false.
 */
export function useThrottledStreamText(
  fullText: string,
  active: boolean,
  charsPerSecond = CHARS_PER_SECOND,
): string {
  const [revealedLen, setRevealedLen] = useState(() =>
    active ? 0 : fullText.length,
  );
  const targetRef = useRef(fullText);
  targetRef.current = fullText;

  useEffect(() => {
    if (!active) {
      setRevealedLen(fullText.length);
      return;
    }

    const tickMs = 50;
    const charsPerTick = Math.max(1, Math.round((charsPerSecond * tickMs) / 1000));

    const id = setInterval(() => {
      setRevealedLen((prev) => {
        const target = targetRef.current.length;
        if (prev >= target) return prev;
        return Math.min(target, prev + charsPerTick);
      });
    }, tickMs);

    return () => clearInterval(id);
  }, [active, fullText.length, charsPerSecond]);

  useEffect(() => {
    if (!active) setRevealedLen(fullText.length);
  }, [fullText, active]);

  if (!active) return fullText;
  return fullText.slice(0, revealedLen);
}
