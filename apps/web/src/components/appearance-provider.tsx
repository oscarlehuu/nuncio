import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  clampFontScale,
  DEFAULT_APPEARANCE,
  loadAppearancePreference,
  saveAppearancePreference,
  type Density,
} from '@/lib/appearance-preference';

interface AppearanceContextValue {
  fontScale: number;
  setFontScale: (scale: number) => void;
  density: Density;
  setDensity: (density: Density) => void;
}

const AppearanceContext = createContext<AppearanceContextValue | undefined>(undefined);

const DENSITY_VARS: Record<Density, { gap: string; msgPy: string }> = {
  comfortable: { gap: '0.375rem', msgPy: '0.5rem' },
  compact: { gap: '0.125rem', msgPy: '0.25rem' },
};

function applyAppearance(fontScale: number, density: Density): void {
  const root = document.documentElement;
  root.style.setProperty('--chat-font-scale', String(fontScale));
  root.style.setProperty('--chat-gap', DENSITY_VARS[density].gap);
  root.style.setProperty('--chat-msg-py', DENSITY_VARS[density].msgPy);
}

interface AppearanceProviderProps {
  children: ReactNode;
}

export function AppearanceProvider({ children }: AppearanceProviderProps) {
  const [{ fontScale, density }, setState] = useState(() =>
    typeof window === 'undefined' ? DEFAULT_APPEARANCE : loadAppearancePreference(),
  );

  useEffect(() => {
    applyAppearance(fontScale, density);
    saveAppearancePreference({ fontScale, density });
  }, [fontScale, density]);

  const setFontScale = (scale: number) => {
    setState((prev) => ({ ...prev, fontScale: clampFontScale(scale) }));
  };

  const setDensity = (next: Density) => {
    setState((prev) => ({ ...prev, density: next }));
  };

  return (
    <AppearanceContext.Provider value={{ fontScale, setFontScale, density, setDensity }}>
      {children}
    </AppearanceContext.Provider>
  );
}

export function useAppearance(): AppearanceContextValue {
  const ctx = useContext(AppearanceContext);
  if (!ctx) throw new Error('useAppearance must be used within an AppearanceProvider');
  return ctx;
}
