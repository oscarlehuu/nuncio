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
