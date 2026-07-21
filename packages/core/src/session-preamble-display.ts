/**
 * Separator used by server `composeSessionPreamble` (handoff / facts / workspace
 * sections joined before the user's original prompt).
 */
export const SESSION_PREAMBLE_SEPARATOR = '\n\n---\n\n';

/**
 * Display-only: keep the last section of a composed session prompt so the
 * transcript user bubble shows what the user typed, not injected Workspace /
 * brief / facts blocks. Agent-facing persistence is unchanged.
 */
export function stripSessionPreambleForDisplay(text: string): string {
  const sections = String(text ?? '').split(SESSION_PREAMBLE_SEPARATOR);
  return sections[sections.length - 1]?.trim() ?? '';
}
