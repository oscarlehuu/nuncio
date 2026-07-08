import { describe, it, expect } from 'vitest';
import { splitMarkdownSegments } from './markdown-segments';

describe('splitMarkdownSegments', () => {
  it('splits paragraphs at blank lines and reconstructs the exact input', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird.';
    const segments = splitMarkdownSegments(text);
    expect(segments.length).toBe(3);
    expect(segments.join('')).toBe(text);
  });

  it('keeps blank lines inside fenced code in one segment', () => {
    const text = 'Intro.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro.';
    const segments = splitMarkdownSegments(text);
    expect(segments.length).toBe(3);
    expect(segments[1]).toContain('const a = 1;\n\nconst b = 2;');
    expect(segments.join('')).toBe(text);
  });

  it('keeps an unclosed trailing fence as the open tail segment', () => {
    const text = 'Done part.\n\n```mermaid\ngraph TD\n\nA --> B';
    const segments = splitMarkdownSegments(text);
    expect(segments.length).toBe(2);
    expect(segments[1].startsWith('```mermaid')).toBe(true);
    expect(segments.join('')).toBe(text);
  });

  it('completed segments stay byte-identical as the text grows (memo stability)', () => {
    const before = splitMarkdownSegments('Alpha.\n\nBeta is still typ');
    const after = splitMarkdownSegments('Alpha.\n\nBeta is still typing.\n\nGamma.');
    expect(after[0]).toBe(before[0]);
  });

  it('handles empty and whitespace-only input', () => {
    expect(splitMarkdownSegments('')).toEqual([]);
    expect(splitMarkdownSegments('\n\n').join('')).toBe('\n\n');
  });

  it('keeps every completed prefix segment value-identical across many streaming splits (memo/jank guard)', () => {
    // The jank failure mode: if a completed segment's string changes when the
    // live tail grows, React.memo(MarkdownSegment) re-parses/re-renders every
    // block on every token. Segments are strings passed as props, so stable
    // value-equality of all-but-the-last element is exactly what prevents that.
    const full =
      'Para one.\n\n' +
      'Para two is longer.\n\n' +
      '```ts\nconst x = 1;\n```\n\n' +
      'Para three trailing tail';

    let prev: string[] | null = null;
    for (let len = 1; len <= full.length; len++) {
      const segs = splitMarkdownSegments(full.slice(0, len));
      if (prev) {
        // Every segment that was already "completed" (i.e. present as a
        // non-last element in the previous split) must be byte-identical now.
        const completedCount = prev.length - 1;
        for (let i = 0; i < completedCount && i < segs.length; i++) {
          expect(segs[i]).toBe(prev[i]);
        }
      }
      prev = segs;
    }
  });

  it('freezes a tail segment the moment a new fence opens below it', () => {
    // A previously-open tail becomes completed once new content (here a fence)
    // starts a fresh segment. From that point its string must never change,
    // even as the fence body streams in — otherwise the just-finished block
    // re-parses on every subsequent token.
    const beforeFence = splitMarkdownSegments('Answer text still going');
    expect(beforeFence.length).toBe(1); // one open tail

    // A blank line + fence opens a new segment; the prose above is now complete.
    const fenceOpened = splitMarkdownSegments('Answer text still going\n\n```ts\ncon');
    expect(fenceOpened.length).toBe(2);
    const completedProse = fenceOpened[0];

    // As the fenced code keeps streaming, the completed prose stays identical.
    const growing = [
      'Answer text still going\n\n```ts\nconst a',
      'Answer text still going\n\n```ts\nconst a = 1;',
      'Answer text still going\n\n```ts\nconst a = 1;\n```', // fence closes
      'Answer text still going\n\n```ts\nconst a = 1;\n```\n\nAfter.', // next para
    ];
    for (const text of growing) {
      const segs = splitMarkdownSegments(text);
      expect(segs[0]).toBe(completedProse);
      expect(segs.join('')).toBe(text); // still reconstructs exactly
    }
  });
});
