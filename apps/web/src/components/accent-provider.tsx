import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_ACCENT,
  DEFAULT_CUSTOM_HEX,
  loadAccentPreference,
  loadCustomAccentHex,
  saveAccentPreference,
  saveCustomAccentHex,
  type Accent,
} from '@/lib/accent-preference';
import { CUSTOM_ACCENT_VARS, deriveCustomAccent } from '@/lib/custom-accent';
import { useTheme } from './theme-provider';

interface AccentContextValue {
  accent: Accent;
  setAccent: (accent: Accent) => void;
  customHex: string;
  setCustomHex: (hex: string) => void;
}

const AccentContext = createContext<AccentContextValue | undefined>(undefined);

/**
 * Drives the `data-accent` attribute on <html>. index.css keys its per-preset
 * override blocks off this attribute; `mono` has no block, so it falls through
 * to the base achromatic tokens. `custom` has no CSS block either — its token
 * set is derived from the picked hex and written as inline CSS vars on <html>,
 * selecting the light or dark set from the resolved theme.
 */
function applyAccent(accent: Accent, customHex: string, resolvedTheme: 'light' | 'dark'): void {
  const root = document.documentElement;
  root.setAttribute('data-accent', accent);

  // Always clear any prior inline custom vars so preset/mono are pristine.
  for (const name of CUSTOM_ACCENT_VARS) root.style.removeProperty(name);

  if (accent !== 'custom') return;
  const tokens = deriveCustomAccent(customHex);
  if (!tokens) return;
  const set = resolvedTheme === 'dark' ? tokens.dark : tokens.light;
  for (const [name, value] of Object.entries(set)) root.style.setProperty(name, value);
}

export function AccentProvider({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const [accent, setAccentState] = useState<Accent>(() =>
    typeof window === 'undefined' ? DEFAULT_ACCENT : loadAccentPreference(),
  );
  const [customHex, setCustomHexState] = useState<string>(() =>
    typeof window === 'undefined' ? DEFAULT_CUSTOM_HEX : loadCustomAccentHex(),
  );

  useEffect(() => {
    applyAccent(accent, customHex, resolvedTheme);
  }, [accent, customHex, resolvedTheme]);

  const setAccent = (next: Accent) => {
    setAccentState(next);
    saveAccentPreference(next);
  };

  const setCustomHex = (hex: string) => {
    setCustomHexState(hex);
    saveCustomAccentHex(hex);
  };

  return (
    <AccentContext.Provider value={{ accent, setAccent, customHex, setCustomHex }}>
      {children}
    </AccentContext.Provider>
  );
}

export function useAccent(): AccentContextValue {
  const ctx = useContext(AccentContext);
  if (!ctx) throw new Error('useAccent must be used within an AccentProvider');
  return ctx;
}
