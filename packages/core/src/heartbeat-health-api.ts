import { apiFetch } from './http';

export type HeartbeatHealthOutcome = 'ok' | 'error' | 'timeout';

/** Last-run status of one heartbeat system job (read-only observability). */
export interface HeartbeatHealthDto {
  job: 'infra' | 'reconcile' | 'digest-morning' | 'digest-evening';
  lastRunAt: number;
  outcome: HeartbeatHealthOutcome;
  detail: string | null;
}

export async function fetchHeartbeatHealth(): Promise<HeartbeatHealthDto[]> {
  const res = await apiFetch('/api/heartbeat/health');
  if (!res.ok) {
    throw new Error('Failed to fetch heartbeat health');
  }
  const body = (await res.json()) as { items?: HeartbeatHealthDto[] };
  return body.items ?? [];
}
