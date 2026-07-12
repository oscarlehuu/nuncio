export type RelayPathStatus = 'up' | 'down' | 'unknown';

export interface RelayPathHealth {
  status: RelayPathStatus;
  latencyMs: number | null;
  probedAt: number | null;
  reason?: string;
}

export interface RelayHealthDto {
  lan: RelayPathHealth;
  tailnet: RelayPathHealth;
  funnel: RelayPathHealth;
}

export type RelayProbeResult = Pick<RelayPathHealth, 'status' | 'reason'>;
