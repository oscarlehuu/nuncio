import { View } from 'react-native';
import type { Session } from '@nuncio/core/api';
import { formatHex } from 'culori';
import { darkTokens } from '@nuncio/core/design-tokens';

/** Amber — matches web `bg-warning` / status-warning for "waiting on you". */
export const ATTENTION_COLOR = formatHex(darkTokens['status-warning']);

/* Color is a summons: amber = waiting on you, red = broken. Healthy runs are
 * calm gray; idle agents show nothing at all (mirrors web StatusDot). */
const STATUS_CLASS: Record<Session['status'], string | null> = {
  CREATED: 'bg-muted-foreground',
  RUNNING: 'bg-muted-foreground',
  IDLE: null,
  PAUSED: 'bg-muted-foreground',
  ARCHIVED: 'bg-muted-foreground opacity-40',
  ERROR: 'bg-destructive',
};

export function SessionStatusDot({
  status,
  pendingInput,
}: {
  status: Session['status'];
  pendingInput?: boolean;
}) {
  const waiting = pendingInput === true && status === 'RUNNING';
  const dotClass = waiting ? null : STATUS_CLASS[status];
  if (!waiting && !dotClass) return null;

  return (
    <View
      className={waiting ? 'size-2 rounded-full' : `size-2 rounded-full ${dotClass}`}
      style={waiting ? { backgroundColor: ATTENTION_COLOR } : undefined}
      accessibilityLabel={waiting ? 'Waiting for your input' : undefined}
    />
  );
}
