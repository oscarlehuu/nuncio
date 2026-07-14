import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VerifyChip } from './verify-chip';

describe('VerifyChip', () => {
  it('renders nothing when status is null', () => {
    const { container } = render(<VerifyChip status={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('labels running / passed / failed / timed-out states', () => {
    const { rerender } = render(
      <VerifyChip status={{ state: 'running', command: 'bun test' }} />,
    );
    expect(screen.getByLabelText('Checks running')).toBeInTheDocument();

    rerender(<VerifyChip status={{ state: 'passed', command: 'bun test' }} />);
    expect(screen.getByLabelText('Checks passed')).toBeInTheDocument();

    rerender(
      <VerifyChip status={{ state: 'failed', timedOut: false, command: 'bun test' }} />,
    );
    expect(screen.getByLabelText('Checks failed')).toBeInTheDocument();

    rerender(
      <VerifyChip status={{ state: 'failed', timedOut: true, command: 'bun test' }} />,
    );
    expect(screen.getByLabelText('Checks timed out')).toBeInTheDocument();
  });
});
