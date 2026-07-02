import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTheme, type Theme } from './theme-provider';
import { useAppearance } from './appearance-provider';
import type { Density } from '@/lib/appearance-preference';

const THEME_OPTIONS: ReadonlyArray<{ value: Theme; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

const DENSITY_OPTIONS: ReadonlyArray<{ value: Density; label: string }> = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
];

const FONT_SCALE_MIN = 0.85;
const FONT_SCALE_MAX = 1.4;
const FONT_SCALE_STEP = 0.05;

export function AppearanceSettingsSection() {
  const { theme, setTheme } = useTheme();
  const { fontScale, setFontScale, density, setDensity } = useAppearance();

  const resetToDefaults = () => {
    setTheme('system');
    setFontScale(1);
    setDensity('comfortable');
  };

  return (
    <section className="mt-4 first:mt-0">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-ui-lg font-medium text-muted-foreground">Appearance</h2>
        <button
          type="button"
          onClick={resetToDefaults}
          className="text-ui-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Reset to defaults
        </button>
      </div>
      <div className="border border-border rounded-xl overflow-hidden bg-card px-4 divide-y divide-border/60">
        {/* Theme */}
        <div className="flex items-center justify-between py-3 gap-3">
          <div className="flex flex-col">
            <span className="text-ui-lg font-medium text-foreground">Theme</span>
            <span className="text-ui text-muted-foreground">Light, dark, or match your system</span>
          </div>
          <div role="group" aria-label="Theme" className="flex items-center gap-0.5">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setTheme(opt.value)}
                aria-pressed={theme === opt.value}
                className={cn(
                  'rounded-md px-2.5 py-1 text-ui font-medium transition-colors',
                  theme === opt.value
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Font size */}
        <div className="py-3">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="flex flex-col">
              <span className="text-ui-lg font-medium text-foreground">Chat font size</span>
              <span className="text-ui text-muted-foreground">Scales chat text; code blocks stay fixed</span>
            </div>
            <span className="text-ui tabular-nums text-muted-foreground">
              {Math.round((fontScale / 1) * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={FONT_SCALE_MIN}
            max={FONT_SCALE_MAX}
            step={FONT_SCALE_STEP}
            value={fontScale}
            onChange={(e) => setFontScale(Number(e.target.value))}
            aria-label="Chat font size"
            className="w-full accent-primary"
          />
          <div
            className="mt-2.5 rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-foreground/90 leading-relaxed"
            style={{ fontSize: `calc(14px * ${fontScale})` }}
            data-testid="appearance-font-preview"
          >
            The quick brown fox jumps over the lazy dog.
          </div>
        </div>

        {/* Density */}
        <div className="flex items-center justify-between py-3 gap-3">
          <div className="flex flex-col">
            <span className="text-ui-lg font-medium text-foreground">Density</span>
            <span className="text-ui text-muted-foreground">Vertical spacing between messages</span>
          </div>
          <div role="group" aria-label="Density" className="flex items-center gap-0.5">
            {DENSITY_OPTIONS.map((opt) => (
              <Button
                key={opt.value}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setDensity(opt.value)}
                aria-pressed={density === opt.value}
                className={cn(
                  'h-auto rounded-md px-2.5 py-1 text-ui font-medium',
                  density === opt.value
                    ? 'bg-secondary text-foreground hover:bg-secondary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
