import { useTheme, type Theme } from './theme-provider';
import { useAppearance } from './appearance-provider';
import { useAccent } from './accent-provider';
import { DEFAULT_ACCENT, DEFAULT_CUSTOM_HEX } from '@/lib/accent-preference';
import {
  CODE_FONT_OPTIONS,
  CODE_FONT_SIZE_MAX,
  CODE_FONT_SIZE_MIN,
  UI_FONT_OPTIONS,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  type DiffMarkers,
  type MotionMode,
} from '@/lib/appearance-preference';
import { AccentPicker } from './appearance/accent-picker';
import { ThemePreviewCard } from './appearance/theme-preview-card';
import {
  FieldRow,
  FontSelect,
  SegmentedControl,
  Stepper,
} from './appearance/appearance-controls';
import { Switch } from './ui/switch';

const THEME_CARDS: ReadonlyArray<{ value: Theme; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/* Field is labeled "Reduce motion", so the choice axis is *reduction*, the
 * inverse of the stored `motion` axis (motion=on keeps animation, motion=off
 * force-stills it — see the data-motion CSS layer). Map label→stored here so
 * "Reduce motion: On" force-stills and "Off" keeps motion. */
type ReduceChoice = 'system' | 'on' | 'off';

const REDUCE_OPTIONS: ReadonlyArray<{ value: ReduceChoice; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

const REDUCE_TO_MOTION: Record<ReduceChoice, MotionMode> = {
  system: 'system',
  on: 'off',
  off: 'on',
};

const MOTION_TO_REDUCE: Record<MotionMode, ReduceChoice> = {
  system: 'system',
  off: 'on',
  on: 'off',
};

const DENSITY_OPTIONS = [
  { value: 'comfortable' as const, label: 'Comfortable' },
  { value: 'compact' as const, label: 'Compact' },
];

const DIFF_OPTIONS: ReadonlyArray<{ value: DiffMarkers; label: string }> = [
  { value: 'color', label: 'Color' },
  { value: 'symbol', label: '+ / −' },
];

const FONT_SCALE_MIN = 0.85;
const FONT_SCALE_MAX = 1.4;

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1.5 mt-5 text-ui-sm font-medium uppercase tracking-wide text-muted-foreground/70">
        {title}
      </h3>
      <div className="rounded-xl border border-border bg-card px-4 divide-y divide-border/60">
        {children}
      </div>
    </div>
  );
}

export function AppearanceSettingsSection() {
  const { theme, setTheme } = useTheme();
  const { setAccent, setCustomHex } = useAccent();
  const a = useAppearance();

  const resetToDefaults = () => {
    setTheme('system');
    setAccent(DEFAULT_ACCENT);
    setCustomHex(DEFAULT_CUSTOM_HEX);
    a.reset();
  };

  return (
    <section className="mt-4 first:mt-0">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-ui-lg font-medium text-muted-foreground">Appearance</h2>
        <button
          type="button"
          onClick={resetToDefaults}
          className="text-ui-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          Reset to defaults
        </button>
      </div>

      {/* Theme cards */}
      <Group title="Theme">
        <div className="py-3">
          <p className="mb-2.5 text-ui text-muted-foreground">
            Choose light, dark, or follow your operating system.
          </p>
          <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2">
            {THEME_CARDS.map((card) => (
              <ThemePreviewCard
                key={card.value}
                value={card.value}
                label={card.label}
                selected={theme === card.value}
                onSelect={() => setTheme(card.value)}
              />
            ))}
          </div>
        </div>
        <FieldRow
          title="Accent color"
          description="Signature hue for buttons, focus, and active state"
        >
          <AccentPicker />
        </FieldRow>
      </Group>

      {/* Typography */}
      <Group title="Typography">
        <FieldRow
          title="Interface font size"
          description="Base size for menus, lists, and controls"
          htmlFor="ui-font-size"
        >
          <Stepper
            id="ui-font-size"
            ariaLabel="Interface font size"
            value={a.uiFontSize}
            min={UI_FONT_SIZE_MIN}
            max={UI_FONT_SIZE_MAX}
            onChange={a.setUiFontSize}
          />
        </FieldRow>
        <FieldRow
          title="Interface font"
          description="Typeface for the app chrome"
          htmlFor="ui-font"
        >
          <FontSelect
            id="ui-font"
            ariaLabel="Interface font"
            value={a.uiFont}
            options={[...UI_FONT_OPTIONS, { value: 'custom', label: 'Custom…' }]}
            onChange={a.setUiFont}
          />
        </FieldRow>
        {a.uiFont === 'custom' && (
          <CustomFontRow
            label="UI font family"
            value={a.uiFontCustom}
            onChange={a.setUiFontCustom}
            placeholder="e.g. Helvetica Neue, sans-serif"
          />
        )}
        <FieldRow
          title="Code font size"
          description="Monospace size in diffs and code blocks"
          htmlFor="code-font-size"
        >
          <Stepper
            id="code-font-size"
            ariaLabel="Code font size"
            value={a.codeFontSize}
            min={CODE_FONT_SIZE_MIN}
            max={CODE_FONT_SIZE_MAX}
            onChange={a.setCodeFontSize}
          />
        </FieldRow>
        <FieldRow title="Code font" description="Typeface for code and diffs" htmlFor="code-font">
          <FontSelect
            id="code-font"
            ariaLabel="Code font"
            value={a.codeFont}
            options={[...CODE_FONT_OPTIONS, { value: 'custom', label: 'Custom…' }]}
            onChange={a.setCodeFont}
          />
        </FieldRow>
        {a.codeFont === 'custom' && (
          <CustomFontRow
            label="Code font family"
            value={a.codeFontCustom}
            onChange={a.setCodeFontCustom}
            placeholder="e.g. Cascadia Code, monospace"
          />
        )}
      </Group>

      {/* Chat */}
      <Group title="Chat">
        <div className="py-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex flex-col">
              <span className="text-ui-lg font-medium text-foreground">Chat font size</span>
              <span className="text-ui text-muted-foreground">Scales chat text; code stays fixed</span>
            </div>
            <span className="text-ui tabular-nums text-muted-foreground">
              {Math.round(a.fontScale * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={FONT_SCALE_MIN}
            max={FONT_SCALE_MAX}
            step={0.05}
            value={a.fontScale}
            onChange={(e) => a.setFontScale(Number(e.target.value))}
            aria-label="Chat font size"
            className="w-full accent-primary"
          />
          <div
            className="mt-2.5 rounded-md border border-border/40 bg-muted/20 px-3 py-2 leading-relaxed text-foreground/90"
            style={{ fontSize: `calc(14px * ${a.fontScale})` }}
            data-testid="appearance-font-preview"
          >
            The quiet fox drafts a pull request at dawn.
          </div>
        </div>
        <FieldRow title="Density" description="Vertical spacing between messages">
          <SegmentedControl
            ariaLabel="Density"
            options={DENSITY_OPTIONS}
            value={a.density}
            onChange={a.setDensity}
          />
        </FieldRow>
      </Group>

      {/* Motion & interaction */}
      <Group title="Motion & interaction">
        <FieldRow title="Reduce motion" description="Quiet the running-agent glow and transitions">
          <SegmentedControl
            ariaLabel="Reduce motion"
            options={REDUCE_OPTIONS}
            value={MOTION_TO_REDUCE[a.motion]}
            onChange={(choice) => a.setMotion(REDUCE_TO_MOTION[choice])}
          />
        </FieldRow>
        <FieldRow
          title="Pointer cursors"
          description="Show a hand cursor over buttons and links"
          htmlFor="pointer-cursors"
        >
          <Switch
            id="pointer-cursors"
            checked={a.pointerCursors}
            onCheckedChange={a.setPointerCursors}
            aria-label="Pointer cursors"
          />
        </FieldRow>
        <FieldRow title="Diff markers" description="Color fills or plain + / − glyphs">
          <SegmentedControl
            ariaLabel="Diff markers"
            options={DIFF_OPTIONS}
            value={a.diffMarkers}
            onChange={a.setDiffMarkers}
          />
        </FieldRow>
      </Group>
    </section>
  );
}

function CustomFontRow({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="py-3">
      <input
        type="text"
        aria-label={label}
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-ui text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </div>
  );
}
