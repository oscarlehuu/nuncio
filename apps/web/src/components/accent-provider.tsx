import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_ACCENT,
  loadAccentPreference,
  saveAccentPreference,
  type Accent,
} from '@/lib/accent-preference';

interface AccentContextValue {
  accent: Accent;
  setAccent: (accent: Accent) => void;
}

const AccentContext = createContext<AccentContextValue | undefined>(undefined);

/**
 * Drives the `data-accent` attribute on <html>. index.css keys its per-preset
 * override blocks off this attribute (`:root[data-accent="cobalt"]` /
 * `.dark[data-accent="cobalt"]`); `mono` has no block, so it falls through to
 * the base achromatic tokens. Applied in the initial render pass — the value
 * is read from storage in useState so the attribute is set before the first
 * effect, matching the theme mechanism.
 */
function applyAccent(accent: Accent): void {
  document.documentElement.setAttribute('data-accent', accent);
}

export function AccentProvider({ children }: { children: ReactNode }) {
  const [accent, setAccentState] = useState<Accent>(() =>
    typeof window === 'undefined' ? DEFAULT_ACCENT : loadAccentPreference(),
  );

  useEffect(() => {
    applyAccent(accent);
  }, [accent]);

  const setAccent = (next: Accent) => {
    setAccentState(next);
    saveAccentPreference(next);
  };

  return (
    <AccentContext.Provider value={{ accent, setAccent }}>
      {children}
    </AccentContext.Provider>
  );
}

export function useAccent(): AccentContextValue {
  const ctx = useContext(AccentContext);
  if (!ctx) throw new Error('useAccent must be used within an AccentProvider');
  return ctx;
}
