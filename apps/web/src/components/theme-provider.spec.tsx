import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ThemeProvider, useTheme } from './theme-provider';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ThemeProvider', () => {
  it('applies .dark to <html> when defaultTheme is dark', () => {
    render(
      <ThemeProvider defaultTheme="dark">
        <div />
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('applies light (no .dark) when defaultTheme is light', () => {
    render(
      <ThemeProvider defaultTheme="light">
        <div />
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('setTheme toggles .dark and persists to localStorage', () => {
    const { result } = renderHook(() => useTheme(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ThemeProvider defaultTheme="light">{children}</ThemeProvider>
      ),
    });
    act(() => result.current.setTheme('dark'));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('nuncio-theme')).toBe('dark');
    act(() => result.current.setTheme('light'));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('nuncio-theme')).toBe('light');
  });

  it('restores theme from localStorage on mount', () => {
    localStorage.setItem('nuncio-theme', 'dark');
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('resolves "system" theme to dark when matchMedia prefers dark', () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    render(
      <ThemeProvider defaultTheme="system">
        <div />
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
