import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ToolGroup } from './tool-group';
import type { ToolSummary } from '@/lib/tool-summary';

function makeTool(
  overrides: Partial<{
    callId: string;
    tool: string;
    status: 'running' | 'done' | 'error';
    input?: unknown;
    output?: unknown;
    summary: ToolSummary;
  }>,
) {
  return {
    callId: 'c1',
    tool: 'read',
    status: 'done' as const,
    summary: { verb: 'Read', subject: 'foo.ts' } as ToolSummary,
    ...overrides,
  };
}

describe('ToolGroup', () => {
  it('renders a group summary header from the tool list', () => {
    render(
      <ToolGroup
        tools={[
          makeTool({ callId: 'c1', tool: 'read', input: { path: 'a.ts' }, summary: { verb: 'Read', subject: 'a.ts' } }),
          makeTool({ callId: 'c2', tool: 'read', input: { path: 'b.ts' }, summary: { verb: 'Read', subject: 'b.ts' } }),
        ]}
      />,
    );
    expect(screen.getByTestId('tool-group-summary')).toHaveTextContent(/Read 2 files/);
  });

  it('renders a mixed-category summary with first verb capitalized', () => {
    render(
      <ToolGroup
        tools={[
          makeTool({ callId: 'c1', tool: 'read', summary: { verb: 'Read', subject: 'a.ts' } }),
          makeTool({ callId: 'c2', tool: 'bash', summary: { verb: 'Ran', subject: 'ls' } }),
          makeTool({ callId: 'c3', tool: 'Glob', summary: { verb: 'Searched files', subject: '*' } }),
        ]}
      />,
    );
    expect(screen.getByTestId('tool-group-summary')).toHaveTextContent(/Read 1 file.*ran 1 command.*searched 1 time/);
  });

  it('is collapsed by default (no tool rows visible)', () => {
    render(
      <ToolGroup
        tools={[
          makeTool({ callId: 'c1', summary: { verb: 'Read', subject: 'a.ts' } }),
          makeTool({ callId: 'c2', summary: { verb: 'Read', subject: 'b.ts' } }),
        ]}
      />,
    );
    expect(screen.queryAllByTestId('tool-row')).toHaveLength(0);
  });

  it('expands to reveal individual tool rows on click', async () => {
    const user = userEvent.setup();
    render(
      <ToolGroup
        tools={[
          makeTool({ callId: 'c1', summary: { verb: 'Read', subject: 'a.ts' } }),
          makeTool({ callId: 'c2', summary: { verb: 'Read', subject: 'b.ts' } }),
        ]}
      />,
    );
    await user.click(screen.getByRole('button'));
    expect(screen.getAllByTestId('tool-row')).toHaveLength(2);
  });

  it('auto-expands when a tool is running', () => {
    render(
      <ToolGroup
        tools={[
          makeTool({ callId: 'c1', status: 'done', summary: { verb: 'Read', subject: 'a.ts' } }),
          makeTool({ callId: 'c2', status: 'running', summary: { verb: 'Ran', subject: 'ls' } }),
        ]}
      />,
    );
    expect(screen.getAllByTestId('tool-row').length).toBeGreaterThan(0);
  });

  it('renders only one tool row without a group wrapper when tools length is 1', () => {
    render(
      <ToolGroup
        tools={[makeTool({ callId: 'c1', summary: { verb: 'Read', subject: 'a.ts' } })]}
      />,
    );
    // Single tool — no group summary header; render the row directly.
    expect(screen.queryByTestId('tool-group-summary')).toBeNull();
    expect(screen.getByTestId('tool-row')).toBeInTheDocument();
  });
});
