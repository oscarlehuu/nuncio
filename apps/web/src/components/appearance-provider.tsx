import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  clampCodeFontSize,
  clampFontScale,
  clampUiFontSize,
  DEFAULT_APPEARANCE,
  loadAppearancePreference,
  resolveCodeFontStack,
  resolveUiFontStack,
  saveAppearancePreference,
  type AppearancePreference,
  type CodeFontValue,
  type Density,
  type DiffMarkers,
  type MotionMode,
  type UiFontValue,
} from '@/lib/appearance-preference';

interface AppearanceContextValue extends AppearancePreference {
  setFontScale: (scale: number) => void;
  setDensity: (density: Density) => void;
  setUiFontSize: (px: number) => void;
  setCodeFontSize: (px: number) => void;
  setMotion: (mode: MotionMode) => void;
  setPointerCursors: (on: boolean) => void;
  setUiFont: (value: UiFontValue) => void;
  setUiFontCustom: (value: string) => void;
  setCodeFont: (value: CodeFontValue) => void;
  setCodeFontCustom: (value: string) => void;
  setDiffMarkers: (value: DiffMarkers) => void;
  reset: () => void;
}

const AppearanceContext = createContext<AppearanceContextValue | undefined>(undefined);

const DENSITY_VARS: Record<Density, { gap: string; msgPy: string }> = {
  comfortable: { gap: '0.375rem', msgPy: '0.5rem' },
  compact: { gap: '0.125rem', msgPy: '0.25rem' },
};

function applyAppearance(pref: AppearancePreference): void {
  const root = document.documentElement;
  root.style.setProperty('--chat-font-scale', String(pref.fontScale));
  root.style.setProperty('--chat-gap', DENSITY_VARS[pref.density].gap);
  root.style.setProperty('--chat-msg-py', DENSITY_VARS[pref.density].msgPy);
  root.style.setProperty('--ui-font-size', `${pref.uiFontSize}px`);
  root.style.setProperty('--code-font-size', `${pref.codeFontSize}px`);
  root.style.setProperty('--font-sans', resolveUiFontStack(pref));
  root.style.setProperty('--font-mono', resolveCodeFontStack(pref));
  root.setAttribute('data-motion', pref.motion);
  root.toggleAttribute('data-pointer-cursors', pref.pointerCursors);
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [pref, setPref] = useState<AppearancePreference>(() =>
    typeof window === 'undefined' ? DEFAULT_APPEARANCE : loadAppearancePreference(),
  );

  useEffect(() => {
    applyAppearance(pref);
    saveAppearancePreference(pref);
  }, [pref]);

  const patch = (next: Partial<AppearancePreference>) => setPref((prev) => ({ ...prev, ...next }));

  const value: AppearanceContextValue = {
    ...pref,
    setFontScale: (scale) => patch({ fontScale: clampFontScale(scale) }),
    setDensity: (density) => patch({ density }),
    setUiFontSize: (px) => patch({ uiFontSize: clampUiFontSize(px) }),
    setCodeFontSize: (px) => patch({ codeFontSize: clampCodeFontSize(px) }),
    setMotion: (motion) => patch({ motion }),
    setPointerCursors: (pointerCursors) => patch({ pointerCursors }),
    setUiFont: (uiFont) => patch({ uiFont }),
    setUiFontCustom: (uiFontCustom) => patch({ uiFontCustom }),
    setCodeFont: (codeFont) => patch({ codeFont }),
    setCodeFontCustom: (codeFontCustom) => patch({ codeFontCustom }),
    setDiffMarkers: (diffMarkers) => patch({ diffMarkers }),
    reset: () => setPref(DEFAULT_APPEARANCE),
  };

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext);
  if (!ctx) throw new Error('useAppearance must be used within an AppearanceProvider');
  return ctx;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function systemPrefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(REDUCED_MOTION_QUERY).matches;
}

/**
 * The effective "reduce motion" flag, resolving the appearance setting against
 * the OS query: `off` force-reduces, `on` force-keeps motion, `system` honors
 * `prefers-reduced-motion`. Tolerates a missing provider (defaults to `system`).
 */
export function useReducedMotion(): boolean {
  const { motion } = useAppearancePreference();
  const [systemReduced, setSystemReduced] = useState(systemPrefersReducedMotion);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => setSystemReduced(mql.matches);
    onChange();
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, []);

  if (motion === 'on') return false;
  if (motion === 'off') return true;
  return systemReduced;
}

/**
 * Read-only appearance access that tolerates a missing provider by returning
 * the defaults. For leaf render components (e.g. DiffView) that only consume a
 * flag and may be mounted in isolation (tests, storybook-style previews).
 */
export function useAppearancePreference(): AppearancePreference {
  const ctx = useContext(AppearanceContext);
  return ctx ?? DEFAULT_APPEARANCE;
}
