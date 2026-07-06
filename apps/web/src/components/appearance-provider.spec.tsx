import { describe, it, expect, beforeEach } from 'vitest';
import { render, renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AppearanceProvider, useAppearance } from './appearance-provider';
import { APPEARANCE_STORAGE_KEY } from '@/lib/appearance-preference';

function wrapper({ children }: { children: ReactNode }) {
  return <AppearanceProvider>{children}</AppearanceProvider>;
}

beforeEach(() => {
  localStorage.clear();
  const root = document.documentElement;
  for (const v of ['--chat-font-scale', '--chat-gap', '--chat-msg-py', '--ui-font-size', '--code-font-size', '--font-sans', '--font-mono']) {
    root.style.removeProperty(v);
  }
  root.removeAttribute('data-motion');
  root.removeAttribute('data-pointer-cursors');
});

describe('AppearanceProvider', () => {
  it('applies default CSS vars on mount', () => {
    render(<div />, { wrapper });
    expect(document.documentElement.style.getPropertyValue('--chat-font-scale')).toBe('1');
  });

  it('setFontScale updates --chat-font-scale and persists', () => {
    const { result } = renderHook(() => useAppearance(), { wrapper });
    act(() => result.current.setFontScale(1.2));
    expect(document.documentElement.style.getPropertyValue('--chat-font-scale')).toBe('1.2');
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!).fontScale).toBe(1.2);
  });

  it('clamps out-of-range fontScale', () => {
    const { result } = renderHook(() => useAppearance(), { wrapper });
    act(() => result.current.setFontScale(10));
    expect(result.current.fontScale).toBe(1.4);
  });

  it('setDensity updates --chat-gap/--chat-msg-py and persists', () => {
    const { result } = renderHook(() => useAppearance(), { wrapper });
    const comfortableGap = document.documentElement.style.getPropertyValue('--chat-gap');
    act(() => result.current.setDensity('compact'));
    expect(document.documentElement.style.getPropertyValue('--chat-gap')).not.toBe(comfortableGap);
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!).density).toBe('compact');
  });

  it('restores persisted preference on next mount', () => {
    const { result, unmount } = renderHook(() => useAppearance(), { wrapper });
    act(() => {
      result.current.setFontScale(1.3);
      result.current.setDensity('compact');
    });
    unmount();

    const { result: result2 } = renderHook(() => useAppearance(), { wrapper });
    expect(result2.current.fontScale).toBe(1.3);
    expect(result2.current.density).toBe('compact');
  });

  it('applies UI + code font size vars and clamps them', () => {
    const { result } = renderHook(() => useAppearance(), { wrapper });
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--ui-font-size')).toBe('14px');
    expect(root.style.getPropertyValue('--code-font-size')).toBe('12px');
    act(() => {
      result.current.setUiFontSize(17);
      result.current.setCodeFontSize(40);
    });
    expect(root.style.getPropertyValue('--ui-font-size')).toBe('17px');
    expect(result.current.codeFontSize).toBe(18);
  });

  it('reflects motion and pointer-cursors as html attributes', () => {
    const { result } = renderHook(() => useAppearance(), { wrapper });
    const root = document.documentElement;
    expect(root.getAttribute('data-motion')).toBe('system');
    expect(root.hasAttribute('data-pointer-cursors')).toBe(false);
    act(() => {
      result.current.setMotion('off');
      result.current.setPointerCursors(true);
    });
    expect(root.getAttribute('data-motion')).toBe('off');
    expect(root.hasAttribute('data-pointer-cursors')).toBe(true);
  });

  it('drives --font-sans / --font-mono from the font choice', () => {
    const { result } = renderHook(() => useAppearance(), { wrapper });
    act(() => result.current.setCodeFont('jetbrains'));
    expect(document.documentElement.style.getPropertyValue('--font-mono')).toContain('JetBrains');
  });

  it('reset returns every field to its default', () => {
    const { result } = renderHook(() => useAppearance(), { wrapper });
    act(() => {
      result.current.setUiFontSize(18);
      result.current.setMotion('off');
      result.current.setPointerCursors(true);
      result.current.setDiffMarkers('symbol');
    });
    act(() => result.current.reset());
    expect(result.current.uiFontSize).toBe(14);
    expect(result.current.motion).toBe('system');
    expect(result.current.pointerCursors).toBe(false);
    expect(result.current.diffMarkers).toBe('color');
  });
});
