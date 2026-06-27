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
});
