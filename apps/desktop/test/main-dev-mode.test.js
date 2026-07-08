const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mainPath = path.resolve(__dirname, '../src/main.js');
const mainSource = fs.readFileSync(mainPath, 'utf8');

async function runMain({
  env = {},
  fetchImpl,
  advanceTimers = false,
  singleInstanceLock = true,
  onDaemonStart,
} = {}) {
  const state = {
    appHandlers: {},
    daemonConstructed: 0,
    daemonStartCalls: 0,
    daemonStopCalls: 0,
    devToolsCalls: [],
    dialogErrors: [],
    browserBounds: [],
    browserLoads: [],
    browserPartitions: [],
    browserReloads: 0,
    browserViews: [],
    ipcHandlers: {},
    loadedUrls: [],
    removedBrowserViews: [],
    setBrowserViews: [],
    windows: [],
    logs: [],
    errors: [],
    externalOpens: [],
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
      return state.singleInstanceLock;
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
      this.webContents = {
        handlers: webContentsHandlers,
        openDevTools: (options) => state.devToolsCalls.push(options),
        on(eventName, handler) {
          webContentsHandlers[eventName] = handler;
        },
        getURL: () => this.currentUrl,
      };
      state.windows.push(this);
    }

    on(eventName, handler) {
      this.handlers[eventName] = handler;
    }

    emit(eventName, ...args) {
      this.handlers[eventName]?.(...args);
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
    }

    isMinimized() {
      return this.minimized;
    }

    restore() {
      this.minimized = false;
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
      this.webContents = {
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
    constructor() {
      state.daemonConstructed += 1;
      this.url = 'http://daemon.test:3000';
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
      platform: process.platform,
    },
    require(specifier) {
      if (specifier === 'node:path') {
        return require('node:path');
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
      throw new Error(`Unexpected require from main.js test: ${specifier}`);
    },
    setTimeout: sandboxSetTimeout,
    clearInterval,
  };

  vm.runInNewContext(mainSource, sandbox, { filename: mainPath });
  await readyPromise;
  return state;
}

describe('desktop main dev-mode loading', () => {
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

  test('desktop browser IPC embeds a BrowserView with a persistent Nuncio profile', async () => {
    const state = await runMain({
      fetchImpl: async (url) => ({ ok: url === 'http://localhost:5173' }),
    });

    await state.ipcHandlers['browser:show']({}, {
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

  test('desktop browser hide detaches the native view without destroying the profile', async () => {
    const state = await runMain({
      fetchImpl: async (url) => ({ ok: url === 'http://localhost:5173' }),
    });

    await state.ipcHandlers['browser:show']({}, {
      id: 's1',
      url: 'https://example.com',
      bounds: { x: 0, y: 0, width: 300, height: 200 },
    });
    await state.ipcHandlers['browser:hide']({}, 's1');
    await state.ipcHandlers['browser:show']({}, {
      id: 's1',
      bounds: { x: 0, y: 20, width: 300, height: 180 },
    });

    expect(state.browserViews).toHaveLength(1);
    expect(state.removedBrowserViews).toEqual([state.browserViews[0]]);
    expect(state.setBrowserViews).toEqual([state.browserViews[0], state.browserViews[0]]);
  });

  test('external:open delegates http links to the system browser only', async () => {
    const state = await runMain({
      fetchImpl: async (url) => ({ ok: url === 'http://localhost:5173' }),
    });

    await expect(state.ipcHandlers['external:open']({}, 'https://example.com/docs')).resolves.toEqual({
      ok: true,
      url: 'https://example.com/docs',
    });
    await expect(state.ipcHandlers['external:open']({}, 'javascript:alert(1)')).rejects.toThrow(
      /http or https/i,
    );
    expect(state.externalOpens).toEqual(['https://example.com/docs']);
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

    const result = await connect({}, 'oscars-macbook-pro.tail1.ts.net:3000');
    expect(result).toEqual({ ok: true, target: 'http://oscars-macbook-pro.tail1.ts.net:3000' });
    expect(state.loadedUrls).toEqual([
      'http://daemon.test:3000',
      'http://oscars-macbook-pro.tail1.ts.net:3000',
    ]);

    const listed = list({});
    expect(listed.current).toBe('http://oscars-macbook-pro.tail1.ts.net:3000');
    expect(listed.localUrl).toBe('http://daemon.test:3000');
    expect(listed.servers).toEqual([
      { name: 'oscars-macbook-pro', url: 'http://oscars-macbook-pro.tail1.ts.net:3000' },
    ]);

    const back = await connect({}, 'local');
    expect(back).toEqual({ ok: true, target: 'local' });
    expect(state.loadedUrls[2]).toBe('http://daemon.test:3000');
    expect(list({}).current).toBe('local');

    const invalid = await connect({}, 'ftp://nope');
    expect(invalid.ok).toBe(false);
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

  test('window-all-closed does not quit while close-to-tray is on', async () => {
    const state = await runMain({ fetchImpl: async () => ({ ok: false }) });
    const before = state.quitCalls;
    state.appHandlers['window-all-closed']();
    expect(state.quitCalls).toBe(before);
  });

  test('tray menu: Open reopens/focuses the window; Pair deep-links to remote-access', async () => {
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
    // Deep-links the settings route straight to the remote-access pane.
    const lastLoad = state.loadedUrls[state.loadedUrls.length - 1];
    expect(lastLoad).toContain('/settings');
    expect(lastLoad).toContain('section=remote-access');

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
    expect(get()).toEqual({ closeToTray: true });
    expect(state.trays.filter((t) => !t.destroyed)).toHaveLength(1);

    // Turn it off: tray goes away, and a subsequent window close is not intercepted.
    expect(await set({}, { closeToTray: false })).toEqual({ closeToTray: false });
    expect(get()).toEqual({ closeToTray: false });
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
    expect(await set({}, { closeToTray: true })).toEqual({ closeToTray: true });
    expect(state.trays.filter((t) => !t.destroyed)).toHaveLength(1);

    // A malformed payload keeps the current value.
    expect(await set({}, null)).toEqual({ closeToTray: true });
    expect(await set({}, { closeToTray: 'nope' })).toEqual({ closeToTray: true });
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
