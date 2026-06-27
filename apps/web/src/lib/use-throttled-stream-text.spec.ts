import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useThrottledStreamText, CHARS_PER_SECOND } from './use-throttled-stream-text';

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

  it('reveals text gradually when active', () => {
    const long = 'a'.repeat(100);
    const { result, rerender } = renderHook(
      ({ text, active }) => useThrottledStreamText(text, active),
      { initialProps: { text: '', active: true } },
    );

    expect(result.current).toBe('');

    rerender({ text: long, active: true });
    expect(result.current.length).toBeLessThan(long.length);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.length).toBeGreaterThanOrEqual(CHARS_PER_SECOND);
    expect(result.current.length).toBeLessThan(long.length);
  });

  it('flushes remaining text when active becomes false', () => {
    const long = 'b'.repeat(80);
    const { result, rerender } = renderHook(
      ({ text, active }) => useThrottledStreamText(text, active),
      { initialProps: { text: long, active: true } },
    );

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
