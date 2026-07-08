import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useThrottledStreamText,
  BASE_CHARS_PER_SECOND,
  MOUNT_TAIL_CHARS,
} from './use-throttled-stream-text';

describe('useThrottledStreamText', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns full text immediately when not active', () => {
    const { result } = renderHook(() =>
      useThrottledStreamText('Hello world', false),
    );
    expect(result.current).toBe('Hello world');
  });

  it('reveals a small backlog gradually at the base pace', () => {
    const long = 'a'.repeat(400);
    const { result, rerender } = renderHook(
      ({ text, active }) => useThrottledStreamText(text, active),
      { initialProps: { text: '', active: true } },
    );

    expect(result.current).toBe('');

    rerender({ text: long, active: true });
    expect(result.current.length).toBeLessThan(long.length);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    // Partial after 200ms — still animating, not snapping.
    expect(result.current.length).toBeGreaterThan(0);
    expect(result.current.length).toBeLessThan(long.length);
    expect(BASE_CHARS_PER_SECOND).toBeGreaterThanOrEqual(40);
  });

  it('drains a large backlog within roughly half a second instead of crawling', () => {
    const huge = 'x'.repeat(4000);
    const { result, rerender } = renderHook(
      ({ text, active }) => useThrottledStreamText(text, active),
      { initialProps: { text: '', active: true } },
    );

    rerender({ text: huge, active: true });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    // At the old fixed 40 chars/sec this would have taken 100 seconds.
    expect(result.current.length).toBe(huge.length);
  });

  it('starts near the tail when mounted into an already-streaming message', () => {
    const backlog = 'y'.repeat(4000);
    const { result } = renderHook(() => useThrottledStreamText(backlog, true));

    // No minute-long replay from character zero: only a short tail animates.
    expect(result.current.length).toBeGreaterThanOrEqual(backlog.length - MOUNT_TAIL_CHARS);
    expect(result.current.length).toBeLessThan(backlog.length);
  });

  it('flushes remaining text when active becomes false', () => {
    const long = 'b'.repeat(400);
    const { result, rerender } = renderHook(
      ({ text, active }) => useThrottledStreamText(text, active),
      { initialProps: { text: '', active: true } },
    );
    rerender({ text: long, active: true });
    expect(result.current.length).toBeLessThan(long.length);

    rerender({ text: long, active: false });
    expect(result.current).toBe(long);
  });

  it('catches up when full text grows while active', () => {
    const { result, rerender } = renderHook(
      ({ text, active }) => useThrottledStreamText(text, active),
      { initialProps: { text: 'Hi', active: true } },
    );

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe('Hi');

    rerender({ text: 'Hi there friend', active: true });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe('Hi there friend');
  });

  it('reveals 100% of a long backlog once the drain settles (final equality, not just growth)', () => {
    // Guards "stream không hết": length-only assertions pass while a bug leaves
    // the last chars permanently hidden. Assert the exact final string equals
    // fullText after the drain has fully settled.
    const long = `${'a'.repeat(799)}Z`; // trailing sentinel that must appear
    const { result, rerender } = renderHook(
      ({ text, active }) => useThrottledStreamText(text, active),
      { initialProps: { text: '', active: true } },
    );

    rerender({ text: long, active: true });
    act(() => {
      vi.advanceTimersByTime(5000); // well past any catch-up window
    });
    expect(result.current).toBe(long);
    expect(result.current.endsWith('Z')).toBe(true);
  });

  it('fully reveals text that keeps growing during the catch-up drain, after growth stops', () => {
    // Repeated deltas while a drain is mid-flight must not strand the tail:
    // once growth stops, ticking to steady state must land on the exact fullText.
    const { result, rerender } = renderHook(
      ({ text, active }) => useThrottledStreamText(text, active),
      { initialProps: { text: '', active: true } },
    );

    let text = '';
    for (let i = 0; i < 20; i++) {
      text += 'chunk-'.repeat(30); // 180 chars per delta, growing during drain
      rerender({ text, active: true });
      act(() => {
        vi.advanceTimersByTime(50); // one tick between deltas — drain never fully catches up mid-stream
      });
      expect(result.current.length).toBeLessThanOrEqual(text.length);
      expect(text.startsWith(result.current)).toBe(true); // never reveals ahead of source
    }

    // Growth stopped — drain to steady state must reach 100%.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(text);
  });

  it('catches up to 100% when mounted mid-stream with a backlog past MOUNT_TAIL_CHARS', () => {
    // Mounting into an already-streaming message starts near the tail (no
    // minute-long replay), but it must still converge to the WHOLE text — the
    // hidden head is revealed by the drain, not left behind forever.
    const backlog = `HEAD${'y'.repeat(MOUNT_TAIL_CHARS * 20)}TAIL`;
    const { result, rerender } = renderHook(
      ({ text, active }) => useThrottledStreamText(text, active),
      { initialProps: { text: backlog, active: true } },
    );

    // Starts near the tail, head still hidden.
    expect(result.current.length).toBeLessThan(backlog.length);

    // Keep the text stable and drain.
    rerender({ text: backlog, active: true });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(backlog);
    expect(result.current.startsWith('HEAD')).toBe(true);
    expect(result.current.endsWith('TAIL')).toBe(true);
  });

  it('reveals multibyte / surrogate-pair text exactly at completion (no mojibake)', () => {
    // slice() by char index can split a surrogate pair mid-drain, but the
    // completeness guarantee is that the FINAL revealed string equals fullText.
    const emoji = '🎉'; // surrogate pair
    const full = `Xin chào ${emoji.repeat(400)} kết thúc`;
    const { result, rerender } = renderHook(
      ({ text, active }) => useThrottledStreamText(text, active),
      { initialProps: { text: '', active: true } },
    );
    rerender({ text: full, active: true });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(full);
  });
});
