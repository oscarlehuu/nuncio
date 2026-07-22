import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRevealedText } from './use-revealed-text';

/** Advance the faked animation clock by `ms` inside act(). */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('useRevealedText', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'setTimeout',
        'clearTimeout',
        'Date',
        'performance',
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('passes text through untouched when reduce-motion is on', () => {
    const text = 'The quick brown fox';
    const { result, rerender } = renderHook(
      ({ t }) => useRevealedText(t, true, true),
      { initialProps: { t: text } },
    );
    expect(result.current).toBe(text);
    // Growth is revealed immediately (no animation) under reduce-motion.
    rerender({ t: text + ' jumps over' });
    expect(result.current).toBe(text + ' jumps over');
    advance(1000);
    expect(result.current).toBe(text + ' jumps over');
  });

  it('passes text through untouched when not streaming (historical / settled)', () => {
    const { result } = renderHook(() => useRevealedText('done answer', false, false));
    expect(result.current).toBe('done answer');
    advance(1000);
    expect(result.current).toBe('done answer');
  });

  it('shows mount text and the first chunk immediately, then paces later growth', () => {
    const { result, rerender } = renderHook(
      ({ t }) => useRevealedText(t, true, false),
      { initialProps: { t: 'Hello' } },
    );
    // Pre-existing text is not withheld (opening a running session).
    expect(result.current).toBe('Hello');

    // The first chunk after mount shows whole, at once — time-to-first-text
    // is perceived latency and is never paced.
    const first = 'Hello world';
    rerender({ t: first });
    advance(16);
    expect(result.current).toBe(first);
    advance(500); // realistic inter-chunk gap so the rate estimate stays sane

    // A later big chunk reveals gradually, not at once.
    const grown = first + 'x'.repeat(400);
    rerender({ t: grown });
    advance(64); // a few frames in
    expect(result.current.length).toBeGreaterThan(first.length);
    expect(result.current.length).toBeLessThan(grown.length);
    expect(grown.startsWith(result.current)).toBe(true); // always a clean prefix

    // Given enough time it fully converges to the durable buffer.
    advance(5000);
    expect(result.current).toBe(grown);
  });

  it('flushes instantly to the full buffer when streaming ends (turn end / interrupt / error)', () => {
    const grown = 'partial!' + 'y'.repeat(400);
    const { result, rerender } = renderHook(
      ({ t, s }) => useRevealedText(t, s, false),
      { initialProps: { t: 'partial', s: true } },
    );
    rerender({ t: 'partial!', s: true }); // first chunk: instant primer
    advance(500);
    rerender({ t: grown, s: true });
    advance(32);
    expect(result.current.length).toBeLessThan(grown.length); // mid-reveal

    // Turn settles → the final rendered text equals the durable transcript.
    rerender({ t: grown, s: false });
    expect(result.current).toBe(grown);
  });

  it('flushes instantly when the user makes a text selection (copy stays truthful)', () => {
    const grown = 'answer!' + 'z'.repeat(400);
    const { result, rerender } = renderHook(
      ({ t }) => useRevealedText(t, true, false),
      { initialProps: { t: 'answer' } },
    );
    rerender({ t: 'answer!' }); // first chunk: instant primer
    advance(500);
    rerender({ t: grown });
    advance(32);
    expect(result.current.length).toBeLessThan(grown.length);

    vi.spyOn(document, 'getSelection').mockReturnValue({
      isCollapsed: false,
      toString: () => 'zzz',
    } as unknown as Selection);
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(result.current).toBe(grown);
  });

  it('flushes on pointer press, before the browser can build a selection range', () => {
    const grown = 'answer!' + 'z'.repeat(400);
    const { result, rerender } = renderHook(
      ({ t }) => useRevealedText(t, true, false),
      { initialProps: { t: 'answer' } },
    );
    rerender({ t: 'answer!' }); // first chunk: instant primer
    advance(500);
    rerender({ t: grown });
    advance(32);
    expect(result.current.length).toBeLessThan(grown.length);

    act(() => {
      document.dispatchEvent(new Event('pointerdown'));
    });
    expect(result.current).toBe(grown);
  });

  it('leaves no animation frame scheduled once the message settles', () => {
    const cancelSpy = vi.spyOn(globalThis, 'cancelAnimationFrame');
    const grown = 'a' + 'b'.repeat(200);
    const { rerender } = renderHook(
      ({ t, s }) => useRevealedText(t, s, false),
      { initialProps: { t: 'a', s: true } },
    );
    rerender({ t: grown, s: true });
    advance(32);
    rerender({ t: grown, s: false });
    // The reveal loop is torn down when streaming stops.
    expect(cancelSpy).toHaveBeenCalled();
  });
});
