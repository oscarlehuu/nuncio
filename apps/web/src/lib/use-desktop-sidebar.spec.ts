import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDesktopSidebar } from './use-desktop-sidebar';

describe('useDesktopSidebar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens on hover and closes after the pointer leaves', () => {
    const { result } = renderHook(() => useDesktopSidebar());

    act(() => result.current.openHover());
    expect(result.current.hovered).toBe(true);
    expect(result.current.open).toBe(true);

    act(() => result.current.scheduleCloseHover());
    act(() => vi.advanceTimersByTime(180));
    expect(result.current.hovered).toBe(false);
    expect(result.current.open).toBe(false);
  });

  it('pins open on toggle and ignores hover close while pinned', () => {
    const { result } = renderHook(() => useDesktopSidebar());

    act(() => result.current.togglePin());
    expect(result.current.pinned).toBe(true);
    expect(result.current.open).toBe(true);

    act(() => result.current.scheduleCloseHover());
    act(() => vi.advanceTimersByTime(180));
    expect(result.current.pinned).toBe(true);
    expect(result.current.open).toBe(true);
  });

  it('unpins and collapses on the second toggle', () => {
    const { result } = renderHook(() => useDesktopSidebar());

    act(() => {
      result.current.togglePin();
      result.current.openHover();
    });
    expect(result.current.pinned).toBe(true);

    act(() => result.current.togglePin());
    expect(result.current.pinned).toBe(false);
    expect(result.current.hovered).toBe(false);
    expect(result.current.open).toBe(false);
  });
});
