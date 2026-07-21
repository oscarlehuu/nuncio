/**
 * macOS desktop-shell chrome detection. When the Electron shell runs with
 * `titleBarStyle: 'hiddenInset'` (macOS only), the web app must provide drag
 * regions and traffic-light clearance. Styling is driven entirely by CSS under
 * `:root[data-desktop-chrome='mac']` (see index.css) so components can carry
 * inert `app-region-*` classes unconditionally.
 */
export function isMacDesktopShell(): boolean {
  if (typeof window === 'undefined') return false;
  const shell = window.nuncioDesktop;
  return shell?.marker === 'desktop' && shell.platform === 'darwin';
}

/** Stamp the root element once at boot; a no-op outside the mac desktop shell. */
export function applyDesktopChromeAttribute(): void {
  if (!isMacDesktopShell()) return;
  document.documentElement.dataset.desktopChrome = 'mac';
}
