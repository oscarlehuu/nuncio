/**
 * API client for the server-side preferences KV store — durable UI state that
 * survives app updates and origin changes, unlike localStorage (per-origin, can
 * reset). Mirrors the backend PreferencesController (`/api/preferences/:key`).
 */

export async function getPreference(key: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/preferences/${encodeURIComponent(key)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { value: string; updatedAt: number } | null;
    return body?.value ?? null;
  } catch {
    return null;
  }
}

export async function setPreference(key: string, value: string): Promise<void> {
  try {
    await fetch(`/api/preferences/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
  } catch {
    // Best-effort; a failed save must never break the UI.
  }
}
