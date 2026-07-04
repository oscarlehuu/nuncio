import { getPreference, setPreference } from './preferences-api';

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

export type GridSlot = {
  sessionId?: string;
  /** Hub machine the session lives on; absent = the machine this page talks to. */
  machineId?: string;
};

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
    if (typeof sessionId !== 'string' || !sessionId) {
      next.push({});
      continue;
    }
    const machineId = slots[i]?.machineId;
    next.push(
      typeof machineId === 'string' && machineId ? { sessionId, machineId } : { sessionId },
    );
  }
  return next;
}

/**
 * A session lives in at most one slot. Empty any later duplicate binding so the
 * same session never renders across multiple tiles (from a stale save or a repeat
 * attach). Keeps the first occurrence of each session+machine pair.
 */
export function dedupeSlots(slots: GridSlot[]): GridSlot[] {
  const seen = new Set<string>();
  return slots.map((s) => {
    if (!s.sessionId) return s;
    const key = `${s.machineId ?? ''}:${s.sessionId}`;
    if (seen.has(key)) return {};
    seen.add(key);
    return s;
  });
}

/**
 * Parse + validate a stored preference blob (from localStorage OR the server).
 * Unknown/garbage version or shape falls back to a clean default — the grid is a
 * convenience layer, never worth surfacing a broken restore to the user.
 */
export function parseGridPreference(raw: string | null): GridPreference {
  if (!raw) return defaultGridPreference();
  try {
    const parsed = JSON.parse(raw) as Partial<GridPreference>;
    if (parsed.version !== GRID_PREFERENCE_VERSION) return defaultGridPreference();
    if (!isGridPreset(parsed.preset)) return defaultGridPreference();
    const slots = Array.isArray(parsed.slots) ? (parsed.slots as GridSlot[]) : [];
    return {
      version: GRID_PREFERENCE_VERSION,
      preset: parsed.preset,
      slots: dedupeSlots(fitSlots(slots, parsed.preset)),
    };
  } catch {
    return defaultGridPreference();
  }
}

/** Synchronous localStorage load — retained for tests and as an offline fallback. */
export function loadGridPreference(storage: Storage = localStorage): GridPreference {
  try {
    return parseGridPreference(storage.getItem(GRID_PREFERENCE_STORAGE_KEY));
  } catch {
    return defaultGridPreference();
  }
}

/** Whether this device already has a saved layout — when true the local cache is
 *  authoritative and we skip the server restore, avoiding a re-layout "jump". */
export function hasLocalGridPreference(storage: Storage = localStorage): boolean {
  try {
    return storage.getItem(GRID_PREFERENCE_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function saveGridPreference(pref: GridPreference, storage: Storage = localStorage): void {
  try {
    storage.setItem(GRID_PREFERENCE_STORAGE_KEY, JSON.stringify(pref));
  } catch {
    // Best-effort persistence; a full/blocked quota must not break the grid.
  }
}

/**
 * Durable, server-backed grid layout — the source of truth the Workbench loads.
 * Persisted in the backend preferences store (SQLite under NUNCIO_DATA_DIR) so it
 * survives app updates and origin changes, unlike localStorage (per-origin, resettable).
 */
export async function loadGridPreferenceRemote(): Promise<GridPreference | null> {
  const raw = await getPreference(GRID_PREFERENCE_STORAGE_KEY);
  return raw === null ? null : parseGridPreference(raw);
}

export async function saveGridPreferenceRemote(pref: GridPreference): Promise<void> {
  await setPreference(GRID_PREFERENCE_STORAGE_KEY, JSON.stringify(pref));
}
