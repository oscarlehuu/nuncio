import type { Session } from '@nuncio/core/api';
import type { CrewRunRowModel } from './crew-run-list';

export type HomeItem =
  | { kind: 'session'; key: string; updatedAt: number; session: Session }
  | { kind: 'crew'; key: string; updatedAt: number; row: CrewRunRowModel };

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const separator = trimmed.lastIndexOf('/');
  return separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
}

export function projectLabelForSession(session: Session): string {
  const path = session.projectPath ?? session.workspace;
  if (!path) return 'No project';
  const label = basename(path);
  return label || 'No project';
}

export function isHomeItemRunning(item: HomeItem): boolean {
  if (item.kind === 'session') {
    return item.session.status === 'RUNNING' || item.session.pendingInput === true;
  }
  return ['RUNNING', 'QUEUED', 'RECOVERING', 'BLOCKED_USER', 'BLOCKED_PROVIDER']
    .includes(item.row.status);
}

function byUpdatedAtDescending(a: HomeItem, b: HomeItem): number {
  return b.updatedAt - a.updatedAt || a.key.localeCompare(b.key);
}

export function buildHomeSections(
  items: HomeItem[],
): Array<{ key: string; title: string; data: HomeItem[] }> {
  const running = items.filter(isHomeItemRunning).sort(byUpdatedAtDescending);
  const sections: Array<{ key: string; title: string; data: HomeItem[] }> = [];
  if (running.length > 0) {
    sections.push({ key: 'running', title: 'Running now', data: running });
  }

  const groups = new Map<string, HomeItem[]>();
  for (const item of items) {
    if (isHomeItemRunning(item)) continue;
    const title = item.kind === 'session' ? projectLabelForSession(item.session) : 'Crew runs';
    const group = groups.get(title);
    if (group) group.push(item);
    else groups.set(title, [item]);
  }

  const grouped = [...groups.entries()]
    .map(([title, data]) => ({
      key: title,
      title,
      data: data.sort(byUpdatedAtDescending),
    }))
    .sort((a, b) => (
      (b.data[0]?.updatedAt ?? 0) - (a.data[0]?.updatedAt ?? 0)
      || a.title.localeCompare(b.title)
    ));

  return [...sections, ...grouped];
}
