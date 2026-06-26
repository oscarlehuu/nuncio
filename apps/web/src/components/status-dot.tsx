import type { SessionStatus } from '../lib/api';
import { statusLabel } from '../lib/api';

const STATUS_CLASS: Record<SessionStatus, string> = {
  CREATED: 'bg-text-2',
  RUNNING: 'bg-accent animate-pulse',
  IDLE: 'bg-success',
  ERROR: 'bg-error',
};

export function StatusDot({ status }: { status: SessionStatus }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${STATUS_CLASS[status]}`}
      title={statusLabel(status)}
    />
  );
}
