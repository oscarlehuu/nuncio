import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from './theme-provider';
import { ChangelogView } from './changelog-view';

vi.mock('virtual:changelog', () => ({
  default: `# Changelog

## 0.2.0

### Minor Changes

- Added an in-app **What's new** page. ([#5](https://github.com/oscarlehuu/nuncio/pull/5) by [@oscarlehuu](https://github.com/oscarlehuu))

### Patch Changes

- Fixed toast spam when the server was unreachable.

## 0.1.0 (2026-06-20)

### Minor Changes

- Initial public release.
`,
}));

function renderWithTheme(ui: ReactElement) {
  return render(<ThemeProvider defaultTheme="light">{ui}</ThemeProvider>);
}

describe('ChangelogView', () => {
  it('renders the page header', () => {
    renderWithTheme(<ChangelogView onBack={vi.fn()} />);
    expect(screen.getByRole('heading', { name: "What's new", level: 1 })).toBeInTheDocument();
  });

  it('renders versions newest-first', () => {
    renderWithTheme(<ChangelogView onBack={vi.fn()} />);
    const badges = screen.getAllByText(/^v0\.\d+\.\d+$/);
    expect(badges).toHaveLength(2);
    expect(badges[0]).toHaveTextContent('v0.2.0');
    expect(badges[1]).toHaveTextContent('v0.1.0');
  });

  it('renders category section titles', () => {
    renderWithTheme(<ChangelogView onBack={vi.fn()} />);
    expect(screen.getAllByText('Minor Changes').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Patch Changes')).toBeInTheDocument();
  });

  it('renders inline markdown — bold as <strong>, links as <a> with href', () => {
    renderWithTheme(<ChangelogView onBack={vi.fn()} />);
    // bold
    expect(screen.getByText("What's new", { selector: 'strong' })).toBeInTheDocument();
    // PR link
    const pr = screen.getByText('#5');
    expect(pr.tagName).toBe('A');
    expect(pr).toHaveAttribute('href', 'https://github.com/oscarlehuu/nuncio/pull/5');
    // author link
    const author = screen.getByText('@oscarlehuu');
    expect(author.tagName).toBe('A');
    expect(author).toHaveAttribute('href', 'https://github.com/oscarlehuu');
  });

  it('links each version to its GitHub release page', () => {
    renderWithTheme(<ChangelogView onBack={vi.fn()} />);
    const links = screen.getAllByText('Release notes');
    expect(links[0]).toHaveAttribute('href', 'https://github.com/oscarlehuu/nuncio/releases/tag/v0.2.0');
    expect(links[1]).toHaveAttribute('href', 'https://github.com/oscarlehuu/nuncio/releases/tag/v0.1.0');
  });

  it('renders the date stamp when present', () => {
    renderWithTheme(<ChangelogView onBack={vi.fn()} />);
    expect(screen.getByText('2026-06-20')).toBeInTheDocument();
  });

  it('calls onBack when the back button is clicked', async () => {
    const onBack = vi.fn();
    renderWithTheme(<ChangelogView onBack={onBack} />);
    await userEvent.click(screen.getByLabelText('Back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
