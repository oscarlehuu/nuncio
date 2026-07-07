export interface SessionPreambleParts {
  /** Rendered handoff brief (A1), prepended first. */
  brief?: string;
  /** Rendered project facts (B2), after the brief. */
  facts?: string;
  /** The user's original prompt — always last, always verbatim. */
  prompt: string;
}

const SEPARATOR = '\n\n---\n\n';

/**
 * The single choke point that composes a session's first prompt: handoff brief →
 * project facts → original prompt, joined by a markdown rule. Empty sections are
 * omitted. Both TasksService.execute() (subagent spawn) and SessionsService
 * .create() (direct session) route through here; D2 later threads prompt
 * profiles through this same function.
 */
export function composeSessionPreamble(parts: SessionPreambleParts): string {
  const sections = [parts.brief, parts.facts]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s));
  if (sections.length === 0) return parts.prompt;
  return [...sections, parts.prompt].join(SEPARATOR);
}
