import { describe, expect, it } from 'vitest';
import { isVideoUrl, unwrapDetailsHtml } from './markdown-media-prep';

describe('unwrapDetailsHtml', () => {
  it('keeps markdown inside details after stripping the wrapper and summary', () => {
    const input = [
      'Intro text',
      '',
      '<details><summary>Screenshots</summary>',
      '',
      '![Detail screen](https://example.com/a.png)',
      '',
      '</details>',
      '',
      'Outro',
    ].join('\n');

    expect(unwrapDetailsHtml(input)).toBe(
      [
        'Intro text',
        '',
        '![Detail screen](https://example.com/a.png)',
        '',
        'Outro',
      ].join('\n'),
    );
  });

  it('handles nested details without dropping inner markdown', () => {
    const input =
      '<details><summary>Outer</summary>\n<details><summary>Inner</summary>\n![x](https://e/x.png)\n</details>\n</details>';
    expect(unwrapDetailsHtml(input)).toContain('![x](https://e/x.png)');
    expect(unwrapDetailsHtml(input)).not.toMatch(/<\/?details/i);
    expect(unwrapDetailsHtml(input)).not.toMatch(/<\/?summary/i);
  });
});

describe('isVideoUrl', () => {
  it('detects common video extensions including query strings', () => {
    expect(isVideoUrl('https://cdn.example.com/rec.mp4')).toBe(true);
    expect(isVideoUrl('https://cdn.example.com/clip.webm?token=1')).toBe(true);
    expect(isVideoUrl('https://cdn.example.com/demo.MOV')).toBe(true);
  });

  it('rejects non-video urls', () => {
    expect(isVideoUrl('https://cdn.example.com/shot.png')).toBe(false);
    expect(isVideoUrl('https://cdn.example.com/docs')).toBe(false);
    expect(isVideoUrl('not a url')).toBe(false);
  });
});
