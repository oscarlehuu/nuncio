export const INSPECTOR_PREFERENCE_STORAGE_KEY = 'nuncio-inspector-preference';

export type InspectorTool = 'scm' | 'files' | 'terminal' | 'browser';

export type InspectorPreference = {
  version: 1;
  open: boolean;
  tool: InspectorTool | null;
};

const INSPECTOR_TOOLS: readonly InspectorTool[] = ['scm', 'files', 'terminal', 'browser'];

const DEFAULT: InspectorPreference = { version: 1, open: false, tool: null };

function isInspectorTool(value: unknown): value is InspectorTool {
  return typeof value === 'string' && (INSPECTOR_TOOLS as readonly string[]).includes(value);
}

export function loadInspectorPreference(storage: Storage = localStorage): InspectorPreference {
  try {
    const raw = storage.getItem(INSPECTOR_PREFERENCE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT };
    const parsed = JSON.parse(raw) as Partial<InspectorPreference>;
    if (parsed.version !== 1 || typeof parsed.open !== 'boolean') return { ...DEFAULT };
    const tool = isInspectorTool(parsed.tool) ? parsed.tool : null;
    // An open panel with no tool renders empty chrome — restore it as closed.
    return { version: 1, open: parsed.open && tool !== null, tool };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveInspectorPreference(
  pref: InspectorPreference,
  storage: Storage = localStorage,
): void {
  try {
    storage.setItem(INSPECTOR_PREFERENCE_STORAGE_KEY, JSON.stringify(pref));
  } catch {
    // Persistence is best-effort; a full/blocked storage must not break the panel.
  }
}
