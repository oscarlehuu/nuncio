import { describe, expect, it } from 'vitest';
import { remarkCodePathLinks } from './remark-code-path-links';

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

function run(tree: MarkdownNode) {
  remarkCodePathLinks()(tree);
  return tree;
}

describe('remarkCodePathLinks', () => {
  it('linkifies source paths in text nodes', () => {
    const tree: MarkdownNode = {
      type: 'root',
      children: [{ type: 'text', value: 'See src/lib/foo.ts:12 for details' }],
    };
    run(tree);
    const kids = tree.children!;
    expect(kids.some((n) => n.type === 'link' && n.url === 'src/lib/foo.ts:12')).toBe(true);
    expect(kids.some((n) => n.type === 'text' && n.value?.includes('See'))).toBe(true);
  });

  it('does not rewrite text that is already inside a link', () => {
    const tree: MarkdownNode = {
      type: 'root',
      children: [
        {
          type: 'link',
          url: 'https://example.com',
          children: [{ type: 'text', value: 'src/lib/foo.ts' }],
        },
      ],
    };
    run(tree);
    expect(tree.children![0]!.type).toBe('link');
    expect(tree.children![0]!.children![0]).toEqual({
      type: 'text',
      value: 'src/lib/foo.ts',
    });
  });

  it('leaves non-path text unchanged', () => {
    const tree: MarkdownNode = {
      type: 'root',
      children: [{ type: 'text', value: 'hello world' }],
    };
    run(tree);
    expect(tree.children).toEqual([{ type: 'text', value: 'hello world' }]);
  });
});
