import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from './theme-provider';
import { ModeToggle } from './mode-toggle';

function renderToggle() {
  return render(
    <ThemeProvider defaultTheme="light">
      <ModeToggle />
    </ThemeProvider>,
  );
}

describe('ModeToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('renders the theme toggle trigger', () => {
    renderToggle();
    expect(screen.getByRole('button', { name: 'Toggle theme' })).toBeInTheDocument();
  });

  it('offers light, dark, and system options and applies the selection', async () => {
    const user = userEvent.setup();
    renderToggle();

    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));
    expect(screen.getByRole('menuitem', { name: 'Light' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Dark' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'System' })).toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: 'Dark' }));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('nuncio-theme')).toBe('dark');
  });
});
