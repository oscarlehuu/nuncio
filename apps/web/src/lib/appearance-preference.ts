export const APPEARANCE_STORAGE_KEY = 'nuncio-appearance';

export type Density = 'compact' | 'comfortable';
export type MotionMode = 'system' | 'on' | 'off';
export type DiffMarkers = 'color' | 'symbol';

/** Curated font-family choices; `custom` reads the free-text value alongside. */
export const UI_FONT_OPTIONS = [
  { value: 'default', label: 'Geist (default)', stack: "'Geist Variable', sans-serif" },
  { value: 'system', label: 'System UI', stack: 'system-ui, sans-serif' },
  { value: 'inter', label: 'Inter', stack: "'Inter', system-ui, sans-serif" },
] as const;

export const CODE_FONT_OPTIONS = [
  {
    value: 'default',
    label: 'SF Mono (default)',
    stack: "'SF Mono', 'JetBrains Mono', 'Fira Code', ui-monospace, Menlo, monospace",
  },
  { value: 'jetbrains', label: 'JetBrains Mono', stack: "'JetBrains Mono', ui-monospace, monospace" },
  { value: 'fira', label: 'Fira Code', stack: "'Fira Code', ui-monospace, monospace" },
  { value: 'ui-mono', label: 'System Mono', stack: 'ui-monospace, Menlo, monospace' },
] as const;

export type UiFontValue = (typeof UI_FONT_OPTIONS)[number]['value'] | 'custom';
export type CodeFontValue = (typeof CODE_FONT_OPTIONS)[number]['value'] | 'custom';

export type AppearancePreference = {
  fontScale: number;
  density: Density;
  uiFontSize: number;
  codeFontSize: number;
  motion: MotionMode;
  pointerCursors: boolean;
  uiFont: UiFontValue;
  uiFontCustom: string;
  codeFont: CodeFontValue;
  codeFontCustom: string;
  diffMarkers: DiffMarkers;
};

export const DEFAULT_APPEARANCE: AppearancePreference = {
  fontScale: 1,
  density: 'comfortable',
  uiFontSize: 14,
  codeFontSize: 12,
  motion: 'system',
  pointerCursors: false,
  uiFont: 'default',
  uiFontCustom: '',
  codeFont: 'default',
  codeFontCustom: '',
  diffMarkers: 'color',
};

const MIN_FONT_SCALE = 0.85;
const MAX_FONT_SCALE = 1.4;
export const UI_FONT_SIZE_MIN = 12;
export const UI_FONT_SIZE_MAX = 18;
export const CODE_FONT_SIZE_MIN = 10;
export const CODE_FONT_SIZE_MAX = 18;

export function clampFontScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_APPEARANCE.fontScale;
  return Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, value));
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function clampUiFontSize(value: number): number {
  return clampInt(value, UI_FONT_SIZE_MIN, UI_FONT_SIZE_MAX, DEFAULT_APPEARANCE.uiFontSize);
}

export function clampCodeFontSize(value: number): number {
  return clampInt(value, CODE_FONT_SIZE_MIN, CODE_FONT_SIZE_MAX, DEFAULT_APPEARANCE.codeFontSize);
}

const isMotion = (v: unknown): v is MotionMode => v === 'system' || v === 'on' || v === 'off';
const isDiff = (v: unknown): v is DiffMarkers => v === 'color' || v === 'symbol';
const uiFontValues = new Set<string>([...UI_FONT_OPTIONS.map((o) => o.value), 'custom']);
const codeFontValues = new Set<string>([...CODE_FONT_OPTIONS.map((o) => o.value), 'custom']);

export function loadAppearancePreference(
  storage: Storage = localStorage,
): AppearancePreference {
  try {
    const raw = storage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const p = JSON.parse(raw) as Partial<AppearancePreference>;
    return {
      fontScale: clampFontScale(
        typeof p.fontScale === 'number' ? p.fontScale : DEFAULT_APPEARANCE.fontScale,
      ),
      density: p.density === 'compact' ? 'compact' : 'comfortable',
      uiFontSize: clampUiFontSize(p.uiFontSize ?? DEFAULT_APPEARANCE.uiFontSize),
      codeFontSize: clampCodeFontSize(p.codeFontSize ?? DEFAULT_APPEARANCE.codeFontSize),
      motion: isMotion(p.motion) ? p.motion : DEFAULT_APPEARANCE.motion,
      pointerCursors: typeof p.pointerCursors === 'boolean' ? p.pointerCursors : false,
      uiFont: (typeof p.uiFont === 'string' && uiFontValues.has(p.uiFont)
        ? p.uiFont
        : DEFAULT_APPEARANCE.uiFont) as UiFontValue,
      uiFontCustom: typeof p.uiFontCustom === 'string' ? p.uiFontCustom : '',
      codeFont: (typeof p.codeFont === 'string' && codeFontValues.has(p.codeFont)
        ? p.codeFont
        : DEFAULT_APPEARANCE.codeFont) as CodeFontValue,
      codeFontCustom: typeof p.codeFontCustom === 'string' ? p.codeFontCustom : '',
      diffMarkers: isDiff(p.diffMarkers) ? p.diffMarkers : DEFAULT_APPEARANCE.diffMarkers,
    };
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

/** Strip characters that can't legitimately appear in a font-family value, so a
 * free-text entry stays a plain family list when written to an inline CSS var. */
function sanitizeFontValue(value: string): string {
  return value.replace(/[;{}<>()\\]/g, '').trim();
}

/** Resolve the effective UI font-family stack from the preference. */
export function resolveUiFontStack(pref: AppearancePreference): string {
  if (pref.uiFont === 'custom') {
    return sanitizeFontValue(pref.uiFontCustom) || UI_FONT_OPTIONS[0].stack;
  }
  const opt = UI_FONT_OPTIONS.find((o) => o.value === pref.uiFont);
  return opt ? opt.stack : UI_FONT_OPTIONS[0].stack;
}

export function resolveCodeFontStack(pref: AppearancePreference): string {
  if (pref.codeFont === 'custom') {
    return sanitizeFontValue(pref.codeFontCustom) || CODE_FONT_OPTIONS[0].stack;
  }
  const opt = CODE_FONT_OPTIONS.find((o) => o.value === pref.codeFont);
  return opt ? opt.stack : CODE_FONT_OPTIONS[0].stack;
}
