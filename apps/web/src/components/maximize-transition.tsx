import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

/**
 * Shared-element (FLIP) transition for maximizing a grid tile into the full
 * session view and back. On mount the panel grows from the tile's on-screen rect
 * (`originRect`); when `closing` flips true it shrinks back to that same rect and
 * then calls `onExited` so the caller can unmount and restore the grid — this is
 * what tells the user which slot a session came from.
 *
 * The grid itself is not kept mounted behind the panel (tiles are unmounted while
 * maximized, by design), so there is no live "push back"; the spatial cue is the
 * grow-from / shrink-to-slot motion plus the content cross-fade.
 */

// Gentle easing + timings dialed in on the interactive prototype.
const EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
const ENTER_MS = 500;
const EXIT_MS = 430;
const TILE_RADIUS = '14px';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const canAnimate = (el: Element | null): el is HTMLElement =>
  !!el && typeof (el as HTMLElement).animate === 'function';

interface MaximizeTransitionProps {
  /** Tile rect captured at maximize time. Null → no enter animation (e.g. keyboard
   *  maximize where the tile could not be located). */
  originRect: DOMRect | null;
  /** Flip true to play the shrink-back animation; resolves via `onExited`. */
  closing: boolean;
  /** Called once the exit animation finishes (or immediately when it is skipped). */
  onExited: () => void;
  children: ReactNode;
}

export function MaximizeTransition({ originRect, closing, onExited, children }: MaximizeTransitionProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const enteredRef = useRef(false);
  const exitingRef = useRef(false);

  // ENTER — grow from the origin tile rect. useLayoutEffect so the inverted
  // (tile-sized) start frame is applied before the browser paints the full panel.
  useLayoutEffect(() => {
    if (enteredRef.current) return;
    enteredRef.current = true;
    const container = containerRef.current;
    if (!originRect || prefersReducedMotion() || !canAnimate(container)) return;

    const last = container.getBoundingClientRect();
    if (last.width === 0 || last.height === 0) return;
    const dx = originRect.left - last.left;
    const dy = originRect.top - last.top;
    const sx = originRect.width / last.width;
    const sy = originRect.height / last.height;

    container.style.transformOrigin = 'top left';
    container.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, borderRadius: TILE_RADIUS },
        { transform: 'translate(0px, 0px) scale(1, 1)', borderRadius: '0px' },
      ],
      { duration: ENTER_MS, easing: EASE, fill: 'none' },
    );
    // Cross-fade the content in so the non-uniform scale never shows as a squish.
    innerRef.current?.animate(
      [{ opacity: 0, offset: 0 }, { opacity: 0, offset: 0.28 }, { opacity: 1, offset: 1 }],
      { duration: ENTER_MS, easing: EASE, fill: 'none' },
    );
  }, [originRect]);

  // EXIT — shrink back to the origin tile rect, then hand control back to unmount.
  useEffect(() => {
    if (!closing || exitingRef.current) return;
    exitingRef.current = true;
    const container = containerRef.current;
    if (!originRect || prefersReducedMotion() || !canAnimate(container)) {
      onExited();
      return;
    }

    const last = container.getBoundingClientRect();
    if (last.width === 0 || last.height === 0) {
      onExited();
      return;
    }
    const dx = originRect.left - last.left;
    const dy = originRect.top - last.top;
    const sx = originRect.width / last.width;
    const sy = originRect.height / last.height;

    container.style.transformOrigin = 'top left';
    const anim = container.animate(
      [
        { transform: 'translate(0px, 0px) scale(1, 1)', borderRadius: '0px' },
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, borderRadius: TILE_RADIUS },
      ],
      { duration: EXIT_MS, easing: EASE, fill: 'forwards' },
    );
    innerRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: Math.round(EXIT_MS * 0.7),
      easing: EASE,
      fill: 'forwards',
    });
    // Finish OR cancel both hand back, so an interrupted close can never wedge the
    // panel open over a hidden grid.
    anim.finished.then(onExited, onExited);
  }, [closing, originRect, onExited]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 flex flex-col min-h-0 overflow-hidden bg-background will-change-transform"
    >
      <div ref={innerRef} className="flex flex-1 flex-col min-h-0">
        {children}
      </div>
    </div>
  );
}
