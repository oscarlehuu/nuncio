import type { Session } from './api';

/** The Board's left list groups sessions by workflow lane, not raw status. */
export type BoardLane = 'needs-you' | 'running' | 'seen' | 'paused' | 'queued';

/** Top-to-bottom render order: your court first, then live, then parked. */
export const BOARD_LANE_ORDER: BoardLane[] = ['needs-you', 'running', 'seen', 'paused', 'queued'];

export const BOARD_LANE_LABEL: Record<BoardLane, string> = {
  'needs-you': 'Needs you',
  running: 'Running',
  seen: 'Seen',
  paused: 'Paused',
  queued: 'Queued',
};

/**
 * Map a session to exactly one lane. The "agent wants you" states — turn done
 * (IDLE), errored, or a live run blocked on your input (RUNNING + pendingInput)
 * — collapse together; the unread flag then splits them into Needs you (you
 * haven't looked since it last changed) vs Seen (you have).
 */
export function deriveBoardLane(session: Session, unread: boolean): BoardLane {
  if (session.status === 'PAUSED') return 'paused';
  if (session.status === 'CREATED') return 'queued';
  if (session.status === 'RUNNING' && !session.pendingInput) return 'running';
  return unread ? 'needs-you' : 'seen';
}

export interface BoardGroup {
  lane: BoardLane;
  label: string;
  items: Session[];
}

/** Group sessions into the ordered, non-empty lanes the list renders. */
export function groupSessionsIntoLanes(
  sessions: Session[],
  isUnread: (session: Session) => boolean,
): BoardGroup[] {
  const byLane = new Map<BoardLane, Session[]>();
  for (const session of sessions) {
    const lane = deriveBoardLane(session, isUnread(session));
    const list = byLane.get(lane) ?? [];
    list.push(session);
    byLane.set(lane, list);
  }
  return BOARD_LANE_ORDER.map((lane) => ({
    lane,
    label: BOARD_LANE_LABEL[lane],
    items: byLane.get(lane) ?? [],
  })).filter((group) => group.items.length > 0);
}
