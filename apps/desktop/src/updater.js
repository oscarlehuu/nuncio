const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

// Re-check periodically so a long-running window still picks up releases.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 10_000;

// Dev builds carry a semver prerelease tag (e.g. 0.3.0-dev.5) and track the
// `dev` channel published to GitHub prereleases; stable builds track `latest`.
function resolveChannel() {
  return app.getVersion().includes('-dev') ? 'dev' : 'latest';
}

function initAutoUpdater({ log = () => {} } = {}) {
  const channel = resolveChannel();
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
  autoUpdater.channel = channel;
  autoUpdater.allowPrerelease = channel === 'dev';
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => log(`[updater] error: ${err?.message ?? err}`));
  autoUpdater.on('checking-for-update', () => log('[updater] checking for update'));
  autoUpdater.on('update-available', (info) => log(`[updater] update available: ${info?.version}`));
  autoUpdater.on('update-not-available', () => log('[updater] up to date'));
  autoUpdater.on('download-progress', (p) => log(`[updater] downloading ${Math.round(p?.percent ?? 0)}%`));
  autoUpdater.on('update-downloaded', async (info) => {
    log(`[updater] downloaded ${info?.version}`);
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
      // Defer so the dialog dismisses before the app tears down.
      setImmediate(() => autoUpdater.quitAndInstall());
    }
  });

  const check = () =>
    autoUpdater.checkForUpdates().catch((err) => log(`[updater] check failed: ${err?.message ?? err}`));

  log(`[updater] channel=${channel} version=${app.getVersion()}`);
  setTimeout(check, FIRST_CHECK_DELAY_MS);
  setInterval(check, CHECK_INTERVAL_MS);
}

module.exports = { initAutoUpdater, resolveChannel };
