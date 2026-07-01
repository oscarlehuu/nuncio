export interface HandoffSessionDayGroup<T = any> {
  dayKey: number;
  label: string;
  items: T[];
}

export function localDayKey(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function formatHandoffDayLabel(dayKey: number, nowMs = Date.now()): string {
  const todayKey = localDayKey(nowMs);
  const yesterdayKey = todayKey - 86_400_000;
  if (dayKey === todayKey) return 'Today';
  if (dayKey === yesterdayKey) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(dayKey));
}

export function formatHandoffSessionTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms));
}

export function groupHandoffSessionsByDay<T extends { updatedAt: number }>(
  sessions: T[],
  nowMs = Date.now(),
): HandoffSessionDayGroup<T>[] {
  const byDay = new Map<number, T[]>();
  for (const session of sessions) {
    const key = localDayKey(session.updatedAt);
    const bucket = byDay.get(key) ?? [];
    bucket.push(session);
    byDay.set(key, bucket);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => b - a)
    .map(([dayKey, items]) => ({
      dayKey,
      label: formatHandoffDayLabel(dayKey, nowMs),
      items,
    }));
}
