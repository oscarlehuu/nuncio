export const APPEARANCE_STORAGE_KEY = 'nuncio-appearance';

export type Density = 'compact' | 'comfortable';

export type AppearancePreference = {
  fontScale: number;
  density: Density;
};

export const DEFAULT_APPEARANCE: AppearancePreference = {
  fontScale: 1,
  density: 'comfortable',
};

const MIN_FONT_SCALE = 0.85;
const MAX_FONT_SCALE = 1.4;

export function clampFontScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_APPEARANCE.fontScale;
  return Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, value));
}

export function loadAppearancePreference(
  storage: Storage = localStorage,
): AppearancePreference {
  try {
    const raw = storage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const parsed = JSON.parse(raw) as Partial<AppearancePreference>;
    const fontScale = clampFontScale(
      typeof parsed.fontScale === 'number' ? parsed.fontScale : DEFAULT_APPEARANCE.fontScale,
    );
    const density: Density = parsed.density === 'compact' ? 'compact' : 'comfortable';
    return { fontScale, density };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function saveAppearancePreference(
  pref: AppearancePreference,
  storage: Storage = localStorage,
): void {
  storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(pref));
}
