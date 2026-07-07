import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useAccent } from '../accent-provider';
import {
  ACCENT_META,
  isValidHex,
  normalizeHex,
  PRESET_ACCENTS,
} from '@/lib/accent-preference';

/**
 * Five preset swatches plus a Custom swatch that opens a native color input and
 * a hex field. Picking either commits immediately; the derived token set is
 * applied by AccentProvider (see custom-accent.ts). Selecting Custom while the
 * accent isn't custom yet switches to it using the last-picked hex.
 */
export function AccentPicker() {
  const { accent, setAccent, customHex, setCustomHex } = useAccent();
  const [draftHex, setDraftHex] = useState(customHex);
  const colorInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setDraftHex(customHex), [customHex]);

  const customSelected = accent === 'custom';

  const commitHex = (value: string) => {
    setDraftHex(value);
    if (isValidHex(value)) {
      const norm = normalizeHex(value);
      setCustomHex(norm);
      if (accent !== 'custom') setAccent('custom');
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div role="radiogroup" aria-label="Accent color" className="flex items-center gap-1.5">
        {PRESET_ACCENTS.map((value) => {
          const selected = accent === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={ACCENT_META[value].label}
              title={ACCENT_META[value].label}
              onClick={() => setAccent(value)}
              className={cn(
                'grid size-6 place-items-center rounded-full transition-transform',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card',
                'hover:scale-110 active:scale-95',
                selected && 'ring-2 ring-ring ring-offset-2 ring-offset-card',
              )}
            >
              <span
                className="size-4 rounded-full border border-black/10 dark:border-white/15"
                style={{ background: ACCENT_META[value].swatch }}
              />
            </button>
          );
        })}

        {/* Custom */}
        <button
          type="button"
          role="radio"
          aria-checked={customSelected}
          aria-label="Custom color"
          title="Custom color"
          onClick={() => (customSelected ? colorInputRef.current?.click() : setAccent('custom'))}
          className={cn(
            'relative grid size-6 place-items-center rounded-full transition-transform',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card',
            'hover:scale-110 active:scale-95',
            customSelected && 'ring-2 ring-ring ring-offset-2 ring-offset-card',
          )}
        >
          <span
            className="size-4 rounded-full border border-black/10 dark:border-white/15"
            style={{
              background: customSelected
                ? draftHex
                : 'conic-gradient(from 0deg, #ef4444, #eab308, #22c55e, #3b82f6, #a855f7, #ef4444)',
            }}
          />
        </button>
      </div>

      {customSelected && (
        <div className="flex items-center gap-2">
          <label className="relative size-7 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border">
            <span className="block size-full" style={{ background: draftHex }} />
            <input
              ref={colorInputRef}
              type="color"
              aria-label="Pick a custom accent color"
              value={isValidHex(draftHex) ? normalizeHex(draftHex) : customHex}
              onChange={(e) => commitHex(e.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>
          <div className="flex items-center rounded-md border border-border bg-background pl-2">
            <span className="text-ui text-muted-foreground">#</span>
            <input
              type="text"
              aria-label="Custom accent hex"
              spellCheck={false}
              autoCapitalize="none"
              value={draftHex.replace(/^#/, '')}
              onChange={(e) => commitHex(`#${e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6)}`)}
              className="w-16 bg-transparent py-1 pr-2 text-ui uppercase tabular-nums text-foreground outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}
