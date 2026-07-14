import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LoopStatusChip, VerifyDot } from './loop-status-chip';

describe('LoopStatusChip', () => {
  it.each([
    ['active', 'Active'],
    ['paused', 'Paused'],
    ['broken', 'Needs you'],
    ['completed', 'Completed'],
  ] as const)('renders %s as %s', (status, label) => {
    render(<LoopStatusChip status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe('VerifyDot', () => {
  it.each([
    ['green', 'Verify passed'],
    ['red', 'Verify failed'],
    ['none', 'No verify'],
  ] as const)('exposes %s via aria-label', (verify, label) => {
    render(<VerifyDot verify={verify} />);
    expect(screen.getByLabelText(label)).toBeInTheDocument();
  });
});
