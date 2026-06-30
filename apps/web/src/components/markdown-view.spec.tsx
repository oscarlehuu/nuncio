import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MarkdownView } from './markdown-view';

const TABLE_MD = `| A | B |
|---|---|
| 1 | 2 |`;

const TS_CODE_MD = '```ts\nconst x = 1;\nconst y = 2;\n```';

const BASH_CODE_MD = '```bash\nls -la\n```';

const ECHO_CODE_MD = '```bash\necho hi\n```';

describe('MarkdownView', () => {
  it('renders a paragraph', () => {
    render(<MarkdownView text="Hello world" />);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('renders ## headers as heading level 2', () => {
    render(<MarkdownView text="## Section title" />);
    expect(screen.getByRole('heading', { level: 2, name: /section title/i })).toBeInTheDocument();
  });

  it('renders **bold** as strong text', () => {
    render(<MarkdownView text="This is **bold** text" />);
    const strong = screen.getByText('bold');
    expect(strong.tagName).toBe('STRONG');
  });

  it('renders `inline code` as a code pill', () => {
    render(<MarkdownView text="Use `Agent.create` to spawn" />);
    const code = screen.getByText('Agent.create');
    expect(code.tagName).toBe('CODE');
  });

  it('renders fenced code blocks with a language header', () => {
    render(<MarkdownView text={TS_CODE_MD} />);
    expect(screen.getByText('TS')).toBeInTheDocument();
    expect(screen.getByText(/const x = 1/)).toBeInTheDocument();
  });

  it('renders fenced code blocks with a copy button', () => {
    render(<MarkdownView text={BASH_CODE_MD} />);
    expect(screen.getByRole('button', { name: /copy code/i })).toBeInTheDocument();
  });

  it('renders a markdown table with header row', () => {
    render(<MarkdownView text={TABLE_MD} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders bullet lists', () => {
    render(<MarkdownView text={'- one\n- two\n- three'} />);
    expect(screen.getByText('one')).toBeInTheDocument();
    expect(screen.getByText('two')).toBeInTheDocument();
    expect(screen.getByText('three')).toBeInTheDocument();
  });

  it('renders numbered lists', () => {
    render(<MarkdownView text={'1. first\n2. second'} />);
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('renders [link](url) as an anchor with target=_blank', () => {
    render(<MarkdownView text="[docs](https://example.com)" />);
    const link = screen.getByRole('link', { name: /docs/i });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders emojis as-is', () => {
    render(<MarkdownView text="Status: ✅ done ❌ failed" />);
    expect(screen.getByText(/✅ done ❌ failed/)).toBeInTheDocument();
  });

  it('renders blockquotes', () => {
    render(<MarkdownView text="> wisdom here" />);
    expect(screen.getByText('wisdom here')).toBeInTheDocument();
  });

  it('handles empty string without crashing', () => {
    render(<MarkdownView text="" />);
    // No assertion needed — should not throw.
  });

  it('handles partial fenced code (streaming) without crashing', () => {
    render(<MarkdownView text={'```ts\nconst x = 1;'} />);
    expect(screen.getByText(/const x = 1/)).toBeInTheDocument();
  });

  it('copies code to clipboard when copy button is clicked', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<MarkdownView text={ECHO_CODE_MD} />);
    await user.click(screen.getByRole('button', { name: /copy code/i }));
    expect(writeText).toHaveBeenCalledWith('echo hi');
  });
});
