import type { ComponentProps } from 'react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Sidebar } from './sidebar';

type SidebarProps = ComponentProps<typeof Sidebar>;

export type DesktopSidebarShellProps = SidebarProps & {
  pinned: boolean;
  hovered: boolean;
  open: boolean;
  onOpenHover: () => void;
  onScheduleCloseHover: () => void;
  onTogglePin: () => void;
};

const safeTop = 'calc(12px + env(safe-area-inset-top, 0px))';

export function DesktopSidebarPinned({
  open,
  onTogglePin,
  ...sidebarProps
}: Pick<DesktopSidebarShellProps, 'open' | 'onTogglePin'> & SidebarProps) {
  return (
    <aside
      data-testid="desktop-sidebar-pinned"
      className="hidden md:flex w-[260px] shrink-0 border-r border-sidebar-border flex-col"
    >
      <div
        className="shrink-0 border-b border-sidebar-border p-3"
        style={{ paddingTop: safeTop }}
      >
        <Button
          data-testid="desktop-nav-toggle"
          variant="outline"
          size="icon"
          className="backdrop-blur"
          aria-label="Unpin sidebar"
          aria-expanded={open}
          onClick={onTogglePin}
        >
          <Menu />
        </Button>
      </div>
      <div className="flex-1 min-h-0">
        <Sidebar {...sidebarProps} />
      </div>
    </aside>
  );
}

/** Fixed hover rail — render after <main> so it stacks above page content. */
export function DesktopSidebarHoverRail({
  hovered,
  open,
  onOpenHover,
  onScheduleCloseHover,
  onTogglePin,
  ...sidebarProps
}: Pick<
  DesktopSidebarShellProps,
  'hovered' | 'open' | 'onOpenHover' | 'onScheduleCloseHover' | 'onTogglePin'
> &
  SidebarProps) {
  return (
    <div
      data-testid="desktop-sidebar-rail"
      className={cn(
        'hidden md:flex fixed left-0 top-0 bottom-0 z-[100] flex-col pointer-events-auto transition-[width] duration-200 ease-out',
        hovered
          ? 'w-[260px] border-r border-sidebar-border bg-sidebar shadow-xl'
          : 'w-14',
      )}
      onMouseEnter={onOpenHover}
      onMouseLeave={onScheduleCloseHover}
    >
      <div className="shrink-0 p-3" style={{ paddingTop: safeTop }}>
        <Button
          data-testid="desktop-nav-toggle"
          variant="outline"
          size="icon"
          className="backdrop-blur"
          aria-label="Pin sidebar"
          aria-expanded={open}
          onMouseEnter={onOpenHover}
          onFocus={onOpenHover}
          onClick={onTogglePin}
        >
          <Menu />
        </Button>
      </div>

      {/*
        The flyout stays mounted at all times so it can fade/slide in and out
        instead of popping. Its inner content is pinned to the expanded width
        (260px) so it never visually squishes while the rail width transitions;
        the aside's `overflow-hidden` clips whatever isn't revealed yet, and
        the rail itself stays non-clipping so the hamburger button is never cut.
      */}
      <aside
        data-testid="desktop-sidebar-flyout"
        className={cn(
          'flex-1 min-h-0 overflow-hidden border-t border-sidebar-border transition-all duration-150 ease-out',
          hovered
            ? 'opacity-100 translate-x-0'
            : 'pointer-events-none -translate-x-2 opacity-0',
        )}
      >
        <div className="w-[260px] h-full">
          <Sidebar {...sidebarProps} />
        </div>
      </aside>
    </div>
  );
}

export function DesktopSidebarShell(props: DesktopSidebarShellProps) {
  if (props.pinned) {
    return <DesktopSidebarPinned {...props} />;
  }
  return <DesktopSidebarHoverRail {...props} />;
}
