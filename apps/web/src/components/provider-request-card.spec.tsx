import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProviderRequestCard, type ProviderRequestView } from './provider-request-card';

function makeRequest(partial: Partial<ProviderRequestView> = {}): ProviderRequestView {
  return {
    kind: 'provider_request',
    requestId: 'req-1',
    provider: 'codex',
    method: 'shell/exec',
    params: { command: 'npm test' },
    status: 'pending',
    ...partial,
  };
}

describe('ProviderRequestCard', () => {
  it('shows pending badge and command detail for a codex request', () => {
    render(<ProviderRequestCard request={makeRequest()} />);
    expect(screen.getByText('Codex action')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('shell/exec')).toBeInTheDocument();
    expect(screen.getByText('npm test')).toBeInTheDocument();
  });

  it('shows resolved decision and hides action buttons', () => {
    render(
      <ProviderRequestCard
        request={makeRequest({ status: 'resolved', decision: 'approve' })}
      />,
    );
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve request' })).not.toBeInTheDocument();
  });

  it('calls onRespond with approve or deny', async () => {
    const onRespond = vi.fn();
    const user = userEvent.setup();
    render(<ProviderRequestCard request={makeRequest()} onRespond={onRespond} />);

    await user.click(screen.getByRole('button', { name: 'Approve request' }));
    expect(onRespond).toHaveBeenCalledWith('req-1', 'approve');

    await user.click(screen.getByRole('button', { name: 'Deny request' }));
    expect(onRespond).toHaveBeenCalledWith('req-1', 'deny');
  });
});
