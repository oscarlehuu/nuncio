import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CursorContextBlock } from './cursor-context-block';

const PROPS = {
  summary: 'CI investigation — PR #5',
  instruction: 'Dispatch one `ci-investigator` subagent per failing check.',
  sections: [
    {
      tag: 'pr_shared_context',
      label: 'PR Context',
      content: 'headSha: a9b500\ntotalChangedFiles: 179',
    },
    {
      tag: 'untrusted_ci_metadata',
      label: 'CI Metadata',
      content: 'check: CI / ci',
    },
  ],
};

describe('CursorContextBlock', () => {
  it('renders an inline summary line', () => {
    render(<CursorContextBlock {...PROPS} />);
    expect(screen.getByTestId('cursor-context-row')).toHaveTextContent('CI investigation — PR #5');
  });

  it('does not show the sheet by default', () => {
    render(<CursorContextBlock {...PROPS} />);
    expect(screen.queryByTestId('cursor-context-sheet')).not.toBeInTheDocument();
  });

  it('opens the bottom sheet on click', async () => {
    const user = userEvent.setup();
    render(<CursorContextBlock {...PROPS} />);
    await user.click(screen.getByTestId('cursor-context-row'));
    expect(screen.getByTestId('cursor-context-sheet')).toBeInTheDocument();
  });

  it('renders instruction as markdown inside the sheet', async () => {
    const user = userEvent.setup();
    render(<CursorContextBlock {...PROPS} />);
    await user.click(screen.getByTestId('cursor-context-row'));
    expect(screen.getByText('ci-investigator')).toBeInTheDocument();
  });

  it('renders collapsible sections inside the sheet', async () => {
    const user = userEvent.setup();
    render(<CursorContextBlock {...PROPS} />);
    await user.click(screen.getByTestId('cursor-context-row'));
    expect(screen.getByText('PR Context')).toBeInTheDocument();
    expect(screen.getByText('CI Metadata')).toBeInTheDocument();
  });

  it('section content is hidden until expanded', async () => {
    const user = userEvent.setup();
    render(<CursorContextBlock {...PROPS} />);
    await user.click(screen.getByTestId('cursor-context-row'));
    expect(screen.queryByText(/headSha/)).not.toBeInTheDocument();
    await user.click(screen.getByText('PR Context'));
    expect(screen.getByText(/headSha/)).toBeInTheDocument();
  });

  it('renders without sections', () => {
    render(
      <CursorContextBlock
        summary="Test"
        instruction="Just an instruction"
        sections={[]}
      />,
    );
    expect(screen.getByTestId('cursor-context-row')).toBeInTheDocument();
  });
});
