import { applyWrapper } from '../prompts/profile-wrapper';
import type { TaskCompletedPayload } from '../sessions/domain/events.types';
import { byteLength, truncateHeadBytes, truncateTailBytes } from './byte-truncate';

/** The exact call-to-action a steered parent sees at the end of every digest. */
export const DIGEST_ACTION_SENTENCE =
  'Reply with next action, or reply DONE if the objective is met.';

const DIGEST_MAX_BYTES = 1536;

export interface RenderDigestOptions {
  /** Profile `digest-wrapper` section, wrapping the canonical digest (D2). */
  digestWrapper?: string;
  warn?: (message: string) => void;
}

function verifyLine(verify: TaskCompletedPayload['verify']): string | null {
  if (!verify) return null;
  const result = verify.passed ? 'passed' : 'failed';
  const output = verify.output ? ` — ${verify.output}` : '';
  return `Verify: ${result}${output}`;
}

/**
 * Render a compact markdown message a steered parent receives when a subagent
 * task finishes: status, verify line, child branch, and a summary excerpt,
 * always ending with {@link DIGEST_ACTION_SENTENCE}. Bounded to 1.5 KB on
 * serialized bytes — the summary is trimmed (never the action sentence) to fit.
 */
export function renderOutcomeDigest(
  payload: TaskCompletedPayload,
  options: RenderDigestOptions = {},
): string {
  const warn = options.warn ?? ((m: string) => console.warn(`[outcome-digest] ${m}`));
  const wrap = (text: string): string => {
    const wrapped = applyWrapper(options.digestWrapper, text, warn);
    if (byteLength(wrapped) <= DIGEST_MAX_BYTES) return wrapped;
    // Backstop: a hostile/stale cached profile wrapper must never blow the
    // steer budget — the parse-time section cap makes this unreachable under
    // valid data.
    warn('digest wrapper pushed the message over budget; clamping');
    const clamped = truncateHeadBytes(wrapped, DIGEST_MAX_BYTES);
    if (clamped.endsWith(DIGEST_ACTION_SENTENCE)) return clamped;
    // The clamp cut off the action sentence — restore the invariant: trim the
    // body to leave room for a newline + the full sentence, on a clean UTF-8
    // boundary, so the digest always ends with the exact call-to-action.
    const body = truncateHeadBytes(
      clamped,
      DIGEST_MAX_BYTES - byteLength(DIGEST_ACTION_SENTENCE) - 1,
    );
    return `${body}\n${DIGEST_ACTION_SENTENCE}`;
  };
  const build = (summary: string | null): string => {
    const lines: string[] = [`### Subagent task ${payload.status}`];
    const verify = verifyLine(payload.verify);
    if (verify) lines.push(verify);
    if (payload.childBranch) lines.push(`Branch: \`${payload.childBranch}\``);
    if (summary) lines.push('', summary);
    lines.push('', DIGEST_ACTION_SENTENCE);
    return lines.join('\n');
  };

  // The 1.5KB budget bounds the CANONICAL digest; the profile wrapper (small
  // engine framing) is applied afterward.
  let rendered = build(payload.outcomeSummary);
  if (byteLength(rendered) <= DIGEST_MAX_BYTES) return wrap(rendered);

  // Over budget: shrink the summary toward empty (the action sentence, status,
  // verify, and branch are all bounded and must survive).
  if (payload.outcomeSummary) {
    let budget = byteLength(payload.outcomeSummary);
    while (budget > 0 && byteLength(rendered) > DIGEST_MAX_BYTES) {
      budget = Math.floor(budget / 2);
      rendered = build(budget <= 0 ? null : truncateTailBytes(payload.outcomeSummary, budget));
    }
    if (byteLength(rendered) <= DIGEST_MAX_BYTES) return wrap(rendered);
  }

  // Summary gone and still over budget (a pathological childBranch/verify.output
  // — both already byte-capped upstream, so this is a hard backstop): keep only
  // the status header and the action sentence.
  return wrap([`### Subagent task ${payload.status}`, '', DIGEST_ACTION_SENTENCE].join('\n'));
}
