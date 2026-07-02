const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mainPath = path.resolve(__dirname, '../src/main.js');
const mainSource = fs.readFileSync(mainPath, 'utf8');

async function runMain({ env = {}, fetchImpl, advanceTimers = false } = {}) {
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
    quitCalls: 0,
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
  };

  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.handlers = {};
      this.webContents = {
        openDevTools: (options) => state.devToolsCalls.push(options),
      };
      state.windows.push(this);
    }

    on(eventName, handler) {
      this.handlers[eventName] = handler;
    }

    loadURL(url) {
      state.loadedUrls.push(url);
      return Promise.resolve();
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
        };
      }
      if (specifier === './daemon') {
        return { DaemonSupervisor: FakeDaemonSupervisor };
      }
      if (specifier === './server-profiles') {
        // Real module: pure + filesystem-defensive, safe inside the sandbox.
        return require(path.resolve(__dirname, '../src/server-profiles.js'));
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
