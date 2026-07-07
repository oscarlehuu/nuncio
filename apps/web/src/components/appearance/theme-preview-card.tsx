import { cn } from '@/lib/utils';
import type { Theme } from '../theme-provider';

/**
 * A miniature CSS mock of the app chrome — a sidebar strip beside stacked
 * content lines — rendered in fixed light/dark palettes so each card previews
 * the theme it selects regardless of the current one. `system` splits the mock
 * down the middle: light left, dark right.
 */
function Mock({ variant }: { variant: 'light' | 'dark' | 'system' }) {
  if (variant === 'system') {
    return (
      <div className="flex h-full w-full overflow-hidden">
        <div className="w-1/2 overflow-hidden">
          <MockFace tone="light" clipRight />
        </div>
        <div className="w-1/2 overflow-hidden">
          <MockFace tone="dark" clipLeft />
        </div>
      </div>
    );
  }
  return <MockFace tone={variant} />;
}

function MockFace({
  tone,
  clipLeft,
  clipRight,
}: {
  tone: 'light' | 'dark';
  clipLeft?: boolean;
  clipRight?: boolean;
}) {
  const light = tone === 'light';
  const bg = light ? '#f4f4f5' : '#1c1c20';
  const sidebar = light ? '#e6e6ea' : '#141417';
  const card = light ? '#ffffff' : '#26262b';
  const line = light ? '#d4d4d8' : '#3a3a40';
  const lineStrong = light ? '#a1a1aa' : '#55555d';
  return (
    <div
      className={cn(
        'flex h-full w-full gap-1 p-1.5',
        clipRight && 'pr-0',
        clipLeft && 'pl-0',
      )}
      style={{ background: bg }}
    >
      <div className="flex w-1/4 flex-col gap-1 rounded-[3px] p-1" style={{ background: sidebar }}>
        <span className="h-1 w-full rounded-full" style={{ background: lineStrong }} />
        <span className="h-1 w-3/4 rounded-full" style={{ background: line }} />
        <span className="h-1 w-3/4 rounded-full" style={{ background: line }} />
      </div>
      <div
        className="flex flex-1 flex-col gap-1 rounded-[3px] p-1.5"
        style={{ background: card }}
      >
        <span className="h-1.5 w-2/3 rounded-full" style={{ background: lineStrong }} />
        <span className="h-1 w-full rounded-full" style={{ background: line }} />
        <span className="h-1 w-5/6 rounded-full" style={{ background: line }} />
        <span className="h-1 w-4/6 rounded-full" style={{ background: line }} />
      </div>
    </div>
  );
}

interface ThemePreviewCardProps {
  value: Theme;
  label: string;
  selected: boolean;
  onSelect: () => void;
}

export function ThemePreviewCard({ value, label, selected, onSelect }: ThemePreviewCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      onClick={onSelect}
      className={cn(
        'group flex flex-col gap-1.5 rounded-lg p-1.5 text-left transition-transform',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card',
        'active:scale-[0.98]',
      )}
    >
      <span
        className={cn(
          'block h-14 overflow-hidden rounded-md border transition-colors',
          selected
            ? 'border-transparent ring-2 ring-ring'
            : 'border-border group-hover:border-foreground/25',
        )}
      >
        <Mock variant={value} />
      </span>
      <span
        className={cn(
          'text-ui font-medium transition-colors',
          selected ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground',
        )}
      >
        {label}
      </span>
    </button>
  );
}
