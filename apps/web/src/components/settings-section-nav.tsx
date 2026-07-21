import type { ComponentType, SVGProps } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SettingsSectionNavItem {
  id: string;
  label: string;
  /** Lucide icon or a custom SVG component (e.g. Subscription bridge). */
  icon: LucideIcon | ComponentType<SVGProps<SVGSVGElement>>;
}

interface SettingsSectionNavProps {
  items: ReadonlyArray<SettingsSectionNavItem>;
  activeId: string;
  onSelect: (id: string) => void;
}

/**
 * Left-hand section rail for the settings page. Collapses to a horizontally
 * scrollable chip row on narrow (mobile) viewports and a sticky vertical
 * sidebar from `sm` up, so the same buttons serve both layouts.
 */
export function SettingsSectionNav({ items, activeId, onSelect }: SettingsSectionNavProps) {
  return (
    <nav
      aria-label="Settings sections"
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2 sm:w-52 sm:flex-col sm:overflow-x-visible sm:overflow-y-auto sm:border-b-0 sm:border-r sm:p-3"
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
              'flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md border px-3 py-2 text-ui-lg text-left transition-colors',
              active
                ? 'border-primary/30 bg-primary/10 text-foreground font-medium shadow-e0 ring-1 ring-primary/20'
                : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
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
