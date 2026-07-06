import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AccentProvider, useAccent } from './accent-provider';
import { ACCENT_STORAGE_KEY } from '@/lib/accent-preference';

function wrapper({ children }: { children: ReactNode }) {
  return <AccentProvider>{children}</AccentProvider>;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-accent');
});

describe('AccentProvider', () => {
  it('applies the default accent to <html> on mount', () => {
    renderHook(() => useAccent(), { wrapper });
    expect(document.documentElement.getAttribute('data-accent')).toBe('cobalt');
  });

  it('setAccent updates data-accent and persists', () => {
    const { result } = renderHook(() => useAccent(), { wrapper });
    act(() => result.current.setAccent('jade'));
    expect(document.documentElement.getAttribute('data-accent')).toBe('jade');
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe('jade');
  });

  it('restores a persisted accent on next mount', () => {
    const { result, unmount } = renderHook(() => useAccent(), { wrapper });
    act(() => result.current.setAccent('mono'));
    unmount();

    const { result: result2 } = renderHook(() => useAccent(), { wrapper });
    expect(result2.current.accent).toBe('mono');
    expect(document.documentElement.getAttribute('data-accent')).toBe('mono');
  });
});
