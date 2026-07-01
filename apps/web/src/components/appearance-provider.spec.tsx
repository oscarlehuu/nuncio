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
  document.documentElement.style.removeProperty('--chat-font-scale');
  document.documentElement.style.removeProperty('--chat-gap');
  document.documentElement.style.removeProperty('--chat-msg-py');
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
});
