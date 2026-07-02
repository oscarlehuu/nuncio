const FENCE_RE = /^\s{0,3}(```|~~~)/;

/**
 * Splits markdown into top-level segments at blank-line runs, fence-aware.
 * Each segment keeps its trailing blank lines so `segments.join('') === text`
 * — a completed segment's string never changes as the text keeps streaming,
 * which is what lets the renderer memoize everything but the live tail.
 */
export function splitMarkdownSegments(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  const segments: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let fenceMarker = '';
  let pendingBlanks: string[] = [];

  const flush = () => {
    if (current.length === 0 && pendingBlanks.length === 0) return;
    segments.push([...current, ...pendingBlanks].join('\n'));
    current = [];
    pendingBlanks = [];
  };

  for (const line of lines) {
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1];
      } else if (fenceMatch[1] === fenceMarker) {
        inFence = false;
      }
    }

    if (!inFence && line.trim() === '') {
      pendingBlanks.push(line);
      continue;
    }

    if (pendingBlanks.length > 0 && current.length > 0) {
      // Blank run ended and new content starts → previous segment is complete.
      segments.push([...current, ...pendingBlanks].join('\n'));
      current = [];
      pendingBlanks = [];
    } else if (pendingBlanks.length > 0) {
      // Leading blanks before any content — keep them attached to this segment.
      current = pendingBlanks;
      pendingBlanks = [];
    }
    current.push(line);
  }
  flush();

  // `split('\n')` dropped the separators — rejoin segments with '\n' between
  // them so the concatenation reproduces the input exactly.
  return segments.map((segment, index) =>
    index < segments.length - 1 ? `${segment}\n` : segment,
  );
}
