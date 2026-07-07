const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

// Re-check periodically so a long-running window still picks up releases.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 10_000;

// Single source of truth for the "Check for Updates…" menu item. Its label
// doubles as the always-available update indicator, so the founder can both
// trigger a check and watch the download without hunting for a dialog.
//   status: 'idle' | 'checking' | 'downloading' | 'downloaded' | 'up-to-date' | 'error'
let state = { status: 'idle', percent: 0, version: null };
let notifyStateChange = () => {};
let log = () => {};
// Invoked right before quitAndInstall(). Lets the shell mark that a real quit is
// underway so a close-to-tray window 'close' handler does not intercept and hide
// the window — which would swallow the install (quitAndInstall emits the window
// 'close' before 'before-quit', so the flag must be set here, ahead of it).
let beforeQuitForInstall = () => {};
// True while an in-flight check was started by the founder (menu click) rather
// than the silent background timer — only manual checks surface a result dialog.
let manualCheck = false;

// Dev builds carry a semver prerelease tag (e.g. 0.3.0-dev.5) and track the
// `dev` channel published to GitHub prereleases; stable builds track `latest`.
function resolveChannel() {
  return app.getVersion().includes('-dev') ? 'dev' : 'latest';
}

function setState(patch) {
  state = { ...state, ...patch };
  notifyStateChange(getUpdaterState());
}

function getUpdaterState() {
  return { ...state };
}

// Pure state → menu descriptor. main.js splices the returned object straight
// into its application-menu template.
function updaterMenuItem() {
  switch (state.status) {
    case 'checking':
      return { label: 'Checking for Updates…', enabled: false };
    case 'downloading':
      return { label: `Downloading Update… ${state.percent}%`, enabled: false };
    case 'downloaded':
      return {
        label: state.version ? `Restart to Install ${state.version}` : 'Restart to Install Update',
        enabled: true,
        click: () => installNow(),
      };
    default:
      return { label: 'Check for Updates…', enabled: true, click: () => checkForUpdates() };
  }
}

function installNow() {
  // Signal the impending quit before it starts so the shell stops intercepting
  // the window close to the tray.
  try {
    beforeQuitForInstall();
  } catch {
    // A shell callback error must not prevent the install.
  }
  // Defer so the menu/dialog dismisses before the app tears down.
  setImmediate(() => autoUpdater.quitAndInstall());
}

// Founder-initiated check (menu click). A staged update installs immediately;
// otherwise kick off a fresh check that will surface a result dialog.
function checkForUpdates() {
  if (state.status === 'downloaded') {
    installNow();
    return;
  }
  if (state.status === 'checking' || state.status === 'downloading') return;
  manualCheck = true;
  setState({ status: 'checking' });
  autoUpdater.checkForUpdates().catch((err) => log(`[updater] check failed: ${err?.message ?? err}`));
}

function initAutoUpdater({
  log: logImpl = () => {},
  onStateChange = () => {},
  onBeforeQuitForInstall = () => {},
} = {}) {
  log = logImpl;
  notifyStateChange = onStateChange;
  beforeQuitForInstall = onBeforeQuitForInstall;

  const channel = resolveChannel();
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
  autoUpdater.channel = channel;
  autoUpdater.allowPrerelease = channel === 'dev';
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    log(`[updater] error: ${err?.message ?? err}`);
    const wasManual = manualCheck;
    manualCheck = false;
    setState({ status: 'error', percent: 0 });
    if (wasManual) {
      dialog.showMessageBox({
        type: 'error',
        buttons: ['OK'],
        title: 'Nuncio update check failed',
        message: 'Could not check for updates.',
        detail: String(err?.message ?? err),
      });
    }
  });

  autoUpdater.on('checking-for-update', () => {
    log('[updater] checking for update');
    setState({ status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    log(`[updater] update available: ${info?.version}`);
    // autoDownload is on, so an available update is already downloading.
    setState({ status: 'downloading', version: info?.version ?? null, percent: 0 });
  });

  autoUpdater.on('update-not-available', () => {
    log('[updater] up to date');
    const wasManual = manualCheck;
    manualCheck = false;
    setState({ status: 'up-to-date', percent: 0, version: null });
    if (wasManual) {
      dialog.showMessageBox({
        type: 'info',
        buttons: ['OK'],
        title: 'Nuncio is up to date',
        message: `You’re on the latest version (${app.getVersion()}).`,
      });
    }
  });

  autoUpdater.on('download-progress', (p) => {
    const percent = Math.round(p?.percent ?? 0);
    log(`[updater] downloading ${percent}%`);
    setState({ status: 'downloading', percent });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    log(`[updater] downloaded ${info?.version}`);
    manualCheck = false;
    setState({ status: 'downloaded', version: info?.version ?? null, percent: 100 });
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Nuncio update ready',
      message: `Nuncio ${info?.version} is ready to install.`,
      detail: 'Restart to apply it now, or it will install automatically the next time you quit.',
    });
    if (response === 0) {
      installNow();
    }
  });

  const check = () =>
    autoUpdater.checkForUpdates().catch((err) => log(`[updater] check failed: ${err?.message ?? err}`));

  log(`[updater] channel=${channel} version=${app.getVersion()}`);
  setTimeout(check, FIRST_CHECK_DELAY_MS);
  setInterval(check, CHECK_INTERVAL_MS);
}

module.exports = { initAutoUpdater, resolveChannel, checkForUpdates, updaterMenuItem, getUpdaterState };
