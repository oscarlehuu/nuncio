import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AccentProvider, useAccent } from './accent-provider';
import { ThemeProvider } from './theme-provider';
import { ACCENT_STORAGE_KEY, CUSTOM_ACCENT_HEX_KEY } from '@/lib/accent-preference';

function wrapper({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider defaultTheme="light">
      <AccentProvider>{children}</AccentProvider>
    </ThemeProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-accent');
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
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

  it('custom accent writes derived inline vars and persists the hex', () => {
    const { result } = renderHook(() => useAccent(), { wrapper });
    act(() => result.current.setCustomHex('#22aa66'));
    act(() => result.current.setAccent('custom'));
    expect(document.documentElement.getAttribute('data-accent')).toBe('custom');
    expect(localStorage.getItem(CUSTOM_ACCENT_HEX_KEY)).toBe('#22aa66');
    expect(document.documentElement.style.getPropertyValue('--primary')).toContain('oklch');
    expect(document.documentElement.style.getPropertyValue('--ring')).toContain('oklch');
  });

  it('clears inline custom vars when switching back to a preset', () => {
    const { result } = renderHook(() => useAccent(), { wrapper });
    act(() => result.current.setAccent('custom'));
    expect(document.documentElement.style.getPropertyValue('--primary')).not.toBe('');
    act(() => result.current.setAccent('cobalt'));
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('');
  });
});
