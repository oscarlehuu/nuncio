import { describe, it, expect } from 'vitest';
import { tokenizeInlineMarkdown } from './render-inline-markdown';

describe('tokenizeInlineMarkdown', () => {
  it('returns a single text token for plain text', () => {
    expect(tokenizeInlineMarkdown('hello world')).toEqual([
      { type: 'text', value: 'hello world' },
    ]);
  });

  it('tokenizes **bold** segments', () => {
    expect(tokenizeInlineMarkdown('a **bold** b')).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'bold', value: 'bold' },
      { type: 'text', value: ' b' },
    ]);
  });

  it('tokenizes `code` segments', () => {
    expect(tokenizeInlineMarkdown('run `bun test` now')).toEqual([
      { type: 'text', value: 'run ' },
      { type: 'code', value: 'bun test' },
      { type: 'text', value: ' now' },
    ]);
  });

  it('tokenizes [label](href) links', () => {
    const tokens = tokenizeInlineMarkdown('see [#5](https://github.com/x/y/pull/5) bye');
    expect(tokens).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'link', label: '#5', href: 'https://github.com/x/y/pull/5' },
      { type: 'text', value: ' bye' },
    ]);
  });

  it('handles a real changesets entry with mixed constructs', () => {
    const entry =
      "Added an in-app **What's new** page. ([#5](https://github.com/oscarlehuu/nuncio/pull/5) by [@oscarlehuu](https://github.com/oscarlehuu))";
    const tokens = tokenizeInlineMarkdown(entry);
    expect(tokens).toEqual([
      { type: 'text', value: 'Added an in-app ' },
      { type: 'bold', value: "What's new" },
      { type: 'text', value: ' page. (' },
      { type: 'link', label: '#5', href: 'https://github.com/oscarlehuu/nuncio/pull/5' },
      { type: 'text', value: ' by ' },
      { type: 'link', label: '@oscarlehuu', href: 'https://github.com/oscarlehuu' },
      { type: 'text', value: ')' },
    ]);
  });

  it('returns empty for empty input', () => {
    expect(tokenizeInlineMarkdown('')).toEqual([]);
  });
});
