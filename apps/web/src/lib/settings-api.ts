/** API client for the settings store (DB-backed env config). Mirrors the backend SettingDto. */

export type SettingType = 'secret' | 'string' | 'path' | 'boolean';
export type SettingCategory = 'provider' | 'general';

export interface Setting {
  key: string;
  category: SettingCategory;
  providerId?: string;
  type: SettingType;
  label: string;
  description: string;
  /** True when a DB row OR env var provides a value. */
  hasValue: boolean;
  /** Source of the resolved value: 'db' | 'env' | 'default' | null. */
  source: 'db' | 'env' | 'default' | null;
  /** Masked preview for secrets (e.g. `••••12ab`); raw value for non-secrets; null when unset. */
  value: string | null;
  readOnly: boolean;
}

export async function fetchSettings(): Promise<Setting[]> {
  const res = await fetch('/api/settings');
  if (!res.ok) throw new Error('Failed to load settings');
  return res.json();
}

export async function updateSetting(key: string, value: string): Promise<Setting> {
  const res = await fetch(`/api/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) throw new Error('Failed to update setting');
  return res.json();
}

export async function clearSetting(key: string): Promise<Setting> {
  const res = await fetch(`/api/settings/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to clear setting');
  return res.json();
}
