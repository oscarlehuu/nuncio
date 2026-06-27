import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from './components/theme-provider';

vi.mock('./lib/api', () => ({
  fetchSessions: vi.fn().mockResolvedValue([]),
  createSession: vi.fn(),
  steerSession: vi.fn(),
  pauseSession: vi.fn(),
  archiveSession: vi.fn(),
  fetchModels: vi.fn().mockResolvedValue([]),
  fetchEvents: vi.fn().mockResolvedValue([]),
  statusLabel: (s: string) => s,
  relativeTime: () => 'now',
}));

import App from './App';

describe('App navigation', () => {
  it('opens the mobile sidebar drawer via the menu button', async () => {
    render(
      <ThemeProvider defaultTheme="light">
        <App />
      </ThemeProvider>,
    );
    const menu = screen.getByRole('button', { name: /open navigation/i });
    await userEvent.click(menu);
    expect(await screen.findByText('Navigation')).toBeInTheDocument();
  });
});
