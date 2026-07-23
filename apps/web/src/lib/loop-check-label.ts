import type { LoopRunVerify } from './api';

const CHECK_LABELS: Record<LoopRunVerify, string> = {
  green: 'Checks passed',
  red: 'Checks failed',
  none: 'No checks',
};

/** Static presentation copy for the finite run-verification states. */
export function checkLabel(verify: LoopRunVerify): string {
  return CHECK_LABELS[verify];
}
