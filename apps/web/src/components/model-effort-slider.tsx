import { useRef, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from 'react';
import type { ModelOptionChoice } from '../lib/model-options';
import { cn } from '@/lib/utils';

interface ModelEffortSliderProps {
  label: string;
  choices: ModelOptionChoice[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

/** Stop the event from reaching the surrounding Radix menu (its grace-area /
 *  selection handlers would otherwise hijack the drag or dismiss the popup). */
function stopOnly(event: SyntheticEvent) {
  event.stopPropagation();
}

/**
 * Discrete Faster ↔ Smarter effort slider. Dragging is driven by our own
 * pointer-capture on the rail rather than a native range thumb: a native
 * `<input type="range">` inside Radix's nested submenu fights the menu's
 * pointer tracking and won't drag. The hidden input is kept purely for
 * keyboard control and assistive tech.
 */
export function ModelEffortSlider({
  label,
  choices,
  value,
  onChange,
  className,
}: ModelEffortSliderProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  if (choices.length < 2) return null;

  const activeIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.id === value),
  );
  const maxIndex = choices.length - 1;
  const thumbPercent = (activeIndex / maxIndex) * 100;
  const currentLabel = choices[activeIndex]?.label ?? value;

  const commitFromClientX = (clientX: number) => {
    const rail = railRef.current;
    if (!rail) return;
    const rect = rail.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = (clientX - rect.left) / rect.width;
    const next = Math.min(maxIndex, Math.max(0, Math.round(ratio * maxIndex)));
    if (next !== activeIndex) onChange(choices[next]!.id);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    draggingRef.current = true;
    // Capture so moves keep arriving even if the cursor leaves the rail.
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* not supported (e.g. jsdom) — drag still works while over the rail */
    }
    commitFromClientX(event.clientX);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    event.stopPropagation();
    commitFromClientX(event.clientX);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      /* no-op */
    }
    event.stopPropagation();
  };

  return (
    <div className={cn('model-effort-slider select-none', className)} onClick={stopOnly}>
      <div className="mb-2.5 flex items-baseline gap-1.5">
        <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
        <span className="text-[13px] font-semibold text-foreground">{currentLabel}</span>
      </div>

      <div className="mb-2 flex justify-between text-[11px] text-muted-foreground">
        <span>Faster</span>
        <span>Smarter</span>
      </div>

      <div className="relative h-6">
        <div
          ref={railRef}
          data-slot="effort-rail"
          className="absolute inset-x-2.5 inset-y-0 cursor-pointer touch-none"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div
            className="pointer-events-none absolute -inset-x-2.5 top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-muted"
            aria-hidden
          />
          <div
            className="pointer-events-none absolute top-1/2 left-[-10px] h-2.5 -translate-y-1/2 rounded-full bg-muted-foreground/35"
            style={{ width: `calc(${thumbPercent}% + 10px)` }}
            aria-hidden
          />

          {choices.map((choice, index) => {
            const left = (index / maxIndex) * 100;
            const isMax = index === maxIndex;
            const isActive = index === activeIndex;
            return (
              <span
                key={choice.id}
                className="pointer-events-none absolute top-1/2 z-[1] -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${left}%` }}
                aria-hidden
              >
                <span
                  className={cn(
                    'block rounded-full transition-opacity',
                    isActive ? 'size-0 opacity-0' : 'size-1.5',
                    isMax ? 'bg-primary' : 'bg-muted-foreground/55',
                  )}
                />
              </span>
            );
          })}

          <div
            className="pointer-events-none absolute top-1/2 z-[2] h-5 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[oklch(0.88_0.02_85)] shadow-md ring-1 ring-black/15"
            style={{ left: `${thumbPercent}%` }}
            aria-hidden
          />
        </div>

        <input
          type="range"
          min={0}
          max={maxIndex}
          step={1}
          value={activeIndex}
          onChange={(event) => onChange(choices[Number(event.target.value)]!.id)}
          onKeyDown={stopOnly}
          className="pointer-events-none absolute inset-0 size-full opacity-0"
          aria-label={`${label} effort`}
          aria-valuemin={0}
          aria-valuemax={maxIndex}
          aria-valuenow={activeIndex}
          aria-valuetext={choices[activeIndex]?.label}
        />
      </div>
    </div>
  );
}
