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
});
