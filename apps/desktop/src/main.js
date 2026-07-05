const path = require('node:path');
const { app, BrowserWindow, BrowserView, dialog, ipcMain, Menu, Notification } = require('electron');
const { DaemonSupervisor } = require('./daemon');
const serverProfiles = require('./server-profiles');

// Dev and stable ship as distinct apps and must not share userData (SQLite data
// dir, server profiles) — name them apart before anything reads
// app.getPath('userData'). Channel is taken from the build's app-update.yml.
function detectChannel() {
  try {
    const manifest = require('node:fs').readFileSync(
      path.join(process.resourcesPath, 'app-update.yml'),
      'utf8',
    );
    if (/^channel:\s*dev\b/m.test(manifest)) return 'dev';
  } catch {
    // Not packaged or no manifest — fall through to the version heuristic.
  }
  return app.getVersion().includes('-dev') ? 'dev' : 'stable';
}

if (app.isPackaged) {
  app.setName(detectChannel() === 'dev' ? 'Nuncio Dev' : 'Nuncio');
}

const DEV_SERVER_URL = process.env.NUNCIO_DESKTOP_DEV_URL || 'http://localhost:5173';
const DEV_SERVER_PROBE_TIMEOUT_MS = 600;
const DEV_SERVER_RETRY_INTERVAL_MS = 300;
const FORCED_DEV_SERVER_TIMEOUT_MS = 30_000;
const EMBEDDED_BROWSER_PARTITION = 'persist:nuncio-browser';

let mainWindow = null;
let supervisor = null;
let quittingAfterDaemonStop = false;
const terminalPtys = new Map();
const embeddedBrowserViews = new Map();
let activeEmbeddedBrowserId = null;

// Server-connection state: the shell can load the local daemon or a saved
// remote nuncio server. 'local' is always available as the fallback target.
let serverProfilesState = { lastUsed: 'local', servers: [] };
let serverProfilesPath = null;
let currentServerTarget = 'local';
let localServerUrl = null;

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.on('closed', () => {
    destroyAllEmbeddedBrowsers();
    killAllTerminalPtys();
    mainWindow = null;
  });

  // Escape hatch: a remote server that stops responding would leave the shell
  // on an unloadable page (the UI itself comes from that server), so fall back
  // to the local daemon. errorCode -3 (ERR_ABORTED) fires on normal in-app
  // navigations and must be ignored.
  mainWindow.webContents.on?.('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    if (currentServerTarget !== 'local' && localServerUrl) {
      console.error(
        `[desktop] failed to load ${validatedURL || currentServerTarget} (${errorDescription}); falling back to the local daemon`,
      );
      connectToServer('local').catch((error) => console.error(error));
    }
  });

  return mainWindow.loadURL(url);
}

function resolveServerProfilesPath() {
  try {
    if (typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'servers.json');
    }
  } catch {
    // userData unavailable (tests); profiles stay in-memory.
  }
  return null;
}

function rebuildServerMenu() {
  if (!Menu?.buildFromTemplate || !Menu?.setApplicationMenu) return;

  const serverItems = [
    {
      label: 'This Mac (local)',
      type: 'radio',
      checked: currentServerTarget === 'local',
      click: () => connectToServer('local').catch((error) => console.error(error)),
    },
  ];
  if (serverProfilesState.servers.length > 0) {
    serverItems.push({ type: 'separator' });
    for (const server of serverProfilesState.servers) {
      serverItems.push({
        label: `${server.name} — ${server.url}`,
        type: 'radio',
        checked: currentServerTarget === server.url,
        click: () => connectToServer(server.url).catch((error) => console.error(error)),
      });
    }
  }

  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { label: 'Server', submenu: serverItems },
    { role: 'windowMenu' },
  ];

  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } catch (error) {
    console.error('[desktop] failed to build the Server menu', error);
  }
}

async function connectToServer(target) {
  if (!mainWindow) {
    return { ok: false, error: 'Nuncio window is not available' };
  }

  if (target === 'local') {
    currentServerTarget = 'local';
    serverProfilesState = { ...serverProfilesState, lastUsed: 'local' };
    serverProfiles.saveProfiles(serverProfilesPath, serverProfilesState);
    rebuildServerMenu();
    if (!localServerUrl) {
      return { ok: false, error: 'local daemon is not running' };
    }
    await mainWindow.loadURL(localServerUrl);
    return { ok: true, target: 'local' };
  }

  const url = serverProfiles.normalizeServerUrl(target);
  if (!url) {
    return { ok: false, error: 'invalid server url' };
  }

  serverProfilesState = serverProfiles.upsertServer(serverProfilesState, url);
  serverProfilesState = { ...serverProfilesState, lastUsed: url };
  serverProfiles.saveProfiles(serverProfilesPath, serverProfilesState);
  currentServerTarget = url;
  rebuildServerMenu();
  await mainWindow.loadURL(url);
  return { ok: true, target: url };
}

function registerServerHandlers() {
  ipcMain.handle('servers:list', () => ({
    current: currentServerTarget,
    localUrl: localServerUrl,
    servers: serverProfilesState.servers,
  }));

  ipcMain.handle('servers:connect', (_event, target) => connectToServer(target));
}

async function probeDevServer(timeoutMs = DEV_SERVER_PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(DEV_SERVER_URL, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForDevServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const probeTimeoutMs = Math.min(DEV_SERVER_PROBE_TIMEOUT_MS, Math.max(1, deadline - Date.now()));

    if (await probeDevServer(probeTimeoutMs)) {
      return true;
    }

    const delayMs = Math.min(DEV_SERVER_RETRY_INTERVAL_MS, deadline - Date.now());
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return false;
}

async function shouldUseDevServer() {
  if (process.env.NUNCIO_DESKTOP_DEV === '1') {
    return true;
  }

  if (process.env.NUNCIO_DESKTOP_DEV === '0') {
    return false;
  }

  return probeDevServer();
}

function createErrorWindow(error) {
  const message = error instanceof Error ? error.message : String(error);
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Nuncio daemon failed</title>
    <style>
      body { font: 14px system-ui, sans-serif; padding: 32px; color: #1f2937; }
      pre { padding: 16px; background: #f3f4f6; border-radius: 8px; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <h1>Nuncio could not start its local daemon</h1>
    <p>The desktop shell could not load the app because the Bun/Nest daemon failed its health check.</p>
    <pre>${escapeHtml(message)}</pre>
  </body>
</html>`;

  dialog.showErrorBox('Nuncio daemon failed', message);
  return createWindow(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function registerNotifyHandler() {
  ipcMain.handle('nuncio:notify', (_event, payload) => {
    if (!payload || typeof payload !== 'object') return;
    const title = typeof payload.title === 'string' ? payload.title : 'Nuncio';
    const body = typeof payload.body === 'string' ? payload.body : '';
    if (!Notification.isSupported()) return;

    const notification = new Notification({ title, body });
    notification.on('click', () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    });
    notification.show();
  });
}

function normalizeBrowserUrl(url) {
  const value = typeof url === 'string' ? url.trim() : '';
  if (!value) return '';
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) return value;
  return `https://${value}`;
}

function coerceBrowserCoordinate(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.trunc(numeric));
}

function coerceBrowserSize(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(1, Math.trunc(numeric));
}

function coerceBrowserBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') {
    throw new Error('browser bounds are required');
  }
  return {
    x: coerceBrowserCoordinate(bounds.x),
    y: coerceBrowserCoordinate(bounds.y),
    width: coerceBrowserSize(bounds.width),
    height: coerceBrowserSize(bounds.height),
  };
}

function getEmbeddedBrowser(id) {
  if (typeof id !== 'string' || !id) {
    throw new Error('browser id is required');
  }

  const existing = embeddedBrowserViews.get(id);
  if (existing) return existing;

  if (typeof BrowserView !== 'function') {
    throw new Error('Electron BrowserView is unavailable');
  }

  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: EMBEDDED_BROWSER_PARTITION,
      sandbox: true,
    },
  });
  view.setAutoResize?.({ width: true, height: true });

  const entry = { id, view };
  embeddedBrowserViews.set(id, entry);
  return entry;
}

function embeddedBrowserState(entry) {
  const webContents = entry.view.webContents;
  return {
    url: webContents.getURL?.() || null,
    title: webContents.getTitle?.() || null,
    loading: Boolean(webContents.isLoading?.()),
  };
}

function attachEmbeddedBrowser(entry) {
  if (!mainWindow) {
    throw new Error('Nuncio window is not available');
  }

  if (activeEmbeddedBrowserId && activeEmbeddedBrowserId !== entry.id) {
    const active = embeddedBrowserViews.get(activeEmbeddedBrowserId);
    if (active) {
      detachEmbeddedBrowser(active.id);
    }
  }

  if (typeof mainWindow.setBrowserView === 'function') {
    mainWindow.setBrowserView(entry.view);
  } else if (typeof mainWindow.addBrowserView === 'function') {
    mainWindow.addBrowserView(entry.view);
  } else {
    throw new Error('Nuncio window cannot host an embedded browser');
  }
  activeEmbeddedBrowserId = entry.id;
}

function detachEmbeddedBrowser(id) {
  if (!mainWindow || activeEmbeddedBrowserId !== id) return;
  const entry = embeddedBrowserViews.get(id);
  if (!entry) return;

  if (typeof mainWindow.removeBrowserView === 'function') {
    mainWindow.removeBrowserView(entry.view);
  } else if (typeof mainWindow.setBrowserView === 'function') {
    mainWindow.setBrowserView(null);
  }
  activeEmbeddedBrowserId = null;
}

function destroyAllEmbeddedBrowsers() {
  for (const entry of embeddedBrowserViews.values()) {
    try {
      entry.view.webContents?.close?.();
    } catch {
      // The window owns the native view lifecycle; close can throw during shutdown.
    }
  }
  embeddedBrowserViews.clear();
  activeEmbeddedBrowserId = null;
}

async function loadEmbeddedBrowserUrl(entry, url) {
  const normalized = normalizeBrowserUrl(url);
  if (!normalized) return;
  if (entry.view.webContents.getURL?.() === normalized) return;
  await entry.view.webContents.loadURL(normalized);
}

function registerBrowserHandlers() {
  ipcMain.handle('browser:show', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      throw new Error('browser:show requires a payload');
    }

    const entry = getEmbeddedBrowser(payload.id);
    attachEmbeddedBrowser(entry);
    entry.view.setBounds(coerceBrowserBounds(payload.bounds));
    await loadEmbeddedBrowserUrl(entry, payload.url);
    return embeddedBrowserState(entry);
  });

  ipcMain.handle('browser:navigate', async (_event, id, url) => {
    const entry = getEmbeddedBrowser(id);
    attachEmbeddedBrowser(entry);
    await loadEmbeddedBrowserUrl(entry, url);
    return embeddedBrowserState(entry);
  });

  ipcMain.handle('browser:reload', (_event, id) => {
    const entry = getEmbeddedBrowser(id);
    attachEmbeddedBrowser(entry);
    entry.view.webContents.reload?.();
    return embeddedBrowserState(entry);
  });

  ipcMain.handle('browser:resize', (_event, id, bounds) => {
    const entry = embeddedBrowserViews.get(id);
    if (!entry) return null;
    entry.view.setBounds(coerceBrowserBounds(bounds));
    return embeddedBrowserState(entry);
  });

  ipcMain.handle('browser:hide', (_event, id) => {
    if (typeof id !== 'string') return;
    detachEmbeddedBrowser(id);
  });
}

function normalizeTerminalCwd(cwd) {
  const fs = require('node:fs');
  const os = require('node:os');

  if (typeof cwd === 'string' && cwd) {
    try {
      if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) {
        return cwd;
      }
    } catch {
      // Fall through to the home directory.
    }
  }
  return os.homedir();
}

function coerceTerminalDimension(value, fallback) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(1000, Math.max(1, Math.trunc(numeric)));
}

function killTerminalPty(id) {
  const pty = terminalPtys.get(id);
  if (!pty) return;
  terminalPtys.delete(id);
  try {
    pty.kill();
  } catch {
    // PTY may already be dead.
  }
}

function killAllTerminalPtys() {
  for (const id of [...terminalPtys.keys()]) {
    killTerminalPty(id);
  }
}

function registerTerminalHandlers() {
  ipcMain.handle('terminal:create', (_event, payload) => {
    if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string' || !payload.id) {
      throw new Error('terminal:create requires an id');
    }

    const id = payload.id;
    killTerminalPty(id);

    let nodePty;
    try {
      // Lazy require: node-pty is a native Electron dependency and must not load under Bun tests.
      nodePty = require('node-pty');
    } catch (error) {
      throw new Error(`node-pty unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }

    const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash');
    const cols = coerceTerminalDimension(payload.cols, 80);
    const rows = coerceTerminalDimension(payload.rows, 24);
    const cwd = normalizeTerminalCwd(payload.cwd);

    let pty;
    try {
      pty = nodePty.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: process.env,
      });
    } catch (error) {
      throw new Error(`node-pty spawn failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    terminalPtys.set(id, pty);
    pty.onData((data) => {
      mainWindow?.webContents.send('terminal:data', { id, data });
    });
    pty.onExit(({ exitCode }) => {
      terminalPtys.delete(id);
      mainWindow?.webContents.send('terminal:exit', { id, code: exitCode ?? null });
    });

    return { id };
  });

  ipcMain.handle('terminal:write', (_event, id, data) => {
    if (typeof id !== 'string' || typeof data !== 'string') return;
    terminalPtys.get(id)?.write(data);
  });

  ipcMain.handle('terminal:resize', (_event, id, cols, rows) => {
    if (typeof id !== 'string') return;
    const pty = terminalPtys.get(id);
    if (!pty) return;
    pty.resize(coerceTerminalDimension(cols, 80), coerceTerminalDimension(rows, 24));
  });

  ipcMain.handle('terminal:kill', (_event, id) => {
    if (typeof id !== 'string') return;
    killTerminalPty(id);
  });
}

app.whenReady().then(async () => {
  registerNotifyHandler();
  registerBrowserHandlers();
  registerTerminalHandlers();
  registerServerHandlers();

  serverProfilesPath = resolveServerProfilesPath();
  serverProfilesState = serverProfiles.loadProfiles(serverProfilesPath);

  // A packaged .app has no dev server and must never probe for one — it runs the
  // compiled server binary shipped in Resources. The dev-server path stays for
  // `bun run dev` and for running `electron .` against a source checkout.
  const packaged = app.isPackaged;
  const forcedDevMode = !packaged && process.env.NUNCIO_DESKTOP_DEV === '1';
  const useDevServer = packaged
    ? false
    : forcedDevMode
      ? await waitForDevServer(FORCED_DEV_SERVER_TIMEOUT_MS)
      : await shouldUseDevServer();

  if (useDevServer) {
    console.log('[desktop] dev mode', DEV_SERVER_URL);
    localServerUrl = DEV_SERVER_URL;
    await createWindow(DEV_SERVER_URL);
    rebuildServerMenu();
    mainWindow?.webContents.openDevTools({ mode: 'detach' });
  } else if (forcedDevMode) {
    const error = new Error(
      `Nuncio desktop dev server never came up at ${DEV_SERVER_URL} within ${FORCED_DEV_SERVER_TIMEOUT_MS / 1000} seconds.`,
    );
    console.error(error);
    await createErrorWindow(error);
  } else {
    const supervisorOptions = { log: (message) => console.log(message) };
    if (packaged) {
      // Launch the self-contained server binary from the app bundle, writing its
      // SQLite data under userData and serving the web bundle shipped alongside.
      const resourcesPath = process.resourcesPath;
      supervisorOptions.serverBinaryPath = path.join(resourcesPath, 'nuncio-server');
      supervisorOptions.cwd = resourcesPath;
      supervisorOptions.env = {
        ...process.env,
        NUNCIO_DATA_DIR: path.join(app.getPath('userData'), 'data'),
        NUNCIO_WEB_DIST: path.join(resourcesPath, 'web', 'dist'),
      };
    }
    supervisor = new DaemonSupervisor(supervisorOptions);

    try {
      const { url } = await supervisor.start();
      localServerUrl = url;
      // Reopen the last-used server; the did-fail-load fallback returns to the
      // local daemon when a remembered remote is unreachable.
      const lastUsed = serverProfilesState.lastUsed;
      if (lastUsed !== 'local' && serverProfiles.normalizeServerUrl(lastUsed)) {
        currentServerTarget = lastUsed;
        await createWindow(lastUsed);
      } else {
        currentServerTarget = 'local';
        await createWindow(url);
      }
      rebuildServerMenu();
    } catch (error) {
      console.error(error);
      await createErrorWindow(error);
    }
  }

  if (packaged) {
    try {
      require('./updater').initAutoUpdater({ log: (message) => console.log(message) });
    } catch (error) {
      console.error('[updater] initialization failed', error);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const target =
        currentServerTarget !== 'local'
          ? currentServerTarget
          : localServerUrl || supervisor?.url || DEV_SERVER_URL;
      createWindow(target);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  destroyAllEmbeddedBrowsers();
  killAllTerminalPtys();

  if (quittingAfterDaemonStop || !supervisor) {
    return;
  }

  event.preventDefault();
  supervisor
    .stop()
    .catch((error) => console.error('Failed to stop Nuncio daemon', error))
    .finally(() => {
      quittingAfterDaemonStop = true;
      app.quit();
    });
});
