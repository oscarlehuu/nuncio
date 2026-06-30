export type ForgeAuthMethod = 'token' | 'cli';

export interface ForgeStatusDto {
  id: string;
  name: string;
  connected: boolean;
  method: ForgeAuthMethod | null;
  login: string | null;
}

export async function fetchForgeStatus(): Promise<ForgeStatusDto[]> {
  const res = await fetch('/api/forges');
  if (!res.ok) {
    throw new Error('Failed to fetch forge status');
  }
  return res.json();
}
