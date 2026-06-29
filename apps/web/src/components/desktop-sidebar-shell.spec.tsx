import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ThemeProvider } from './theme-provider';
import { DesktopSidebarHoverRail } from './desktop-sidebar-shell';
import type { Session } from '../lib/api';

function renderWithTheme(ui: ReactElement) {
  return render(<ThemeProvider defaultTheme="light">{ui}</ThemeProvider>);
}

const noop = () => {};

const sidebarProps = {
  sessions: [] as Session[],
  archivedSessions: [],
  activeId: null,
  onSelect: noop,
  onNew: noop,
};

const railProps = {
  open: false,
  onOpenHover: noop,
  onScheduleCloseHover: noop,
  onTogglePin: noop,
};

describe('DesktopSidebarHoverRail animation', () => {
  it('animates the rail width via a CSS transition', () => {
    renderWithTheme(
      <DesktopSidebarHoverRail {...railProps} {...sidebarProps} hovered={false} />,
    );
    const rail = screen.getByTestId('desktop-sidebar-rail');
    // Width must transition smoothly instead of snapping.
    expect(rail.className).toMatch(/transition-\[width\]|transition-all/);
    expect(rail.className).toMatch(/duration-/);
  });

  it('keeps the flyout mounted (collapsed) so it can fade out instead of unmounting abruptly', () => {
    renderWithTheme(
      <DesktopSidebarHoverRail {...railProps} {...sidebarProps} hovered={false} />,
    );
    // The flyout stays in the DOM so an exit animation can run.
    expect(screen.getByTestId('desktop-sidebar-flyout')).toBeInTheDocument();
  });

  it('renders the flyout faded out + shifted left when not hovered', () => {
    renderWithTheme(
      <DesktopSidebarHoverRail {...railProps} {...sidebarProps} hovered={false} />,
    );
    const flyout = screen.getByTestId('desktop-sidebar-flyout');
    expect(flyout.className).toMatch(/opacity-0\b/);
    // Shifted off toward the left edge so it doesn't appear to "pop".
    expect(flyout.className).toMatch(/-translate-x/);
    // No interactive content while hidden.
    expect(flyout.className).toMatch(/pointer-events-none/);
  });

  it('renders the flyout fully visible + in place when hovered', () => {
    renderWithTheme(
      <DesktopSidebarHoverRail {...railProps} {...sidebarProps} hovered={true} />,
    );
    const flyout = screen.getByTestId('desktop-sidebar-flyout');
    expect(flyout.className).toMatch(/opacity-100\b/);
    expect(flyout.className).toMatch(/translate-x-0\b/);
    expect(flyout.className).not.toMatch(/pointer-events-none/);
  });

  it('uses the collapsed rail width when not hovered and the expanded width when hovered', () => {
    const { rerender } = renderWithTheme(
      <DesktopSidebarHoverRail {...railProps} {...sidebarProps} hovered={false} />,
    );
    const rail = screen.getByTestId('desktop-sidebar-rail');
    expect(rail.className).toMatch(/\bw-14\b/);

    rerender(
      <ThemeProvider defaultTheme="light">
        <DesktopSidebarHoverRail {...railProps} {...sidebarProps} hovered={true} />
      </ThemeProvider>,
    );
    expect(rail.className).toMatch(/\bw-\[260px\](?=\s|$)/);
  });

  it('does NOT trigger openHover when hovering the rail (only the hamburger button should)', () => {
    const onOpenHover = vi.fn();
    renderWithTheme(
      <DesktopSidebarHoverRail
        {...railProps}
        {...sidebarProps}
        hovered={false}
        onOpenHover={onOpenHover}
      />,
    );
    const rail = screen.getByTestId('desktop-sidebar-rail');
    fireEvent.mouseEnter(rail);
    expect(onOpenHover).not.toHaveBeenCalled();
  });

  it('triggers openHover when hovering the hamburger button', () => {
    const onOpenHover = vi.fn();
    renderWithTheme(
      <DesktopSidebarHoverRail
        {...railProps}
        {...sidebarProps}
        hovered={false}
        onOpenHover={onOpenHover}
      />,
    );
    const button = screen.getByTestId('desktop-nav-toggle');
    fireEvent.mouseEnter(button);
    expect(onOpenHover).toHaveBeenCalledTimes(1);
  });

  it('triggers scheduleCloseHover when the cursor leaves the rail', () => {
    const onScheduleCloseHover = vi.fn();
    renderWithTheme(
      <DesktopSidebarHoverRail
        {...railProps}
        {...sidebarProps}
        hovered={true}
        onScheduleCloseHover={onScheduleCloseHover}
      />,
    );
    const rail = screen.getByTestId('desktop-sidebar-rail');
    fireEvent.mouseLeave(rail);
    expect(onScheduleCloseHover).toHaveBeenCalledTimes(1);
  });
});
