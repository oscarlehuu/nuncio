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
});
