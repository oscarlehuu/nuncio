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

  it('renders ACP permission requests with a readable title instead of raw JSON', () => {
    render(
      <ProviderRequestCard
        request={makeRequest({
          provider: 'devin',
          method: 'session/request_permission',
          params: {
            sessionId: 'spiced-emmental',
            toolCall: {
              toolCallId: 'functions.exec:0',
              title: 'git branch',
              kind: 'execute',
            },
            options: [
              { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
            ],
          },
        })}
      />,
    );
    expect(screen.getByText('Devin action')).toBeInTheDocument();
    expect(screen.getByText('Permission request')).toBeInTheDocument();
    expect(screen.getByText('git branch')).toBeInTheDocument();
    expect(screen.queryByText(/"sessionId"/)).not.toBeInTheDocument();
    expect(screen.queryByText(/"optionId"/)).not.toBeInTheDocument();
  });

  it('falls back to a descriptive ACP option label when toolCall has no title', () => {
    render(
      <ProviderRequestCard
        request={makeRequest({
          provider: 'devin',
          method: 'session/request_permission',
          params: {
            sessionId: 'spiced-emmental',
            toolCall: { toolCallId: 'functions.exec:0' },
            options: [
              { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
              {
                optionId: 'allow_session',
                name: 'Yes, allow `git branch` commands (this session)',
                kind: 'allow_always',
              },
              { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
            ],
          },
        })}
      />,
    );
    expect(
      screen.getByText('Yes, allow `git branch` commands (this session)'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/"options"/)).not.toBeInTheDocument();
  });
});
