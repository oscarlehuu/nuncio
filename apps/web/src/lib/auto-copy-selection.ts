/**
 * Helpers for "select → auto-copy" on chat transcript surfaces.
 * Keeps selection logic pure so hooks and click handlers can share it.
 */

/** Non-empty selected text wholly inside `root`, or null if none / outside. */
export function selectionTextInside(
  root: Node | null | undefined,
  selection: Selection | null = typeof window !== 'undefined' ? window.getSelection() : null,
): string | null {
  if (!root || !selection || selection.isCollapsed) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode) return null;
  if (!root.contains(anchorNode) || !root.contains(focusNode)) return null;
  return text;
}

/** True when a non-empty selection is currently inside `root`. */
export function hasSelectionInside(root: Node | null | undefined): boolean {
  return selectionTextInside(root) !== null;
}

/** Copy the current in-root selection to the clipboard. Returns the copied text, or null. */
export async function copySelectionInside(
  root: Node | null | undefined,
  selection: Selection | null = typeof window !== 'undefined' ? window.getSelection() : null,
): Promise<string | null> {
  const text = selectionTextInside(root, selection);
  if (!text) return null;
  await navigator.clipboard.writeText(text);
  return text;
}
