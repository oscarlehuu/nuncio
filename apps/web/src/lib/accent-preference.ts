export const ACCENT_STORAGE_KEY = 'nuncio-accent';

/**
 * Accent presets drive a single hue across primary, focus ring, active nav
 * washes and the running-tile glow, plus a subtle temperature on the neutrals.
 * `mono` is the escape hatch: no override block exists for it, so the base
 * :root / .dark tokens (achromatic, today's look) apply unchanged.
 */
export const ACCENTS = ['mono', 'iris', 'cobalt', 'ember', 'jade'] as const;

export type Accent = (typeof ACCENTS)[number];

export const DEFAULT_ACCENT: Accent = 'cobalt';

/** Swatch color + label for the Settings picker. Swatch = each accent's --brand. */
export const ACCENT_META: Record<Accent, { label: string; swatch: string }> = {
  mono: { label: 'Mono', swatch: 'oklch(0.62 0.02 260)' },
  iris: { label: 'Iris', swatch: 'oklch(0.63 0.19 285)' },
  cobalt: { label: 'Cobalt', swatch: 'oklch(0.6 0.17 255)' },
  ember: { label: 'Ember', swatch: 'oklch(0.68 0.16 45)' },
  jade: { label: 'Jade', swatch: 'oklch(0.67 0.13 165)' },
};

function isAccent(value: unknown): value is Accent {
  return typeof value === 'string' && (ACCENTS as readonly string[]).includes(value);
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
