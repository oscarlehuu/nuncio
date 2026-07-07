import { applyWrapper } from '../prompts/profile-wrapper';
import type { TaskCompletedPayload } from '../sessions/domain/events.types';
import { byteLength, truncateTailBytes } from './byte-truncate';

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
  const wrap = (text: string) =>
    applyWrapper(options.digestWrapper, text, options.warn ?? ((m) => console.warn(`[outcome-digest] ${m}`)));
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
