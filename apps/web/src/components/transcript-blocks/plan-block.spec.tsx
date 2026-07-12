import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanBlock } from './plan-block';

const items = [
  { id: 'a', text: 'Read the code', status: 'done' as const },
  { id: 'b', text: 'Write the fix', status: 'in_progress' as const },
  { id: 'c', text: 'Run the tests', status: 'pending' as const },
];

describe('PlanBlock', () => {
  it('shows collapsed progress with the active step', () => {
    render(<PlanBlock items={items} />);
    expect(screen.getByTestId('plan-summary')).toHaveTextContent('Plan · 1/3 done');
    expect(screen.getByTestId('plan-summary')).toHaveTextContent('Write the fix');
    expect(screen.queryByText('Run the tests')).not.toBeInTheDocument();
  });

  it('expands to the full checklist with statuses', async () => {
    const user = userEvent.setup();
    render(<PlanBlock items={items} />);
    await user.click(screen.getByTestId('plan-summary'));

    expect(screen.getByText('Read the code').closest('li')).toHaveAttribute(
      'data-status',
      'done',
    );
    expect(screen.getByText('Write the fix').closest('li')).toHaveAttribute(
      'data-status',
      'in_progress',
    );
    expect(screen.getByText('Run the tests').closest('li')).toHaveAttribute(
      'data-status',
      'pending',
    );
  });
});
