import { useEffect, useRef, type RefObject } from 'react';

const NEAR_BOTTOM_PX = 80;

/**
 * Keeps a scroll container pinned to its bottom while content grows, without
 * layout-thrashing on every event: scroll reads/writes are coalesced into one
 * requestAnimationFrame per burst, and a user who scrolled up is respected
 * (unless `always` pins unconditionally, as grid tiles do).
 *
 * `resetKey` re-arms the initial scroll-to-bottom (e.g. when switching sessions).
 */
export function useStickToBottom(
  ref: RefObject<HTMLElement | null>,
  dep: unknown,
  options?: { resetKey?: unknown; always?: boolean },
): void {
  const resetKey = options?.resetKey;
  const always = options?.always ?? false;
  const pendingInitialRef = useRef(true);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    pendingInitialRef.current = true;
  }, [resetKey]);

  useEffect(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = ref.current;
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
      if (always || pendingInitialRef.current || nearBottom) {
        el.scrollTop = el.scrollHeight;
        if (el.scrollHeight > el.clientHeight) {
          pendingInitialRef.current = false;
        }
      }
    });
  }, [ref, dep, resetKey, always]);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );
}
