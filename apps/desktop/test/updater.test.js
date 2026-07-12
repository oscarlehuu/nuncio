const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const updaterPath = path.resolve(__dirname, '../src/updater.js');
const updaterSource = fs.readFileSync(updaterPath, 'utf8');

// Load updater.js in a sandbox with a fake `electron` + `electron-updater` so we
// can drive updater events and inspect the menu descriptor / dialogs without a
// real Electron runtime.
function loadUpdater({ version = '0.2.0-dev.4' } = {}) {
  const listeners = {};
  const state = {
    dialogs: [],
    dialogResponse: 1, // default: "Later" on the update-ready prompt
    logs: [],
    stateChanges: [],
    quitAndInstallCalls: 0,
    checkCalls: 0,
    channel: null,
    allowPrerelease: null,
  };

  const autoUpdater = {
    set channel(v) {
      state.channel = v;
    },
    set allowPrerelease(v) {
      state.allowPrerelease = v;
    },
    set autoDownload(_v) {},
    set autoInstallOnAppQuit(_v) {},
    set logger(_v) {},
    on(event, handler) {
      listeners[event] = handler;
    },
    checkForUpdates() {
      state.checkCalls += 1;
      return Promise.resolve();
    },
    quitAndInstall() {
      state.quitAndInstallCalls += 1;
    },
  };

  const sandboxModule = { exports: {} };
  const sandbox = {
    module: sandboxModule,
    exports: sandboxModule.exports,
    setImmediate: (cb) => cb(),
    setTimeout: () => 0,
    setInterval: () => 0,
    require(specifier) {
      if (specifier === 'electron') {
        return {
          app: { getVersion: () => version, name: 'Nuncio Dev' },
          dialog: {
            showMessageBox(options) {
              state.dialogs.push(options);
              return Promise.resolve({ response: state.dialogResponse });
            },
          },
        };
      }
      if (specifier === 'electron-updater') {
        return { autoUpdater };
      }
      throw new Error(`Unexpected require from updater.js test: ${specifier}`);
    },
  };

  vm.runInNewContext(updaterSource, sandbox, { filename: updaterPath });
  const mod = sandboxModule.exports;
  mod.initAutoUpdater({
    log: (m) => state.logs.push(m),
    onStateChange: (s) => state.stateChanges.push(s),
  });
  return { mod, listeners, state };
}

describe('desktop updater menu indicator', () => {
  test('resolveChannel follows the -dev prerelease tag', () => {
    const dev = loadUpdater({ version: '0.2.0-dev.4' });
    expect(dev.mod.resolveChannel()).toBe('dev');
    expect(dev.state.channel).toBe('dev');
    expect(dev.state.allowPrerelease).toBe(true);

    const stable = loadUpdater({ version: '0.2.0' });
    expect(stable.mod.resolveChannel()).toBe('latest');
    expect(stable.state.allowPrerelease).toBe(false);
  });

  test('idle menu item offers "Check for Updates…" and triggers a check', () => {
    const { mod, state } = loadUpdater();
    const item = mod.updaterMenuItem();
    expect(item.label).toBe('Check for Updates…');
    expect(item.enabled).toBe(true);

    item.click();
    expect(state.checkCalls).toBe(1);
    // Clicking flips the visible state to "checking" immediately.
    expect(mod.getUpdaterState().status).toBe('checking');
    expect(mod.updaterMenuItem().label).toBe('Checking for Updates…');
    expect(mod.updaterMenuItem().enabled).toBe(false);
  });

  test('the label tracks checking → downloading% → restart', () => {
    const { mod, listeners } = loadUpdater();

    listeners['checking-for-update']();
    expect(mod.updaterMenuItem().label).toBe('Checking for Updates…');

    listeners['update-available']({ version: '0.2.0-dev.5' });
    expect(mod.updaterMenuItem().label).toBe('Downloading Update… 0%');

    listeners['download-progress']({ percent: 41.7 });
    expect(mod.updaterMenuItem().label).toBe('Downloading Update… 42%');

    listeners['update-downloaded']({ version: '0.2.0-dev.5' });
    const ready = mod.updaterMenuItem();
    expect(ready.label).toBe('Restart to Install 0.2.0-dev.5');
    expect(ready.enabled).toBe(true);
  });

  test('every transition notifies the menu so it re-renders live', () => {
    const { listeners, state } = loadUpdater();
    const before = state.stateChanges.length;
    listeners['checking-for-update']();
    listeners['update-available']({ version: '0.2.0-dev.5' });
    listeners['download-progress']({ percent: 50 });
    listeners['update-downloaded']({ version: '0.2.0-dev.5' });
    expect(state.stateChanges.length).toBeGreaterThan(before + 3);
    expect(state.stateChanges.at(-1)).toMatchObject({ status: 'downloaded', percent: 100 });
  });

  test('a manual check that finds nothing shows an "up to date" dialog', async () => {
    const { mod, listeners, state } = loadUpdater();
    mod.checkForUpdates();
    listeners['update-not-available']({});
    await Promise.resolve();

    expect(state.dialogs).toHaveLength(1);
    expect(state.dialogs[0].title).toContain('up to date');
    expect(state.dialogs[0].message).toContain('latest version');
    // Back to the actionable idle label.
    expect(mod.updaterMenuItem().label).toBe('Check for Updates…');
  });

  test('a background check that finds nothing stays silent', async () => {
    const { listeners, state } = loadUpdater();
    // No menu click → the periodic timer's check is silent.
    listeners['update-not-available']({});
    await Promise.resolve();
    expect(state.dialogs).toHaveLength(0);
  });

  test('a manual check error surfaces a dialog; a background error does not', async () => {
    const { mod, listeners, state } = loadUpdater();
    mod.checkForUpdates();
    listeners['error'](new Error('network down'));
    await Promise.resolve();
    expect(state.dialogs).toHaveLength(1);
    expect(state.dialogs[0].type).toBe('error');
    expect(state.dialogs[0].detail).toContain('network down');

    state.dialogs.length = 0;
    listeners['error'](new Error('later background failure'));
    await Promise.resolve();
    expect(state.dialogs).toHaveLength(0);
  });

  test('a manual check against a not-yet-published build shows a calm info dialog', async () => {
    const { mod, listeners, state } = loadUpdater();
    // The GitHub provider's mid-CI-upload failure: release exists, manifest missing.
    mod.checkForUpdates();
    listeners['error'](
      new Error(
        'Cannot find latest-mac.yml in the latest release artifacts (https://github.com/oscarlehuu/nuncio/releases.atom): HttpError: 404',
      ),
    );
    await Promise.resolve();
    expect(state.dialogs).toHaveLength(1);
    expect(state.dialogs[0].type).toBe('info');
    expect(state.dialogs[0].title).toBe('No update available yet');
    // Back to the actionable idle label, not a stuck error state.
    expect(mod.updaterMenuItem().label).toBe('Check for Updates…');
    expect(mod.getUpdaterState().status).toBe('idle');
  });

  test('a background check against a not-yet-published build stays silent', async () => {
    const { mod, listeners, state } = loadUpdater();
    listeners['error'](new Error('No published versions on GitHub'));
    await Promise.resolve();
    expect(state.dialogs).toHaveLength(0);
    expect(mod.getUpdaterState().status).toBe('idle');
  });

  test('clicking the ready item installs; the ready dialog "Restart now" also installs', async () => {
    const { mod, listeners, state } = loadUpdater();
    state.dialogResponse = 0; // "Restart now"
    listeners['update-downloaded']({ version: '0.2.0-dev.5' });
    await Promise.resolve();
    expect(state.quitAndInstallCalls).toBe(1);

    // The menu item, once downloaded, installs directly on click too.
    mod.updaterMenuItem().click();
    expect(state.quitAndInstallCalls).toBe(2);
  });
});
