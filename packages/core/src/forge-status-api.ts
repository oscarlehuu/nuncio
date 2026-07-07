import { apiFetch } from './http';
export type ForgeAuthMethod = 'token' | 'cli';

export interface ForgeStatusDto {
  id: string;
  name: string;
  connected: boolean;
  method: ForgeAuthMethod | null;
  login: string | null;
  /** Human reason a disconnected forge shows (never an auth prompt — ADR-005). */
  reason?: string | null;
}

export async function fetchForgeStatus(): Promise<ForgeStatusDto[]> {
  const res = await apiFetch('/api/forges');
  if (!res.ok) {
    throw new Error('Failed to fetch forge status');
  }
  return res.json();
}
