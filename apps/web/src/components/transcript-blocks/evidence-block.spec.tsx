import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EvidenceCapturedPayload } from '@nuncio/core/evidence.types';
import { EvidenceBlock } from './evidence-block';

const BEFORE = { id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', mimeType: 'image/png' } as const;
const AFTER = { id: 'f6e5d4c3b2a1908172635445362718f0', mimeType: 'image/png' } as const;
const HEAD_BEFORE = '9f3c1aa4b7e20d5568c1e0f2a3b4c5d6e7f80912';
const HEAD_AFTER = 'c0ffee1234567890abcdef0987654321deadbeef';
const ROUTE = '/settings/appearance';

const paired: EvidenceCapturedPayload = {
  beforeRef: BEFORE,
  afterRef: AFTER,
  route: ROUTE,
  viewport: { w: 1440, h: 900 },
  workspaceHead: HEAD_AFTER,
};

describe('EvidenceBlock', () => {
  it('renders the before and after screenshots as a pair', () => {
    render(<EvidenceBlock evidence={paired} sessionId="s1" />);
    const before = screen.getByAltText(`Before screenshot of ${ROUTE}`);
    const after = screen.getByAltText(`After screenshot of ${ROUTE}`);
    expect(before).toHaveAttribute('src', `/api/sessions/s1/media/${BEFORE.id}`);
    expect(after).toHaveAttribute('src', `/api/sessions/s1/media/${AFTER.id}`);
  });

  it('captions the route and a short workspace sha, keeping the full head on hover', () => {
    render(<EvidenceBlock evidence={paired} sessionId="s1" />);
    expect(screen.getByText(ROUTE)).toBeInTheDocument();
    const sha = screen.getByText('c0ffee1');
    expect(sha).toBeInTheDocument();
    expect(sha.closest('[title]')).toHaveAttribute('title', HEAD_AFTER);
  });

  it('shows no stale marker for a fresh pair', () => {
    render(<EvidenceBlock evidence={paired} sessionId="s1" />);
    expect(screen.queryByTestId('evidence-stale')).not.toBeInTheDocument();
  });

  it('flags a stale pair with a marker and an explanation', () => {
    render(<EvidenceBlock evidence={paired} stale sessionId="s1" />);
    expect(screen.getByTestId('evidence-stale')).toBeInTheDocument();
    expect(screen.getByText(/moved on after the before shot/i)).toBeInTheDocument();
  });

  it('opens the screenshot in a lightbox on click', async () => {
    const user = userEvent.setup();
    render(<EvidenceBlock evidence={paired} sessionId="s1" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /view before screenshot/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('holds the after slot while a before capture is still pending', () => {
    const beforeOnly: EvidenceCapturedPayload = {
      beforeRef: BEFORE,
      route: ROUTE,
      viewport: { w: 1440, h: 900 },
      workspaceHead: HEAD_BEFORE,
    };
    render(<EvidenceBlock evidence={beforeOnly} sessionId="s1" />);
    expect(screen.getByAltText(`Before screenshot of ${ROUTE}`)).toBeInTheDocument();
    expect(screen.getByTestId('evidence-pending-after')).toBeInTheDocument();
    expect(screen.queryByAltText(`After screenshot of ${ROUTE}`)).not.toBeInTheDocument();
  });

  it('renders an after-only capture with no before slot', () => {
    const afterOnly: EvidenceCapturedPayload = {
      afterRef: AFTER,
      route: ROUTE,
      viewport: { w: 1440, h: 900 },
      workspaceHead: HEAD_AFTER,
    };
    render(<EvidenceBlock evidence={afterOnly} sessionId="s1" />);
    expect(screen.getByAltText(`After screenshot of ${ROUTE}`)).toBeInTheDocument();
    expect(screen.queryByAltText(`Before screenshot of ${ROUTE}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId('evidence-pending-after')).not.toBeInTheDocument();
  });
});
