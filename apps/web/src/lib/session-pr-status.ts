/** Normalize session forge/PR fields into sidebar badge presentation. */

type SessionPrBadgeState = 'open' | 'merged' | 'closed';

export interface SessionPrBadge {
  state: SessionPrBadgeState;
  number: number;
  label: 'PR open' | 'PR merged' | 'PR closed';
  /** Tailwind color class for the icon. */
  colorClass: string;
  url: string | null;
  ariaLabel: string;
}

export interface SessionPrFields {
  pullRequestNumber?: number | null;
  pullRequestState?: string | null;
  pullRequestUrl?: string | null;
  forgeStatus?: string | null;
}

function normalizeState(raw: string | null | undefined): SessionPrBadgeState | null {
  const value = raw?.trim().toLowerCase();
  if (value === 'open' || value === 'opened') return 'open';
  if (value === 'merged') return 'merged';
  if (value === 'closed') return 'closed';
  return null;
}

/**
 * Prefer `pullRequestState`; fall back to durable `forgeStatus` when the
 * webhook-updated state column is missing on older rows.
 */
export function resolveSessionPrBadge(session: SessionPrFields): SessionPrBadge | null {
  const number = session.pullRequestNumber;
  if (number == null || !Number.isFinite(number) || number <= 0) return null;

  const state =
    normalizeState(session.pullRequestState) ?? normalizeState(session.forgeStatus);
  if (!state) return null;

  const label =
    state === 'open' ? 'PR open' : state === 'merged' ? 'PR merged' : 'PR closed';
  const colorClass =
    state === 'open'
      ? 'text-success'
      : state === 'merged'
        ? 'text-info'
        : 'text-muted-foreground';
  const url = session.pullRequestUrl?.trim() || null;

  return {
    state,
    number,
    label,
    colorClass,
    url,
    ariaLabel: `#${number} ${label}`,
  };
}
