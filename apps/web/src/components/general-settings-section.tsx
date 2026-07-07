import { useCallback, useEffect, useState } from 'react';
import { Switch } from '@/components/ui/switch';

/**
 * Desktop-only General settings: the "keep running in the menu bar" toggle.
 *
 * Rendered only inside the desktop shell (which exposes `window.nuncioDesktop`)
 * and only when the shell is new enough to carry the `shell` IPC surface — web
 * browser users never see a control they cannot act on. The switch reads the
 * current value on mount and writes back through the shell IPC bridge.
 */
export function GeneralSettingsSection() {
  const shell = typeof window !== 'undefined' ? window.nuncioDesktop?.shell : undefined;
  const isDesktop = typeof window !== 'undefined' && window.nuncioDesktop?.marker === 'desktop';

  const [closeToTray, setCloseToTray] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!shell) return;
    let cancelled = false;
    shell
      .getSettings()
      .then((settings) => {
        if (!cancelled) setCloseToTray(settings.closeToTray);
      })
      .catch(() => {
        // Bridge unavailable or errored — leave the control hidden rather than
        // rendering a toggle whose state we cannot trust.
      });
    return () => {
      cancelled = true;
    };
  }, [shell]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      if (!shell || saving) return;
      setSaving(true);
      // Optimistic: reflect the intent immediately, reconcile with the shell's
      // authoritative response (or roll back on failure).
      const previous = closeToTray;
      setCloseToTray(next);
      try {
        const settings = await shell.setSettings({ closeToTray: next });
        setCloseToTray(settings.closeToTray);
      } catch {
        setCloseToTray(previous);
      } finally {
        setSaving(false);
      }
    },
    [shell, saving, closeToTray],
  );

  // Only surface the control inside a desktop shell that actually exposes it,
  // and only once its current value has loaded.
  if (!isDesktop || !shell || closeToTray === null) return null;

  return (
    <section>
      <h2 className="mb-2 text-ui-lg font-medium text-muted-foreground">Desktop</h2>
      <div className="overflow-hidden rounded-lg border border-border bg-card px-4">
        <div className="flex items-center justify-between gap-3 py-3">
          <div className="flex min-w-0 flex-col">
            <span className="text-ui-lg font-medium text-foreground">Keep running in the menu bar</span>
            <span className="text-ui text-muted-foreground">
              Closing the window hides Nuncio to the menu bar instead of quitting, so paired phones
              stay connected. Quit from the menu-bar icon to stop it.
            </span>
          </div>
          <Switch
            checked={closeToTray}
            onCheckedChange={(next) => void handleToggle(next)}
            disabled={saving}
            aria-label="Keep running in the menu bar"
          />
        </div>
      </div>
    </section>
  );
}
