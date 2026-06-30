import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ProviderIcon, CursorIcon, PiIcon, CodexIcon, GitHubIcon, GitLabIcon } from './provider-icon';

describe('ProviderIcon', () => {
  it('renders the Cursor SVG for providerId "cursor"', () => {
    const { container } = render(<ProviderIcon providerId="cursor" className="size-4" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 466.73 532.09');
  });

  it('renders the Pi SVG for providerId "pi"', () => {
    const { container } = render(<ProviderIcon providerId="pi" className="size-4" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 800 800');
  });

  it('renders the Codex SVG for providerId "codex" instead of the fallback character', () => {
    const { container, queryByText } = render(<ProviderIcon providerId="codex" className="size-4" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(queryByText('C')).not.toBeInTheDocument();
  });

  it('renders the GitHub SVG for providerId "github"', () => {
    const { container } = render(<ProviderIcon providerId="github" className="size-4" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
  });

  it('renders the GitLab SVG for providerId "gitlab"', () => {
    const { container } = render(<ProviderIcon providerId="gitlab" className="size-4" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
  });

  it('falls back to the char icon for an unknown provider', () => {
    const { container, getByText } = render(<ProviderIcon providerId="zebra" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(getByText('Z')).toBeInTheDocument();
  });

  it('CursorIcon, PiIcon, CodexIcon, GitHubIcon, and GitLabIcon are exported as SVG components', () => {
    const { container: cursor } = render(<CursorIcon className="size-4" />);
    const { container: pi } = render(<PiIcon className="size-4" />);
    const { container: codex } = render(<CodexIcon className="size-4" />);
    const { container: github } = render(<GitHubIcon className="size-4" />);
    const { container: gitlab } = render(<GitLabIcon className="size-4" />);
    expect(cursor.querySelector('svg')).not.toBeNull();
    expect(pi.querySelector('svg')).not.toBeNull();
    expect(codex.querySelector('svg')).not.toBeNull();
    expect(github.querySelector('svg')).not.toBeNull();
    expect(gitlab.querySelector('svg')).not.toBeNull();
  });
});
