export const ACCENT_STORAGE_KEY = 'nuncio-accent';
export const CUSTOM_ACCENT_HEX_KEY = 'nuncio-accent-custom-hex';

/**
 * Accent presets drive a single hue across primary, focus ring, active nav
 * washes and the running-tile glow, plus a subtle temperature on the neutrals.
 * `mono` is the escape hatch: no override block exists for it, so the base
 * :root / .dark tokens (achromatic, today's look) apply unchanged. `custom`
 * derives the same token set from a user-picked hex, applied inline on <html>.
 */
export const ACCENTS = ['mono', 'iris', 'cobalt', 'ember', 'jade', 'custom'] as const;

export type Accent = (typeof ACCENTS)[number];

/** Presets shown as fixed swatches (custom is a separate control). */
export const PRESET_ACCENTS = ['mono', 'iris', 'cobalt', 'ember', 'jade'] as const;

export const DEFAULT_ACCENT: Accent = 'cobalt';
export const DEFAULT_CUSTOM_HEX = '#8b5cf6';

/** Swatch color + label for the Settings picker. Swatch = each accent's --brand. */
export const ACCENT_META: Record<Exclude<Accent, 'custom'>, { label: string; swatch: string }> = {
  mono: { label: 'Mono', swatch: 'oklch(0.62 0.02 260)' },
  iris: { label: 'Iris', swatch: 'oklch(0.63 0.19 285)' },
  cobalt: { label: 'Cobalt', swatch: 'oklch(0.6 0.17 255)' },
  ember: { label: 'Ember', swatch: 'oklch(0.68 0.16 45)' },
  jade: { label: 'Jade', swatch: 'oklch(0.67 0.13 165)' },
};

function isAccent(value: unknown): value is Accent {
  return typeof value === 'string' && (ACCENTS as readonly string[]).includes(value);
}

function isHex(value: unknown): value is string {
  return typeof value === 'string' && /^#?[0-9a-fA-F]{6}$/.test(value.trim());
}

function normalizeHex(value: string): string {
  const v = value.trim();
  return v.startsWith('#') ? v.toLowerCase() : `#${v.toLowerCase()}`;
}

export function loadAccentPreference(storage: Storage = localStorage): Accent {
  try {
    const raw = storage.getItem(ACCENT_STORAGE_KEY);
    return isAccent(raw) ? raw : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

export function saveAccentPreference(accent: Accent, storage: Storage = localStorage): void {
  storage.setItem(ACCENT_STORAGE_KEY, accent);
}

export function loadCustomAccentHex(storage: Storage = localStorage): string {
  try {
    const raw = storage.getItem(CUSTOM_ACCENT_HEX_KEY);
    return isHex(raw) ? normalizeHex(raw) : DEFAULT_CUSTOM_HEX;
  } catch {
    return DEFAULT_CUSTOM_HEX;
  }
}

export function saveCustomAccentHex(hex: string, storage: Storage = localStorage): void {
  if (!isHex(hex)) return;
  storage.setItem(CUSTOM_ACCENT_HEX_KEY, normalizeHex(hex));
}

export { isHex as isValidHex, normalizeHex };
