import { DEBUG_SENTINEL } from '../sessions/domain/session-modes';
import type { ReproducePayload } from './reproduce.types';

/**
 * The steer messages that resume a paused debug run from its reproduction gate.
 * Kept pure (no I/O) so the resume text is unit-testable independent of the
 * attention queue and the steer machinery.
 */

/** The Proceed steer: hand the collected logs back so the agent can diagnose. */
export function buildProceedSteer(payload: ReproducePayload): string {
  const header =
    payload.logs.length > 0
      ? `Reproduction complete. Collected logs (${payload.logs.length} entr${payload.logs.length === 1 ? 'y' : 'ies'}):`
      : 'Reproduction complete, but no logs were captured.';
  const body = payload.logs.length > 0 ? `\n\n${payload.logs.join('\n')}` : '';
  return (
    `${header}${body}\n\n` +
    'Analyze this evidence against your hypotheses and state which single one it confirms before you make the minimal fix. ' +
    'If it is inconclusive, add more instrumentation and request reproduction again.'
  );
}

/** The Mark Fixed steer: the mechanical cleanup sweep. */
export function buildMarkFixedSteer(): string {
  return (
    'The user confirmed the fix works. Perform the mechanical cleanup now: remove EVERY line that ' +
    `contains the \`${DEBUG_SENTINEL}\` sentinel you added, so the final diff is instrumentation-free. ` +
    'Do not change any other behavior, then confirm the sweep is complete.'
  );
}
