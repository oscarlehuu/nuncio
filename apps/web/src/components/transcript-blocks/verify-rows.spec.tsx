import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VerifyRetryRow, VerifyNeedsAttentionRow } from './verify-rows';

describe('VerifyRetryRow', () => {
  it('announces the auto-retry round', () => {
    render(<VerifyRetryRow round={2} command="bun test" />);
    expect(screen.getByTestId('verify-retry-row')).toHaveTextContent(/auto-retry/i);
    expect(screen.getByTestId('verify-retry-row')).toHaveTextContent(/round 2/i);
  });

  it('shows the verify command when present', () => {
    render(<VerifyRetryRow round={1} command="bun run gate" />);
    expect(screen.getByText('bun run gate')).toBeInTheDocument();
  });

  it('reads as an informational (not error) row', () => {
    const { container } = render(<VerifyRetryRow round={1} />);
    // Muted/informational, never the destructive red used for real failures.
    expect(container.querySelector('.text-destructive')).toBeNull();
  });
});

describe('VerifyNeedsAttentionRow', () => {
  it('states the loop exhausted and needs the user', () => {
    render(<VerifyNeedsAttentionRow rounds={3} reason="max_rounds" />);
    const row = screen.getByTestId('verify-needs-attention-row');
    expect(row).toHaveTextContent(/needs your attention/i);
    expect(row).toHaveTextContent(/3 auto-retries/i);
  });

  it('explains a max-rounds stop distinctly from a no-progress stop', () => {
    render(<VerifyNeedsAttentionRow rounds={2} reason="repeated_failure" />);
    expect(screen.getByTestId('verify-needs-attention-row')).toHaveTextContent(
      /no progress|same failure|stopped repeating/i,
    );
  });

  it('is visually prominent — carries the warning idiom, not the muted one', () => {
    const { container } = render(
      <VerifyNeedsAttentionRow rounds={3} reason="max_rounds" />,
    );
    // Distinct from ordinary failure (destructive/red) and from muted info rows:
    // it rides the amber attention idiom used elsewhere for "needs you".
    expect(container.querySelector('[class*="border-warning"]')).toBeTruthy();
    expect(container.querySelector('.text-destructive')).toBeNull();
  });

  it('renders the last failing output tail when provided', () => {
    render(
      <VerifyNeedsAttentionRow
        rounds={3}
        reason="max_rounds"
        lastOutputTail="AssertionError: expected 2 to equal 3"
      />,
    );
    expect(
      screen.getByText(/AssertionError: expected 2 to equal 3/),
    ).toBeInTheDocument();
  });
});
