import type { ComponentType, SVGProps } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SettingsSectionNavItem {
  id: string;
  label: string;
  /** Lucide icon or a custom SVG component (e.g. Subscription bridge). */
  icon: LucideIcon | ComponentType<SVGProps<SVGSVGElement>>;
}

interface SettingsSectionNavProps {
  items: ReadonlyArray<SettingsSectionNavItem>;
  activeId: string;
  onSelect: (id: string) => void;
  /** `sidebar` = fills the main app sidebar (Cursor settings mode). */
  variant?: 'rail' | 'sidebar';
}

/**
 * Settings section list. `rail` is the legacy in-page aside (horizontal chips on
 * mobile); `sidebar` is a vertical list styled for the main app sidebar.
 */
export function SettingsSectionNav({
  items,
  activeId,
  onSelect,
  variant = 'rail',
}: SettingsSectionNavProps) {
  const sidebar = variant === 'sidebar';
  return (
    <nav
      aria-label="Settings sections"
      className={cn(
        sidebar
          ? 'flex flex-col gap-0.5 p-1'
          : 'flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2 sm:w-52 sm:flex-col sm:overflow-x-visible sm:overflow-y-auto sm:border-b-0 sm:border-r sm:p-3',
      )}
    >
      {items.map((item) => {
        const active = item.id === activeId;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-ui-lg text-left transition-colors',
              sidebar
                ? active
                  ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
                : active
                  ? 'border border-primary/30 bg-primary/10 font-medium text-foreground shadow-e0 ring-1 ring-primary/20'
                  : 'border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
