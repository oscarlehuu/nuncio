import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionScmConflicts } from './session-scm-conflicts';

describe('SessionScmConflicts', () => {
  it('renders nothing when there are no conflicts', () => {
    const { container } = render(<SessionScmConflicts conflicts={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows conflict count and file paths', () => {
    render(
      <SessionScmConflicts conflicts={['src/a.ts', 'src/b.ts']} />,
    );
    expect(screen.getByText('2 merge conflicts')).toBeInTheDocument();
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('src/b.ts')).toBeInTheDocument();
  });

  it('uses singular copy for a single conflict', () => {
    render(<SessionScmConflicts conflicts={['README.md']} />);
    expect(screen.getByText('1 merge conflict')).toBeInTheDocument();
  });
});
