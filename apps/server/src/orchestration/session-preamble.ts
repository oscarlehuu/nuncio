import { applyWrapper } from '../prompts/profile-wrapper';
import type { PromptProfile } from '../prompts/prompt-profile.types';

export interface SessionPreambleParts {
  /** Rendered handoff brief (A1), prepended first. */
  brief?: string;
  /** Rendered project facts (B2), after the brief. */
  facts?: string;
  /** Rendered workspace context (branch/HEAD/status/recent/top-level), after the facts. */
  workspace?: string;
  /** The user's original prompt — always last, always verbatim. */
  prompt: string;
  /** Engine profile (D2): its brief-wrapper/facts-wrapper shape the two blocks. */
  profile?: PromptProfile;
  /** Warning sink for a wrapper missing its slot; defaults to console.warn. */
  warn?: (message: string) => void;
}

const SEPARATOR = '\n\n---\n\n';
const DEFAULT_WARN = (m: string) => console.warn(`[session-preamble] ${m}`);

/**
 * The single choke point that composes a session's first prompt: handoff brief →
 * project facts → workspace context → original prompt, joined by a markdown rule. Empty sections are
 * omitted. When a prompt profile is supplied (D2), its `brief-wrapper` /
 * `facts-wrapper` sections wrap the respective canonical blocks — the only place
 * per-engine prompt shape exists (adapters receive the finished string). With no
 * profile (or an empty one) the output is byte-identical to the pre-D2 behavior.
 * Both TasksService.execute() and SessionsService.create() route through here.
 */
export function composeSessionPreamble(parts: SessionPreambleParts): string {
  const warn = parts.warn ?? DEFAULT_WARN;
  const sections: string[] = [];

  const brief = parts.brief?.trim();
  if (brief) sections.push(applyWrapper(parts.profile?.sections.briefWrapper, brief, warn));

  const facts = parts.facts?.trim();
  if (facts) sections.push(applyWrapper(parts.profile?.sections.factsWrapper, facts, warn));

  // The workspace block is Nuncio-owned mechanical state (branch/HEAD/status),
  // so it deliberately takes no per-engine profile wrapper.
  const workspace = parts.workspace?.trim();
  if (workspace) sections.push(workspace);

  if (sections.length === 0) return parts.prompt;
  return [...sections, parts.prompt].join(SEPARATOR);
}
