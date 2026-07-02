export const GRID_PREFERENCE_STORAGE_KEY = 'nuncio-grid-preference';
export const GRID_PREFERENCE_VERSION = 1;

/** Layout presets. The number encodes the slot count each preset holds. */
export type GridPreset = '1x1' | '2x1' | '2x2' | '3x2';

export const GRID_PRESETS: readonly GridPreset[] = ['1x1', '2x1', '2x2', '3x2'];

export const PRESET_SLOT_COUNT: Record<GridPreset, number> = {
  '1x1': 1,
  '2x1': 2,
  '2x2': 4,
  '3x2': 6,
};

/** Column count per preset, used for the CSS grid template. */
export const PRESET_COLUMNS: Record<GridPreset, number> = {
  '1x1': 1,
  '2x1': 2,
  '2x2': 2,
  '3x2': 3,
};

export type GridSlot = { sessionId?: string };

export interface GridPreference {
  version: number;
  preset: GridPreset;
  slots: GridSlot[];
}

const DEFAULT_PRESET: GridPreset = '2x2';

/** Fresh, empty grid used whenever storage is missing, corrupt, or unknown. */
export function defaultGridPreference(): GridPreference {
  return {
    version: GRID_PREFERENCE_VERSION,
    preset: DEFAULT_PRESET,
    slots: emptySlots(PRESET_SLOT_COUNT[DEFAULT_PRESET]),
  };
}

export function emptySlots(count: number): GridSlot[] {
  return Array.from({ length: count }, () => ({}));
}

function isGridPreset(value: unknown): value is GridPreset {
  return typeof value === 'string' && (GRID_PRESETS as readonly string[]).includes(value);
}

/**
 * Normalize an arbitrary slot array to the preset's exact slot count:
 * truncate when the preset shrinks, extend with empty slots when it grows.
 * Bindings that survive keep their session id.
 */
export function fitSlots(slots: GridSlot[], preset: GridPreset): GridSlot[] {
  const count = PRESET_SLOT_COUNT[preset];
  const next: GridSlot[] = [];
  for (let i = 0; i < count; i += 1) {
    const sessionId = slots[i]?.sessionId;
    next.push(typeof sessionId === 'string' && sessionId ? { sessionId } : {});
  }
  return next;
}

export function loadGridPreference(storage: Storage = localStorage): GridPreference {
  try {
    const raw = storage.getItem(GRID_PREFERENCE_STORAGE_KEY);
    if (!raw) return defaultGridPreference();
    const parsed = JSON.parse(raw) as Partial<GridPreference>;
    // Unknown/garbage version or shape falls back to a clean default — the grid
    // is a convenience layer, never worth surfacing a broken restore to the user.
    if (parsed.version !== GRID_PREFERENCE_VERSION) return defaultGridPreference();
    if (!isGridPreset(parsed.preset)) return defaultGridPreference();
    const slots = Array.isArray(parsed.slots) ? (parsed.slots as GridSlot[]) : [];
    return {
      version: GRID_PREFERENCE_VERSION,
      preset: parsed.preset,
      slots: fitSlots(slots, parsed.preset),
    };
  } catch {
    return defaultGridPreference();
  }
}

export function saveGridPreference(pref: GridPreference, storage: Storage = localStorage): void {
  try {
    storage.setItem(GRID_PREFERENCE_STORAGE_KEY, JSON.stringify(pref));
  } catch {
    // Best-effort persistence; a full/blocked quota must not break the grid.
  }
}
