import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusDot } from './status-dot';
import type { SessionStatus } from '../lib/api';
import { statusLabel } from '../lib/api';

const STATUSES: SessionStatus[] = [
  'CREATED',
  'RUNNING',
  'IDLE',
  'PAUSED',
  'ARCHIVED',
  'ERROR',
];

describe('StatusDot', () => {
  it.each(STATUSES)('renders a dot with the status title for %s', (status) => {
    render(<StatusDot status={status} />);
    expect(screen.getByTitle(statusLabel(status))).toBeInTheDocument();
  });

  it('does not apply a top-margin offset by default (stays centered in items-center parents)', () => {
    render(<StatusDot status="RUNNING" />);
    const dot = screen.getByTitle(statusLabel('RUNNING'));
    expect(dot.className).not.toMatch(/\bmt-1\b/);
  });

  it('applies an optional className so callers can add layout-specific offsets', () => {
    render(<StatusDot status="RUNNING" className="mt-1" />);
    const dot = screen.getByTitle(statusLabel('RUNNING'));
    expect(dot.className).toMatch(/\bmt-1\b/);
  });
});
