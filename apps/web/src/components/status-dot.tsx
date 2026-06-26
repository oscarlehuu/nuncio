import type { SessionStatus } from '../lib/api';
import { statusLabel } from '../lib/api';

const STATUS_CLASS: Record<SessionStatus, string> = {
  CREATED: 'bg-text-2',
  RUNNING: 'bg-success animate-pulse shadow-[0_0_6px_var(--color-success)]',
  IDLE: 'bg-info',
  PAUSED: 'bg-text-3',
  ARCHIVED: 'bg-text-3 opacity-40',
  ERROR: 'bg-error',
};

export function StatusDot({ status }: { status: SessionStatus }) {
  return (
    <span
      className={`inline-block w-[7px] h-[7px] rounded-full shrink-0 mt-1 ${STATUS_CLASS[status]}`}
      title={statusLabel(status)}
    />
  );
}
