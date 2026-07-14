import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ 'aria-label': ariaLabel }: { 'aria-label'?: string }) => (
    <svg aria-label={ariaLabel} data-testid="qr-svg" />
  ),
}));

import PairQr from './pair-qr';

describe('PairQr', () => {
  it('renders the QR tile and pairing payload text', () => {
    render(<PairQr payload="nuncio://pair/abc123" />);
    expect(screen.getByLabelText('Pairing QR code')).toBeInTheDocument();
    expect(screen.getByText('nuncio://pair/abc123')).toBeInTheDocument();
  });

  it('shows copied feedback after clicking copy', async () => {
    const user = userEvent.setup();
    render(<PairQr payload="nuncio://pair/abc123" />);

    const copyButton = screen.getByRole('button', { name: 'Copy pairing payload' });
    expect(copyButton.querySelector('.lucide-copy')).toBeTruthy();

    await user.click(copyButton);
    await waitFor(() => {
      expect(copyButton.querySelector('.lucide-check')).toBeTruthy();
    });
  });

  it('dims the QR tile and disables copy when requested', () => {
    render(<PairQr payload="stale" dimmed copyDisabled />);
    expect(screen.getByRole('button', { name: 'Copy pairing payload' })).toBeDisabled();
  });
});
