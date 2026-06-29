import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ToolCallBlock } from './tool-call-block';

describe('ToolCallBlock (Cursor-style compact row)', () => {
  it('renders verb + subject pill from the summary', () => {
    render(
      <ToolCallBlock
        callId="c1"
        tool="read"
        status="done"
        summary={{ verb: 'Read', subject: 'foo.ts' }}
      />,
    );
    const row = screen.getByTestId('tool-row');
    expect(row).toHaveTextContent('Read');
    expect(row).toHaveTextContent('foo.ts');
  });

  it('renders context after the subject', () => {
    render(
      <ToolCallBlock
        callId="c1"
        tool="read"
        status="done"
        summary={{ verb: 'Read', subject: 'foo.ts', context: ' L10-20' }}
      />,
    );
    expect(screen.getByTestId('tool-row')).toHaveTextContent(/L10-20/);
  });

  it('does NOT render a "Done" status label when status is done', () => {
    render(
      <ToolCallBlock
        callId="c1"
        tool="read"
        status="done"
        summary={{ verb: 'Read', subject: 'foo.ts' }}
      />,
    );
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
  });

  it('renders "Failed" label when status is error', () => {
    render(
      <ToolCallBlock
        callId="c1"
        tool="bash"
        status="error"
        summary={{ verb: 'Ran', subject: 'ls' }}
      />,
    );
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
  });

  it('renders "Running…" with a live region when status is running', () => {
    render(
      <ToolCallBlock
        callId="c1"
        tool="bash"
        status="running"
        summary={{ verb: 'Ran', subject: 'ls' }}
      />,
    );
    expect(screen.getByText(/running/i)).toBeInTheDocument();
  });

  it('shows a chevron but no expand when there is no input/output', () => {
    render(
      <ToolCallBlock
        callId="c1"
        tool="read"
        status="done"
        summary={{ verb: 'Read', subject: 'foo.ts' }}
      />,
    );
    // Row is not a button (no expand target) when there is nothing to show.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('expands to show input and output when clicked', async () => {
    const user = userEvent.setup();
    render(
      <ToolCallBlock
        callId="c1"
        tool="read"
        status="done"
        summary={{ verb: 'Read', subject: 'foo.ts' }}
        input={{ path: '/foo.ts' }}
        output="# Nuncio"
      />,
    );
    await user.click(screen.getByRole('button'));
    expect(screen.getByText(/"path": "\/foo.ts"/)).toBeInTheDocument();
    expect(screen.getByText('# Nuncio')).toBeInTheDocument();
  });

  it('renders bash command with a $ prefix in the expanded view', async () => {
    const user = userEvent.setup();
    render(
      <ToolCallBlock
        callId="c1"
        tool="bash"
        status="done"
        summary={{ verb: 'Ran', subject: 'ls -la' }}
        input={{ cmd: 'ls -la' }}
        output="total 0"
      />,
    );
    await user.click(screen.getByRole('button'));
    const bashPres = document.querySelectorAll('pre');
    const found = Array.from(bashPres).some((p) => /\$\s*ls -la/.test(p.textContent ?? ''));
    expect(found).toBe(true);
  });

  it('truncates very long subject in the row label', () => {
    const longPath = 'x'.repeat(200);
    render(
      <ToolCallBlock
        callId="c1"
        tool="read"
        status="done"
        summary={{ verb: 'Read', subject: longPath }}
      />,
    );
    const row = screen.getByTestId('tool-row');
    expect(row.textContent?.length ?? 0).toBeLessThan(longPath.length + 20);
  });
});
