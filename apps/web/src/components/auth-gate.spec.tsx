import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthGate } from './auth-gate';

vi.mock('../lib/auth-api', () => ({
  fetchAuthStatus: vi.fn(),
  login: vi.fn(),
}));

import { fetchAuthStatus, login } from '../lib/auth-api';

const mockStatus = vi.mocked(fetchAuthStatus);
const mockLogin = vi.mocked(login);

describe('AuthGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders children immediately when already authenticated', async () => {
    mockStatus.mockResolvedValue({ authenticated: true });
    render(
      <AuthGate>
        <div>app-content</div>
      </AuthGate>,
    );
    expect(await screen.findByText('app-content')).toBeInTheDocument();
    expect(screen.queryByLabelText('Access token')).not.toBeInTheDocument();
  });

  it('shows the token form when unauthenticated and unlocks after login', async () => {
    mockStatus.mockResolvedValue({ authenticated: false });
    mockLogin.mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <AuthGate>
        <div>app-content</div>
      </AuthGate>,
    );

    const input = await screen.findByLabelText('Access token');
    expect(screen.queryByText('app-content')).not.toBeInTheDocument();

    await user.type(input, 'my-token');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(mockLogin).toHaveBeenCalledWith('my-token'));
    expect(await screen.findByText('app-content')).toBeInTheDocument();
  });

  it('shows the error and stays locked on a wrong token', async () => {
    mockStatus.mockResolvedValue({ authenticated: false });
    mockLogin.mockRejectedValue(new Error('Invalid access token'));
    const user = userEvent.setup();

    render(
      <AuthGate>
        <div>app-content</div>
      </AuthGate>,
    );

    await user.type(await screen.findByLabelText('Access token'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid access token');
    expect(screen.queryByText('app-content')).not.toBeInTheDocument();
  });

  it('fails open when the status check itself fails', async () => {
    mockStatus.mockRejectedValue(new Error('network down'));
    render(
      <AuthGate>
        <div>app-content</div>
      </AuthGate>,
    );
    expect(await screen.findByText('app-content')).toBeInTheDocument();
  });
});
