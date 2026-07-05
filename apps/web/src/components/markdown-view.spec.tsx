import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownView } from './markdown-view';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, code: string) => ({
      svg: `<svg data-mermaid-source="${code.replace(/"/g, '&quot;')}"></svg>`,
    })),
  },
}));

describe('MarkdownView', () => {
  it('renders blank-line-separated sections as distinct paragraphs', () => {
    // Codex now inserts a paragraph break between agent-message items; the shared
    // renderer must turn that into separate <p> blocks, not one run-on wall.
    const { container } = render(
      <MarkdownView text={'First section here.\n\nSecond section here.'} />,
    );
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs.length).toBe(2);
    expect(paragraphs[0].textContent).toBe('First section here.');
    expect(paragraphs[1].textContent).toBe('Second section here.');
  });

  it('keeps a run-on section without breaks as a single paragraph', () => {
    const { container } = render(
      <MarkdownView text={'Glued sentence one.Glued sentence two.'} />,
    );
    expect(container.querySelectorAll('p').length).toBe(1);
  });

  it('renders mermaid fenced blocks as diagrams instead of code headers', async () => {
    const chart = [
      'flowchart LR',
      '  A[Start] --> B[End]',
    ].join('\n');
    render(<MarkdownView text={`\`\`\`mermaid\n${chart}\n\`\`\``} />);

    await waitFor(() => {
      expect(screen.queryByText('MERMAID')).not.toBeInTheDocument();
    });
    expect(document.querySelector('svg[data-mermaid-source]')).toBeTruthy();
  });
});
