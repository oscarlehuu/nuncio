const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

const mainPath = path.resolve(__dirname, '../src/main.js');
const mainSource = fs.readFileSync(mainPath, 'utf8');

function fakeNodePty() {
  const ptys = [];
  return {
    ptys,
    implementation: {
      spawn() {
        const handlers = { data: null, exit: null };
        const pty = {
          handlers,
          killCalls: 0,
          writes: [],
          resizes: [],
          kill() {
            this.killCalls += 1;
          },
          write(data) {
            this.writes.push(data);
          },
          resize(cols, rows) {
            this.resizes.push({ cols, rows });
          },
          onData(handler) {
            handlers.data = handler;
          },
          onExit(handler) {
            handlers.exit = handler;
          },
        };
        ptys.push(pty);
        return pty;
      },
    },
  };
}

async function runMain({
  env = {},
  fetchImpl,
  advanceTimers = false,
  singleInstanceLock = true,
  onDaemonStart,
  appIsPackaged = false,
  appVersion = '0.2.0',
  appDataPath = path.join(__dirname, 'app-data'),
  resourcesPath = path.join(__dirname, 'missing-resources'),
  userDataPath = null,
  nodePtyImpl = null,
  daemonUrl = 'http://daemon.test:3000',
  displays = [{ workArea: { x: 0, y: 0, width: 2560, height: 1440 } }],
} = {}) {
  const state = {
    appHandlers: {},
    appCalls: [],
    appName: 'Nuncio',
    configuredAppDataPath: appDataPath,
    configuredUserDataPath: userDataPath,
    singleInstanceSnapshots: [],
    trustedRendererUrl: null,
    trustedIpcEvent(url) {
      const rendererUrl = url ?? state.trustedRendererUrl ?? 'http://localhost:5173/';
      const sender = state.windows[state.windows.length - 1]?.webContents ?? {
        getURL: () => rendererUrl,
      };
      return {
        senderFrame: { url: rendererUrl },
        sender,
      };
    },
    daemonConstructed: 0,
    daemonOptions: [],
    daemonStartCalls: 0,
    daemonStopCalls: 0,
    devToolsCalls: [],
    dialogErrors: [],
    browserBounds: [],
    browserLoads: [],
    browserPartitions: [],
    browserReloads: 0,
    browserViews: [],
    browserExecuteScripts: [],
    browserSentEvents: [],
    windowSentEvents: [],
    ipcHandlers: {},
    ipcListeners: {},
    focusCalls: 0,
    loadedUrls: [],
    removedBrowserViews: [],
    setBrowserViews: [],
    windows: [],
    logs: [],
    errors: [],
    externalOpens: [],
    maximizeCalls: 0,
    quitCalls: 0,
    trays: [],
    singleInstanceLock,
  };

  let readyPromise;
  let fakeNow = 0;

  function sandboxSetTimeout(callback, ms = 0, ...args) {
    return setTimeout(() => {
      if (advanceTimers) {
        fakeNow += ms;
      }
      callback(...args);
    }, advanceTimers ? 0 : ms);
  }

  class SandboxDate extends Date {
    static now() {
      return advanceTimers ? fakeNow : Date.now();
    }
  }

  const fakeApp = {
    whenReady() {
      return {
        then(callback) {
          // A losing second instance quits before ready; Electron never fires
          // whenReady in that case, so neither does the mock.
          if (!state.singleInstanceLock) {
            readyPromise = Promise.resolve();
            return readyPromise;
          }
          readyPromise = Promise.resolve().then(callback);
          return readyPromise;
        },
      };
    },
    on(eventName, handler) {
      state.appHandlers[eventName] = handler;
    },
    quit() {
      state.quitCalls += 1;
    },
    requestSingleInstanceLock() {
      state.appCalls.push('request-lock');
      const snapshot = {
        name: this.name,
        userData: state.configuredUserDataPath,
      };
      state.singleInstanceSnapshots.push(snapshot);
      const acquired =
        typeof singleInstanceLock === 'function'
          ? singleInstanceLock(snapshot)
          : singleInstanceLock;
      state.singleInstanceLock = acquired;
      return acquired;
    },
    isPackaged: appIsPackaged,
    name: 'Nuncio',
    getVersion() {
      return appVersion;
    },
    setName(name) {
      state.appCalls.push('set-name');
      state.appName = name;
      this.name = name;
    },
    setPath(name, value) {
      state.appCalls.push(`set-path:${name}`);
      if (name === 'appData') state.configuredAppDataPath = value;
      if (name === 'userData') state.configuredUserDataPath = value;
    },
    getPath(name) {
      if (name === 'appData') return state.configuredAppDataPath;
      if (name === 'userData' && state.configuredUserDataPath) {
        return state.configuredUserDataPath;
      }
      throw new Error(`Unavailable app path: ${name}`);
    },
  };

  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.handlers = {};
      this.currentUrl = '';
      const webContentsHandlers = {};
      this.shown = true;
      this.focused = false;
      this.minimized = false;
      this.maximized = false;
      this.normalBounds = {
        x: options.x ?? 0,
        y: options.y ?? 0,
        width: options.width,
        height: options.height,
      };
      this.webContents = {
        handlers: webContentsHandlers,
        openDevTools: (options) => state.devToolsCalls.push(options),
        on(eventName, handler) {
          webContentsHandlers[eventName] = handler;
        },
        getURL: () => this.currentUrl,
        send(channel, payload) {
          state.windowSentEvents.push({ channel, payload });
        },
        focus() {
          state.focusCalls += 1;
        },
      };
      state.windows.push(this);
    }

    on(eventName, handler) {
      const listeners = this.handlers[eventName] ?? [];
      listeners.push(handler);
      this.handlers[eventName] = listeners;
    }

    removeListener(eventName, handler) {
      this.handlers[eventName] = (this.handlers[eventName] ?? []).filter(
        (listener) => listener !== handler,
      );
    }

    emit(eventName, ...args) {
      for (const handler of this.handlers[eventName] ?? []) handler(...args);
    }

    loadURL(url) {
      this.currentUrl = url;
      state.loadedUrls.push(url);
      return Promise.resolve();
    }

    show() {
      this.shown = true;
    }

    hide() {
      this.shown = false;
    }

            focus() {
              this.focused = true;
              state.focusCalls += 1;
            }

    isMinimized() {
      return this.minimized;
    }

    restore() {
      this.minimized = false;
    }

    maximize() {
      this.maximized = true;
      state.maximizeCalls += 1;
      this.emit('maximize');
    }

    isMaximized() {
      return this.maximized;
    }

    getNormalBounds() {
      return { ...this.normalBounds };
    }

    setBrowserView(view) {
      state.setBrowserViews.push(view);
    }

    removeBrowserView(view) {
      state.removedBrowserViews.push(view);
    }

    static getAllWindows() {
      return state.windows;
    }
  }

  class FakeBrowserView {
    constructor(options) {
      this.options = options;
      this.url = '';
      this.title = '';
      const webContentsHandlers = {};
      this.webContents = {
        handlers: webContentsHandlers,
        loadURL: (url) => {
          this.url = url;
          state.browserLoads.push(url);
          return Promise.resolve();
        },
        reload: () => {
          state.browserReloads += 1;
        },
        getURL: () => this.url,
        getTitle: () => this.title,
        isLoading: () => false,
        executeJavaScript: async (script) => {
          state.browserExecuteScripts.push(script);
          return true;
        },
        on(eventName, handler) {
          webContentsHandlers[eventName] = handler;
        },
        send(channel, payload) {
          state.browserSentEvents.push({ channel, payload });
        },
        focus() {
          state.focusCalls += 1;
        },
        capturePage: async () => ({
          toPNG: () => Buffer.from('fake-png'),
        }),
      };
      state.browserPartitions.push(options?.webPreferences?.partition);
      state.browserViews.push(this);
    }

    setBounds(bounds) {
      state.browserBounds.push(bounds);
    }

    setAutoResize(options) {
      this.autoResize = options;
    }
  }

  class FakeDaemonSupervisor {
    constructor(options = {}) {
      state.daemonConstructed += 1;
      state.daemonOptions.push(options);
      this.url = daemonUrl;
    }

    async start() {
      state.daemonStartCalls += 1;
      // Test seam: lets a spec observe/act at the exact moment the boot is
      // suspended on daemon start (before the first window is created).
      if (onDaemonStart) await onDaemonStart(state);
      return { url: this.url };
    }

    async stop() {
      state.daemonStopCalls += 1;
    }
  }

  const sandboxModule = { exports: {} };
  const sandbox = {
    __dirname: path.dirname(mainPath),
    AbortController,
    Buffer,
    clearTimeout,
    console: {
      log: (...args) => state.logs.push(args.join(' ')),
      error: (...args) => state.errors.push(args.join(' ')),
    },
    Date: SandboxDate,
    encodeURIComponent,
    fetch: fetchImpl || (() => Promise.reject(new Error('fetch should not be called'))),
    URL,
    module: sandboxModule,
    exports: sandboxModule.exports,
    process: {
      ...process,
      env: { ...process.env, ...env },
      resourcesPath,
      platform: process.platform,
    },
    require(specifier) {
      if (specifier === 'node:path') {
        return require('node:path');
      }
      if (specifier === 'node:url') {
        return require('node:url');
      }
      if (specifier === 'node:fs') {
        return require('node:fs');
      }
      if (specifier === 'node:os') {
        return require('node:os');
      }
      if (specifier === 'electron') {
        return {
          app: fakeApp,
          BrowserWindow: FakeBrowserWindow,
          BrowserView: FakeBrowserView,
          Tray: class FakeTray {
            constructor(image) {
              this.image = image;
              this.contextMenu = null;
              this.handlers = {};
              this.destroyed = false;
              state.trays.push(this);
            }
            setToolTip() {}
            setContextMenu(menu) {
              this.contextMenu = menu;
            }
            on(eventName, handler) {
              this.handlers[eventName] = handler;
            }
            destroy() {
              this.destroyed = true;
            }
          },
          nativeImage: {
            createFromPath() {
              return { isEmpty: () => true, setTemplateImage() {} };
            },
            createEmpty() {
              return { isEmpty: () => true, setTemplateImage() {} };
            },
          },
          screen: {
            getAllDisplays() {
              return displays;
            },
            getDisplayMatching(bounds) {
              const intersectionArea = (left, right) => {
                const width = Math.max(
                  0,
                  Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
                );
                const height = Math.max(
                  0,
                  Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
                );
                return width * height;
              };
              return displays.reduce((best, display) =>
                intersectionArea(bounds, display.workArea) > intersectionArea(bounds, best.workArea)
                  ? display
                  : best,
              displays[0]);
            },
          },
          Menu: {
            buildFromTemplate: (template) => ({ template }),
            setApplicationMenu() {},
          },
          dialog: {
            showErrorBox(title, message) {
              state.dialogErrors.push({ title, message });
            },
          },
          ipcMain: {
            handle(channel, handler) {
              state.ipcHandlers[channel] = handler;
            },
            on(channel, handler) {
              state.ipcListeners[channel] = handler;
            },
          },
          Notification: class {
            static isSupported() {
              return false;
            }
            on() {}
            show() {}
          },
          shell: {
            openExternal(url) {
              state.externalOpens.push(url);
              return Promise.resolve();
            },
          },
        };
      }
      if (specifier === 'node-pty' && nodePtyImpl) {
        return nodePtyImpl;
      }
      if (specifier === './browser-url') {
        return require(path.resolve(__dirname, '../src/browser-url.js'));
      }
      if (specifier === './design-mode') {
        return require(path.resolve(__dirname, '../src/design-mode.js'));
      }
      if (specifier === './ipc-origin') {
        return require(path.resolve(__dirname, '../src/ipc-origin.js'));
      }
      if (specifier === './pre-lock-app-paths') {
        return require(path.resolve(__dirname, '../src/pre-lock-app-paths.js'));
      }
      if (specifier === './daemon') {
        return { DaemonSupervisor: FakeDaemonSupervisor };
      }
      if (specifier === './server-profiles') {
        // Real module: pure + filesystem-defensive, safe inside the sandbox.
        return require(path.resolve(__dirname, '../src/server-profiles.js'));
      }
      if (specifier === './shell-settings') {
        // Real module: pure + filesystem-defensive, safe inside the sandbox.
        return require(path.resolve(__dirname, '../src/shell-settings.js'));
      }
      if (specifier === './window-state') {
        return require(path.resolve(__dirname, '../src/window-state.js'));
      }
      if (specifier === './desktop-chrome') {
        return require(path.resolve(__dirname, '../src/desktop-chrome.js'));
      }
      if (specifier === './updater') {
        return {
          initAutoUpdater() {},
          updaterMenuItem() {
            return { label: 'Check for Updates…', enabled: true };
          },
        };
      }
      throw new Error(`Unexpected require from main.js test: ${specifier}`);
    },
    setTimeout: sandboxSetTimeout,
    clearInterval,
  };

  vm.runInNewContext(mainSource, sandbox, { filename: mainPath });
  await readyPromise;
  state.trustedRendererUrl =
    state.daemonConstructed > 0
      ? daemonUrl
      : (state.loadedUrls.find((url) => /^https?:\/\//.test(url)) ?? null);
  return state;
}

describe('desktop main dev-mode loading', () => {
  test('restores saved normal bounds and maximized state on launch', async () => {
    const userDataPath = fs.mkdtempSync(path.join(__dirname, 'window-state-'));
    fs.writeFileSync(
      path.join(userDataPath, 'window-state.json'),
      JSON.stringify({
        bounds: { x: 144, y: 92, width: 1110, height: 740 },
        maximized: true,
      }),
    );

    try {
      const state = await runMain({
        userDataPath,
        fetchImpl: async () => ({ ok: false }),
      });

      expect(state.windows[0].options).toMatchObject({
        x: 144,
        y: 92,
        width: 1110,
        height: 740,
        minWidth: 960,
        minHeight: 640,
      });
      expect(state.maximizeCalls).toBe(1);
    } finally {
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  test('re-homes saved bounds when their previous display no longer exists', async () => {
    const userDataPath = fs.mkdtempSync(path.join(__dirname, 'window-state-display-'));
    fs.writeFileSync(
      path.join(userDataPath, 'window-state.json'),
      JSON.stringify({
        bounds: { x: 4000, y: 2000, width: 1100, height: 720 },
        maximized: false,
      }),
    );

    try {
      const state = await runMain({
        userDataPath,
        displays: [{ workArea: { x: 0, y: 23, width: 1440, height: 877 } }],
        fetchImpl: async () => ({ ok: false }),
      });

      expect(state.windows[0].options).toMatchObject({
        x: 340,
        y: 180,
        width: 1100,
        height: 720,
      });
    } finally {
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  test('NUNCIO_DESKTOP_DEV=1 waits for the Vite dev server without starting the daemon', async () => {
    let fetchCalls = 0;
    const state = await runMain({
      env: { NUNCIO_DESKTOP_DEV: '1' },
      advanceTimers: true,
      fetchImpl: async (url) => {
        fetchCalls += 1;
        expect(url).toBe('http://localhost:5173');
        return { ok: fetchCalls >= 3 };
      },
    });

    expect(fetchCalls).toBe(3);
    expect(state.daemonConstructed).toBe(0);
    expect(state.daemonStartCalls).toBe(0);
    expect(state.loadedUrls).toEqual(['http://localhost:5173']);
    expect(state.devToolsCalls).toEqual([{ mode: 'detach' }]);
    expect(state.logs.some((line) => line.includes('[desktop] dev mode'))).toBe(true);

    let preventDefaultCalled = false;
    state.appHandlers['before-quit']({
      preventDefault() {
        preventDefaultCalled = true;
      },
    });

    expect(preventDefaultCalled).toBe(false);
    expect(state.daemonStopCalls).toBe(0);
  });

  test('NUNCIO_DESKTOP_DEV=1 shows an error window instead of falling back when Vite never starts', async () => {
    const state = await runMain({
      env: { NUNCIO_DESKTOP_DEV: '1' },
      advanceTimers: true,
      fetchImpl: async () => ({ ok: false }),
    });

    expect(state.daemonConstructed).toBe(0);
    expect(state.daemonStartCalls).toBe(0);
    expect(state.devToolsCalls).toEqual([]);
    expect(state.loadedUrls).toHaveLength(1);
    expect(state.loadedUrls[0]).toStartWith('data:text/html;charset=utf-8,');
    expect(state.dialogErrors).toHaveLength(1);
    expect(state.dialogErrors[0].message).toContain('dev server');
  });

  test('an available Vite dev server is detected automatically and reused on activate', async () => {
    const state = await runMain({
      fetchImpl: async (url) => ({ ok: url === 'http://localhost:5173' }),
    });

    expect(state.daemonConstructed).toBe(0);
    expect(state.loadedUrls).toEqual(['http://localhost:5173']);

    state.windows.length = 0;
    state.appHandlers.activate();

    expect(state.loadedUrls).toEqual(['http://localhost:5173', 'http://localhost:5173']);
  });

  test('packaged Dev acquires the shared production lock before restoring channel identity', async () => {
    const appDataPath = path.join(__dirname, 'identity-app-data');
    const state = await runMain({
      appIsPackaged: true,
      appVersion: '0.2.0-dev.7',
      appDataPath,
    });

    expect(state.appName).toBe('Nuncio Dev');
    expect(state.configuredUserDataPath).toBe(path.join(appDataPath, 'Nuncio Dev'));
    expect(state.appCalls.slice(0, 5)).toEqual([
      'set-name',
      'set-path:userData',
      'request-lock',
      'set-name',
      'set-path:userData',
    ]);
    expect(state.singleInstanceSnapshots).toEqual([
      { name: 'Nuncio', userData: path.join(appDataPath, 'Nuncio') },
    ]);
  });

  test('packaged smoke sets explicit appData and userData before requesting its lock', async () => {
    const smokeRoot = path.join(__dirname, 'smoke-temp-root');
    const smokeDataDir = path.join(smokeRoot, 'home', '.nuncio', 'data');
    const smokeAppDataRoot = path.join(smokeDataDir, 'electron-app-data');
    const state = await runMain({
      appIsPackaged: true,
      env: {
        NUNCIO_DATA_DIR: smokeDataDir,
        NUNCIO_DESKTOP_SMOKE_TEMP_ROOT: smokeRoot,
        NUNCIO_DESKTOP_SMOKE_APP_DATA_ROOT: smokeAppDataRoot,
        NUNCIO_DESKTOP_SMOKE_NONCE: 'a'.repeat(64),
      },
    });

    expect(state.configuredAppDataPath).toBe(smokeAppDataRoot);
    expect(state.configuredUserDataPath).toBe(path.join(smokeAppDataRoot, 'Nuncio'));
    expect(state.appCalls.slice(0, 6)).toEqual([
      'set-path:appData',
      'set-name',
      'set-path:userData',
      'request-lock',
      'set-name',
      'set-path:userData',
    ]);
    expect(state.singleInstanceSnapshots).toEqual([
      { name: 'Nuncio', userData: path.join(smokeAppDataRoot, 'Nuncio') },
    ]);
  });

  test.each([
    ['empty appData root', 'empty-root', ''],
    ['relative appData root', 'relative-root', 'relative/app-data'],
    ['appData root equal to data dir', 'equal-root', null],
    ['appData root outside data dir', 'outside-root', '../outside/app-data'],
    ['common-prefix sibling appData root', 'prefix-sibling', '../../data-sibling/app-data'],
    ['missing temp-root evidence', 'missing-temp', null],
    ['relative temp-root evidence', 'relative-temp', null],
    ['missing data-dir evidence', 'missing-data', null],
    ['relative data-dir evidence', 'relative-data', null],
    ['data-dir outside temp root', 'outside-data', null],
    ['missing smoke nonce', 'missing-nonce', null],
  ])('rejects %s before lock acquisition', async (_label, scenario, configuredRoot) => {
    const smokeRoot = path.join(__dirname, 'invalid-smoke-root');
    const absoluteDataDir = path.join(smokeRoot, 'home', '.nuncio', 'data');
    let tempRoot = smokeRoot;
    let dataDir = absoluteDataDir;
    let appDataRoot = configuredRoot ?? path.join(absoluteDataDir, 'electron-app-data');
    let nonce = 'a'.repeat(64);

    if (scenario === 'equal-root') appDataRoot = absoluteDataDir;
    if (scenario === 'outside-root' || scenario === 'prefix-sibling') {
      appDataRoot = path.resolve(absoluteDataDir, configuredRoot);
    }
    if (scenario === 'missing-temp') tempRoot = '';
    if (scenario === 'relative-temp') tempRoot = 'relative/temp';
    if (scenario === 'missing-data') dataDir = '';
    if (scenario === 'relative-data') dataDir = 'relative/data';
    if (scenario === 'outside-data') {
      dataDir = path.join(path.dirname(smokeRoot), 'outside-data');
      appDataRoot = path.join(dataDir, 'electron-app-data');
    }
    if (scenario === 'missing-nonce') nonce = '';

    await expect(
      runMain({
        appIsPackaged: true,
        env: {
          NUNCIO_DATA_DIR: dataDir,
          NUNCIO_DESKTOP_SMOKE_TEMP_ROOT: tempRoot,
          NUNCIO_DESKTOP_SMOKE_APP_DATA_ROOT: appDataRoot,
          NUNCIO_DESKTOP_SMOKE_NONCE: nonce,
        },
      }),
    ).rejects.toThrow(/smoke app-data root/i);
  });

  test('same-home stable and Dev contend while an explicit smoke root remains independent', async () => {
    const heldNamespaces = new Set();
    const acquireNamespace = ({ name, userData }) => {
      const namespace = `${name}:${userData}`;
      if (heldNamespaces.has(namespace)) return false;
      heldNamespaces.add(namespace);
      return true;
    };
    const realAppData = path.join(__dirname, 'same-home-app-data');
    const smokeRoot = path.join(__dirname, 'isolated-smoke-root');
    const smokeDataDir = path.join(smokeRoot, 'home', '.nuncio', 'data');
    const smokeAppData = path.join(smokeDataDir, 'electron-app-data');

    const stable = await runMain({
      appIsPackaged: true,
      appVersion: '0.2.0',
      appDataPath: realAppData,
      singleInstanceLock: acquireNamespace,
    });
    const dev = await runMain({
      appIsPackaged: true,
      appVersion: '0.2.0-dev.7',
      appDataPath: realAppData,
      singleInstanceLock: acquireNamespace,
    });
    const smoke = await runMain({
      appIsPackaged: true,
      appVersion: '0.2.0',
      appDataPath: realAppData,
      env: {
        NUNCIO_DATA_DIR: smokeDataDir,
        NUNCIO_DESKTOP_SMOKE_TEMP_ROOT: smokeRoot,
        NUNCIO_DESKTOP_SMOKE_APP_DATA_ROOT: smokeAppData,
        NUNCIO_DESKTOP_SMOKE_NONCE: 'a'.repeat(64),
      },
      singleInstanceLock: acquireNamespace,
    });

    expect(stable.singleInstanceSnapshots).toEqual([
      { name: 'Nuncio', userData: path.join(realAppData, 'Nuncio') },
    ]);
    expect(stable.quitCalls).toBe(0);
    expect(stable.daemonStartCalls).toBe(1);
    expect(dev.singleInstanceSnapshots).toEqual(stable.singleInstanceSnapshots);
    expect(dev.quitCalls).toBe(1);
    expect(dev.daemonConstructed).toBe(0);
    expect(dev.daemonStartCalls).toBe(0);
    expect(smoke.singleInstanceSnapshots).toEqual([
      { name: 'Nuncio', userData: path.join(smokeAppData, 'Nuncio') },
    ]);
    expect(smoke.quitCalls).toBe(0);
    expect(smoke.daemonStartCalls).toBe(1);
  });

  test('packaged launch marks the daemon env and strips forced mock', async () => {
    const resourcesPath = path.join(__dirname, 'packaged-resources');
    const state = await runMain({
      appIsPackaged: true,
      resourcesPath,
      env: {
        NUNCIO_FORCE_MOCK: '1',
        NUNCIO_PACKAGED: '0',
      },
    });

    expect(state.daemonConstructed).toBe(1);
    expect(state.daemonStartCalls).toBe(1);
    expect(state.loadedUrls).toEqual(['http://daemon.test:3000']);
    expect(state.daemonOptions).toHaveLength(1);
    expect(state.daemonOptions[0].serverBinaryPath).toBeUndefined();
    expect(state.daemonOptions[0].bunPath).toBe(path.join(resourcesPath, 'bun'));
    expect(state.daemonOptions[0].entryPath).toBe(path.join(resourcesPath, 'server', 'server.js'));
    expect(state.daemonOptions[0].cwd).toBe(path.join(resourcesPath, 'server'));
    expect(state.daemonOptions[0].env.NUNCIO_PACKAGED).toBe('1');
    expect(state.daemonOptions[0].env.NUNCIO_FORCE_MOCK).toBeUndefined();
    expect(state.daemonOptions[0].env.NUNCIO_WEB_DIST).toBe(path.join(resourcesPath, 'web', 'dist'));
  });

  test('desktop browser IPC embeds a BrowserView with a persistent Nuncio profile', async () => {
    const state = await runMain({
      fetchImpl: async (url) => ({ ok: url === 'http://localhost:5173' }),
    });

    await state.ipcHandlers['browser:show'](state.trustedIpcEvent(), {
      id: 's1',
      url: 'example.com',
      bounds: { x: 10, y: 52, width: 480, height: 320 },
    });

    expect(state.browserViews).toHaveLength(1);
    expect(state.browserPartitions).toEqual(['persist:nuncio-browser']);
    expect(state.browserLoads).toEqual(['https://example.com']);
    expect(state.browserBounds).toEqual([{ x: 10, y: 52, width: 480, height: 320 }]);
    expect(state.setBrowserViews).toEqual([state.browserViews[0]]);
    expect(state.browserViews[0].options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:nuncio-browser',
    });
  });

  test('desktop browser navigates localhost:port over http (not as a fake scheme)', async () => {
    const state = await runMain({
      fetchImpl: async (url) => ({ ok: url === 'http://localhost:5173' }),
    });

    await state.ipcHandlers['browser:show'](state.trustedIpcEvent(), {
      id: 's1',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    });
    await state.ipcHandlers['browser:navigate'](state.trustedIpcEvent(), 's1', 'localhost:5173');

    expect(state.browserLoads).toEqual(['http://localhost:5173']);
  });

  test('desktop browser hide detaches the native view without destroying the profile', async () => {
    const state = await runMain({
      fetchImpl: async (url) => ({ ok: url === 'http://localhost:5173' }),
    });

    await state.ipcHandlers['browser:show'](state.trustedIpcEvent(), {
      id: 's1',
      url: 'https://example.com',
      bounds: { x: 0, y: 0, width: 300, height: 200 },
    });
    await state.ipcHandlers['browser:hide'](state.trustedIpcEvent(), 's1');
    await state.ipcHandlers['browser:show'](state.trustedIpcEvent(), {
      id: 's1',
      bounds: { x: 0, y: 20, width: 300, height: 180 },
    });

    expect(state.browserViews).toHaveLength(1);
    expect(state.removedBrowserViews).toEqual([state.browserViews[0]]);
    expect(state.setBrowserViews).toEqual([state.browserViews[0], state.browserViews[0]]);
  });

  test('design mode enter injects the picker and guest picks forward to the renderer', async () => {
    const state = await runMain({
      fetchImpl: async (url) => ({ ok: url === 'http://localhost:5173' }),
    });

    await state.ipcHandlers['browser:show'](state.trustedIpcEvent(), {
      id: 's1',
      url: 'https://example.com',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    });

    await state.ipcHandlers['browser:design-mode-enter'](state.trustedIpcEvent(), 's1');
    expect(
      state.browserExecuteScripts.some((script) => script.includes('__nuncio-design-mode-highlight')),
    ).toBe(true);
    expect(state.browserViews[0].options.webPreferences.preload).toContain('browser-view-preload.js');

    const guestPick = state.ipcListeners['browser:design-mode-guest-pick'];
    expect(typeof guestPick).toBe('function');

    await guestPick(
      { sender: state.browserViews[0].webContents },
      {
        tag: 'INPUT',
        placeholder: 'Search',
        className: 'RNNXgb',
        xpath: '/html/body/input[1]',
        cssPath: 'input',
        outerHTML: '<input placeholder="Search" />',
        styles: { fontSize: '14px' },
        bbox: { x: 8, y: 12, width: 64, height: 28 },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.focusCalls).toBeGreaterThan(0);
    expect(state.windowSentEvents.some((e) => e.channel === 'browser:design-mode-pick')).toBe(true);
    const pickEvent = state.windowSentEvents.find((e) => e.channel === 'browser:design-mode-pick');
    expect(pickEvent.payload.id).toBe('s1');
    expect(pickEvent.payload.pick.label).toBe('Search');
    expect(pickEvent.payload.pick.cropPngBase64).toBe(Buffer.from('fake-png').toString('base64'));

    await state.ipcHandlers['browser:design-mode-leave'](state.trustedIpcEvent(), 's1');
  });

  test('external:open delegates http links to the system browser only', async () => {
    const state = await runMain({
      fetchImpl: async (url) => ({ ok: url === 'http://localhost:5173' }),
    });

    await expect(state.ipcHandlers['external:open'](state.trustedIpcEvent(), 'https://example.com/docs')).resolves.toEqual({
      ok: true,
      url: 'https://example.com/docs',
    });
    await expect(state.ipcHandlers['external:open'](state.trustedIpcEvent(), 'javascript:alert(1)')).rejects.toThrow(
      /http or https/i,
    );
    expect(state.externalOpens).toEqual(['https://example.com/docs']);
  });

  test('untrusted remote renderers cannot invoke local privileged IPC or perform local operations', async () => {
    const nodePty = fakeNodePty();
    const state = await runMain({
      fetchImpl: async (url) => ({ ok: url === 'http://localhost:5173' }),
      nodePtyImpl: nodePty.implementation,
    });
    const remote = state.trustedIpcEvent('https://attacker.example/session/1');
    const calls = [
      ['nuncio:notify', [{ title: 'x', body: 'y' }]],
      ['external:open', ['https://example.com']],
      ['browser:show', [{ id: 'remote', bounds: { x: 0, y: 0, width: 10, height: 10 } }]],
      ['terminal:create', [{ id: 'remote', cwd: '/' }]],
      ['servers:list', []],
      ['shell:set-settings', [{ closeToTray: false }]],
    ];
    const errors = [];

    for (const [channel, args] of calls) {
      try {
        await state.ipcHandlers[channel](remote, ...args);
      } catch (error) {
        errors.push(error);
      }
    }

    expect(errors).toHaveLength(calls.length);
    expect(errors.every((error) => /trusted local renderer/i.test(String(error)))).toBe(true);
    expect(state.externalOpens).toEqual([]);
    expect(state.browserViews).toHaveLength(0);
    expect(nodePty.ptys).toHaveLength(0);
    expect(state.ipcHandlers['shell:get-settings'](state.trustedIpcEvent())).toEqual({
      closeToTray: true,
    });
  });

  test('a loopback server profile cannot invoke terminal or sensitive shell IPC', async () => {
    const nodePty = fakeNodePty();
    const daemonUrl = 'http://127.0.0.1:43127/';
    const state = await runMain({
      daemonUrl,
      fetchImpl: async () => ({ ok: false }),
      nodePtyImpl: nodePty.implementation,
    });
    const local = state.trustedIpcEvent(`${daemonUrl}sessions/1`);

    await expect(
      state.ipcHandlers['servers:connect'](local, 'http://127.0.0.1:4444'),
    ).resolves.toEqual({ ok: true, target: 'http://127.0.0.1:4444' });

    const profilePage = state.trustedIpcEvent('http://127.0.0.1:4444/session/remote');
    const attempts = [
      ['terminal:create', [{ id: 'profile-pty', cwd: '/' }]],
      ['shell:set-settings', [{ closeToTray: false }]],
      ['servers:list', []],
    ];
    const errors = [];
    for (const [channel, args] of attempts) {
      try {
        await state.ipcHandlers[channel](profilePage, ...args);
      } catch (error) {
        errors.push(error);
      }
    }

    expect(errors).toHaveLength(attempts.length);
    expect(errors.every((error) => /trusted local renderer/i.test(String(error)))).toBe(true);
    expect(nodePty.ptys).toHaveLength(0);
    expect(state.ipcHandlers['shell:get-settings'](local)).toEqual({ closeToTray: true });
  });

  test('privileged IPC follows the dynamically selected daemon origin exactly', async () => {
    const nodePty = fakeNodePty();
    const daemonUrl = 'http://127.0.0.1:43127/';
    const state = await runMain({
      daemonUrl,
      fetchImpl: async () => ({ ok: false }),
      nodePtyImpl: nodePty.implementation,
    });

    expect(
      state.ipcHandlers['terminal:create'](
        state.trustedIpcEvent('http://127.0.0.1:43127/session/1'),
        { id: 'dynamic-port', cwd: '/' },
      ),
    ).toEqual({ id: 'dynamic-port' });
    expect(() =>
      state.ipcHandlers['terminal:create'](
        state.trustedIpcEvent('http://127.0.0.1:3000/session/1'),
        { id: 'wrong-port', cwd: '/' },
      ),
    ).toThrow(/trusted local renderer/i);

    expect(nodePty.ptys).toHaveLength(1);
  });

  test('a configured active dev URL is trusted without granting the default dev port', async () => {
    const devUrl = 'http://127.0.0.1:61234/worktree';
    const state = await runMain({
      env: {
        NUNCIO_DESKTOP_DEV: '1',
        NUNCIO_DESKTOP_DEV_URL: devUrl,
      },
      fetchImpl: async (url) => ({ ok: url === devUrl }),
    });

    expect(
      state.ipcHandlers['shell:get-settings'](
        state.trustedIpcEvent('http://127.0.0.1:61234/settings'),
      ),
    ).toEqual({ closeToTray: true });
    expect(() =>
      state.ipcHandlers['shell:get-settings'](
        state.trustedIpcEvent('http://localhost:5173/settings'),
      ),
    ).toThrow(/trusted local renderer/i);
  });

  test('only the approved packaged app file can invoke privileged IPC', async () => {
    const resourcesPath = path.join(__dirname, 'packaged-origin-resources');
    const state = await runMain({
      appIsPackaged: true,
      resourcesPath,
      fetchImpl: async () => ({ ok: false }),
    });
    const appFile = pathToFileURL(path.join(resourcesPath, 'web', 'dist', 'index.html')).toString();

    expect(
      state.ipcHandlers['shell:get-settings'](
        state.trustedIpcEvent(`${appFile}?section=mobile#settings`),
      ),
    ).toEqual({ closeToTray: true });
    expect(() =>
      state.ipcHandlers['shell:get-settings'](
        state.trustedIpcEvent(
          pathToFileURL(path.join(resourcesPath, 'web', 'dist', 'other.html')).toString(),
        ),
      ),
    ).toThrow(/trusted local renderer/i);
  });

  test('an arbitrary BrowserView page cannot invoke the main window terminal IPC', async () => {
    const nodePty = fakeNodePty();
    const state = await runMain({
      fetchImpl: async (url) => ({ ok: url === 'http://localhost:5173' }),
      nodePtyImpl: nodePty.implementation,
    });
    const local = state.trustedIpcEvent('http://localhost:5173/session/1');

    await state.ipcHandlers['browser:show'](local, {
      id: 'guest',
      url: 'http://localhost:5173/embedded',
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    });
    const guest = {
      senderFrame: { url: state.browserViews[0].webContents.getURL() },
      sender: state.browserViews[0].webContents,
    };

    expect(() =>
      state.ipcHandlers['terminal:create'](guest, { id: 'guest-pty', cwd: '/' }),
    ).toThrow(/trusted local renderer/i);
    expect(nodePty.ptys).toHaveLength(0);
    expect(state.browserLoads).toEqual(['http://localhost:5173/embedded']);
  });

  test('a local server outage parks the window on a wait page and reloads once the server returns', async () => {
    const waitFor = async (predicate, timeoutMs = 2000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return predicate();
    };

    let serverUp = true;
    const state = await runMain({
      env: { NUNCIO_DESKTOP_DEV: '1' },
      advanceTimers: true,
      fetchImpl: async () => ({ ok: serverUp }),
    });
    expect(state.loadedUrls).toEqual(['http://localhost:5173']);

    const failLoad = state.windows[0].webContents.handlers['did-fail-load'];
    expect(typeof failLoad).toBe('function');

    // Sub-frame failures and aborted in-app navigations must not trigger the wait page.
    failLoad(null, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:5173', false);
    failLoad(null, -3, 'ERR_ABORTED', 'http://localhost:5173', true);
    expect(state.loadedUrls).toHaveLength(1);

    // Vite goes down and a reload fails: the shell shows the wait page.
    serverUp = false;
    failLoad(null, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:5173', true);
    expect(await waitFor(() => state.loadedUrls.length === 2)).toBe(true);
    expect(state.loadedUrls[1]).toStartWith('data:text/html');
    expect(decodeURIComponent(state.loadedUrls[1])).toContain('reconnects automatically');

    // The server comes back: the shell reloads the app on its own.
    serverUp = true;
    expect(await waitFor(() => state.loadedUrls.length >= 3)).toBe(true);
    expect(state.loadedUrls[2]).toBe('http://localhost:5173');
  });

  test('servers:connect switches the shell to a remote server, lists it, and returns to local', async () => {
    // Dev probe fails → daemon mode, boots on the local daemon URL.
    const state = await runMain({ fetchImpl: async () => ({ ok: false }) });
    expect(state.loadedUrls).toEqual(['http://daemon.test:3000']);

    const connect = state.ipcHandlers['servers:connect'];
    const list = state.ipcHandlers['servers:list'];
    expect(typeof connect).toBe('function');
    expect(typeof list).toBe('function');

    const result = await connect(state.trustedIpcEvent(), 'oscars-macbook-pro.tail1.ts.net:3000');
    expect(result).toEqual({ ok: true, target: 'http://oscars-macbook-pro.tail1.ts.net:3000' });
    expect(state.loadedUrls).toEqual([
      'http://daemon.test:3000',
      'http://oscars-macbook-pro.tail1.ts.net:3000',
    ]);

    const listed = list(state.trustedIpcEvent());
    expect(listed.current).toBe('http://oscars-macbook-pro.tail1.ts.net:3000');
    expect(listed.localUrl).toBe('http://daemon.test:3000');
    expect(listed.servers).toEqual([
      { name: 'oscars-macbook-pro', url: 'http://oscars-macbook-pro.tail1.ts.net:3000' },
    ]);

    const back = await connect(state.trustedIpcEvent(), 'local');
    expect(back).toEqual({ ok: true, target: 'local' });
    expect(state.loadedUrls[2]).toBe('http://daemon.test:3000');
    expect(list(state.trustedIpcEvent()).current).toBe('local');

    const invalid = await connect(state.trustedIpcEvent(), 'ftp://nope');
    expect(invalid.ok).toBe(false);
  });
});

describe('desktop PTY identity and shutdown fencing', () => {
  test('late output and exit from a replaced PTY cannot affect its replacement', async () => {
    const nodePty = fakeNodePty();
    const state = await runMain({
      fetchImpl: async (url) => ({ ok: url === 'http://localhost:5173' }),
      nodePtyImpl: nodePty.implementation,
    });
    const event = state.trustedIpcEvent();

    await state.ipcHandlers['terminal:create'](event, { id: 'same-id', cwd: '/' });
    const first = nodePty.ptys[0];
    await state.ipcHandlers['terminal:create'](event, { id: 'same-id', cwd: '/' });
    const replacement = nodePty.ptys[1];

    expect(first.killCalls).toBe(1);
    first.handlers.data('late old output');
    first.handlers.exit({ exitCode: 9 });
    await state.ipcHandlers['terminal:write'](event, 'same-id', 'still-live');
    await state.ipcHandlers['terminal:resize'](event, 'same-id', 120, 40);

    expect(replacement.writes).toEqual(['still-live']);
    expect(replacement.resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(state.windowSentEvents.filter((item) => item.channel === 'terminal:data')).toEqual([]);
    expect(state.windowSentEvents.filter((item) => item.channel === 'terminal:exit')).toEqual([]);

    replacement.handlers.data('replacement output');
    replacement.handlers.exit({ exitCode: 0 });
    expect(state.windowSentEvents).toContainEqual({
      channel: 'terminal:data',
      payload: { id: 'same-id', data: 'replacement output' },
    });
    expect(state.windowSentEvents).toContainEqual({
      channel: 'terminal:exit',
      payload: { id: 'same-id', code: 0 },
    });
  });

  test('window close followed by app shutdown kills each PTY at most once', async () => {
    const nodePty = fakeNodePty();
    const state = await runMain({
      fetchImpl: async (url) => ({ ok: url === 'http://localhost:5173' }),
      nodePtyImpl: nodePty.implementation,
    });
    await state.ipcHandlers['terminal:create'](state.trustedIpcEvent(), { id: 'pty-1' });

    state.windows[0].emit('closed');
    state.appHandlers['before-quit']({ preventDefault() {} });
    state.appHandlers['before-quit']({ preventDefault() {} });

    expect(nodePty.ptys[0].killCalls).toBe(1);
  });
});

describe('desktop tray + close-to-tray + single instance', () => {
  test('a losing second instance quits before ready and never starts a daemon', async () => {
    const state = await runMain({
      singleInstanceLock: false,
      fetchImpl: async () => ({ ok: false }),
    });

    // Loser quits immediately; whenReady boot must not run.
    expect(state.quitCalls).toBe(1);
    expect(state.daemonConstructed).toBe(0);
    expect(state.daemonStartCalls).toBe(0);
    expect(state.windows).toHaveLength(0);
  });

  test('second-instance surfaces the existing window instead of opening another', async () => {
    const state = await runMain({ fetchImpl: async () => ({ ok: false }) });
    const window = state.windows[0];
    window.shown = false;
    window.minimized = true;

    state.appHandlers['second-instance']();

    expect(window.shown).toBe(true);
    expect(window.focused).toBe(true);
    expect(window.minimized).toBe(false);
    // No second window was created.
    expect(state.windows).toHaveLength(1);
  });

  test('closing the window with close-to-tray on hides it and keeps the daemon', async () => {
    const state = await runMain({ fetchImpl: async () => ({ ok: false }) });
    const window = state.windows[0];
    // A tray exists because close-to-tray defaults on.
    expect(state.trays).toHaveLength(1);

    let prevented = false;
    window.emit('close', {
      preventDefault() {
        prevented = true;
      },
    });

    expect(prevented).toBe(true);
    expect(window.shown).toBe(false);
    // Daemon was never stopped by a mere window close.
    expect(state.daemonStopCalls).toBe(0);
  });

  test('closing to the tray flushes the latest normal window bounds first', async () => {
    const userDataPath = fs.mkdtempSync(path.join(__dirname, 'window-state-close-'));
    try {
      const state = await runMain({
        userDataPath,
        fetchImpl: async () => ({ ok: false }),
      });
      const window = state.windows[0];
      window.normalBounds = { x: 210, y: 130, width: 1160, height: 780 };
      window.emit('move');

      let prevented = false;
      window.emit('close', {
        preventDefault() {
          prevented = true;
        },
      });

      expect(prevented).toBe(true);
      expect(window.shown).toBe(false);
      const stateFile = path.join(userDataPath, 'window-state.json');
      expect(fs.existsSync(stateFile)).toBe(true);
      expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toEqual({
        bounds: { x: 210, y: 130, width: 1160, height: 780 },
        maximized: false,
      });
    } finally {
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  test('window-all-closed does not quit while close-to-tray is on', async () => {
    const state = await runMain({ fetchImpl: async () => ({ ok: false }) });
    const before = state.quitCalls;
    state.appHandlers['window-all-closed']();
    expect(state.quitCalls).toBe(before);
  });

  test('tray menu: Open reopens/focuses the window; Pair deep-links to mobile', async () => {
    const state = await runMain({ fetchImpl: async () => ({ ok: false }) });
    const tray = state.trays[0];
    const items = tray.contextMenu.template;
    const byLabel = (label) => items.find((item) => item.label === label);

    // Menu shape: Open, Pair, separator, Quit.
    expect(items.map((i) => i.label ?? `<${i.type}>`)).toEqual([
      'Open Nuncio',
      'Pair mobile device…',
      '<separator>',
      'Quit Nuncio',
    ]);

    const window = state.windows[0];
    window.shown = false;
    byLabel('Open Nuncio').click();
    expect(window.shown).toBe(true);
    expect(window.focused).toBe(true);

    byLabel('Pair mobile device…').click();
    // Deep-links the settings route straight to the Mobile pane.
    const lastLoad = state.loadedUrls[state.loadedUrls.length - 1];
    expect(lastLoad).toContain('/settings');
    expect(lastLoad).toContain('section=mobile');

    let quitBefore = state.quitCalls;
    byLabel('Quit Nuncio').click();
    expect(state.quitCalls).toBe(quitBefore + 1);
  });

  test('shell IPC reports and updates close-to-tray, toggling the tray', async () => {
    const state = await runMain({ fetchImpl: async () => ({ ok: false }) });
    const get = state.ipcHandlers['shell:get-settings'];
    const set = state.ipcHandlers['shell:set-settings'];
    expect(typeof get).toBe('function');
    expect(typeof set).toBe('function');

    // Defaults on, tray present.
    expect(get(state.trustedIpcEvent())).toEqual({ closeToTray: true });
    expect(state.trays.filter((t) => !t.destroyed)).toHaveLength(1);

    // Turn it off: tray goes away, and a subsequent window close is not intercepted.
    expect(await set(state.trustedIpcEvent(), { closeToTray: false })).toEqual({ closeToTray: false });
    expect(get(state.trustedIpcEvent())).toEqual({ closeToTray: false });
    expect(state.trays.every((t) => t.destroyed)).toBe(true);

    const window = state.windows[0];
    let prevented = false;
    window.emit('close', {
      preventDefault() {
        prevented = true;
      },
    });
    expect(prevented).toBe(false);

    // Turn it back on: a fresh tray is created.
    expect(await set(state.trustedIpcEvent(), { closeToTray: true })).toEqual({ closeToTray: true });
    expect(state.trays.filter((t) => !t.destroyed)).toHaveLength(1);

    // A malformed payload keeps the current value.
    expect(await set(state.trustedIpcEvent(), null)).toEqual({ closeToTray: true });
    expect(await set(state.trustedIpcEvent(), { closeToTray: 'nope' })).toEqual({ closeToTray: true });
  });

  test('an update-driven quit is not swallowed by close-to-tray', async () => {
    // quitAndInstall emits the window 'close' before 'before-quit', and fires
    // 'before-quit-for-update' first. That must mark the quit so the close is
    // NOT intercepted to the tray — otherwise the install is lost.
    const state = await runMain({ fetchImpl: async () => ({ ok: false }) });
    const window = state.windows[0];

    // Update install begins: Electron fires this ahead of the window close.
    state.appHandlers['before-quit-for-update']();

    let prevented = false;
    window.emit('close', {
      preventDefault() {
        prevented = true;
      },
    });

    // The window is allowed to close (not hidden), so the install proceeds.
    expect(prevented).toBe(false);
    expect(window.shown).toBe(true);
  });

  test('before-quit flushes pending bounds before asynchronous daemon shutdown', async () => {
    const userDataPath = fs.mkdtempSync(path.join(__dirname, 'window-state-quit-'));
    try {
      const state = await runMain({
        userDataPath,
        fetchImpl: async () => ({ ok: false }),
      });
      state.windows[0].normalBounds = { x: 260, y: 170, width: 1210, height: 810 };
      state.windows[0].emit('resize');

      let prevented = false;
      state.appHandlers['before-quit']({
        preventDefault() {
          prevented = true;
        },
      });

      expect(prevented).toBe(true);
      expect(JSON.parse(fs.readFileSync(
        path.join(userDataPath, 'window-state.json'),
        'utf8',
      ))).toEqual({
        bounds: { x: 260, y: 170, width: 1210, height: 810 },
        maximized: false,
      });
    } finally {
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  test('second-instance during boot focuses the single real window without racing a second', async () => {
    let sawWindowsMidBoot = -1;
    const state = await runMain({
      fetchImpl: async () => ({ ok: false }),
      // Fire the double-launch while the boot is suspended on daemon start,
      // before the first window has been created.
      onDaemonStart: (s) => {
        s.appHandlers['second-instance']();
        sawWindowsMidBoot = s.windows.length;
      },
    });

    // No premature window was created by the mid-boot second-instance.
    expect(sawWindowsMidBoot).toBe(0);
    // Boot created exactly one window, and the deferred focus was honored.
    expect(state.windows).toHaveLength(1);
    expect(state.windows[0].shown).toBe(true);
    expect(state.windows[0].focused).toBe(true);
  });
});
