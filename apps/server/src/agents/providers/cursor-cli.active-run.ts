/** How recently a transcript/store update counts as "Cursor still running". */
export const ACTIVE_RUN_MS = 60_000;

/** True when transcript or CLI store was touched within ACTIVE_RUN_MS.
 *  If the last JSONL entry is `turn_ended`, the agent is idle — returns false. */
export function isCursorCliRecentlyActive(
  transcriptMtimeMs: number | null | undefined,
  chatStoreMtimeMs: number | null | undefined,
  turnEnded = false,
  now = Date.now(),
): boolean {
  if (turnEnded) return false;
  const candidates = [transcriptMtimeMs, chatStoreMtimeMs].filter(
    (mtime): mtime is number => mtime != null,
  );
  for (const mtime of candidates) {
    if (now - mtime < ACTIVE_RUN_MS) return true;
  }
  return false;
}
