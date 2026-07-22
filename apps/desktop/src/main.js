const path = require('node:path');
const {
  app,
  BrowserWindow,
  BrowserView,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  shell,
  Tray,
} = require('electron');
const { DaemonSupervisor } = require('./daemon');
const serverProfiles = require('./server-profiles');
const shellSettings = require('./shell-settings');
const {
  manageWindowState,
  restoreWindowState,
} = require('./window-state');
const { normalizeBrowserUrl } = require('./browser-url');
const { getWindowChromeOptions } = require('./desktop-chrome');
const {
  buildPickerInstallScript,
  buildPickerUninstallScript,
  normalizeGuestPick,
} = require('./design-mode');

// A single instance owns the daemon and its stable port. A second launch must
// not spawn a second daemon on another port (paired phones would race between
// two servers); the loser quits immediately and hands focus to the first.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// Dev and stable ship as distinct apps — name them apart (separate window state,
// server profiles, updater cache) before anything reads app.getPath('userData').
// The sessions DB is shared across all surfaces via NUNCIO_DATA_DIR below, not
// userData. Channel is taken from the build's app-update.yml.
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
const SERVER_RECONNECT_INTERVAL_MS = 1000;
const EMBEDDED_BROWSER_PARTITION = 'persist:nuncio-browser';

let mainWindow = null;
let mainWindowStateManager = null;
let serverReconnectTimer = null;
let supervisor = null;
let quittingAfterDaemonStop = false;
// Set the moment a real quit begins (menu Quit, Cmd+Q, updater install-on-quit)
// so the window 'close' handler lets the window actually close instead of
// hiding it to the tray.
let quitting = false;
let tray = null;
// True while the initial boot is still choosing/creating the first window
// (daemon start + health wait is async). A second-instance launch that arrives
// during this window must not race the boot by creating its own window; it
// records intent in `pendingWindowFocus`, which the boot honors once its real
// window exists.
let booting = false;
let pendingWindowFocus = false;
const terminalPtys = new Map();
const embeddedBrowserViews = new Map();
let activeEmbeddedBrowserId = null;

// Window/tray behavior. closeToTray on (default) keeps the daemon alive when the
// window is closed so paired phones stay connected; the app lives in the menu
// bar until an explicit Quit.
let shellSettingsState = { closeToTray: true };
let shellSettingsPath = null;
let windowStatePath = null;

// Server-connection state: the shell can load the local daemon or a saved
// remote nuncio server. 'local' is always available as the fallback target.
let serverProfilesState = { lastUsed: 'local', servers: [] };
let serverProfilesPath = null;
let currentServerTarget = 'local';
let localServerUrl = null;
// Auto-updater module (packaged builds only). Held so the application menu can
// render its live "Check for Updates…" indicator; null in dev/tests.
let updater = null;

function createWindow(url) {
  const restoredState = restoreWindowState(
    windowStatePath,
    screen,
    { width: 1280, height: 900 },
    { minWidth: 960, minHeight: 640 },
  );
  const win = new BrowserWindow({
    ...restoredState.bounds,
    minWidth: 960,
    minHeight: 640,
    ...getWindowChromeOptions(process.platform),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow = win;
  const stateManager = manageWindowState(win, windowStatePath);
  mainWindowStateManager = stateManager;
  if (restoredState.maximized) win.maximize();

  // Closing to the tray keeps the local daemon running so paired phones stay
  // connected; the window is hidden, not destroyed. An explicit quit sets
  // `quitting` first, so this only intercepts an ordinary window close. Hide
  // the specific window that is closing (not the module ref, which a later
  // recreate could have reassigned).
  win.on('close', (event) => {
    if (shellSettingsState.closeToTray && !quitting) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    stateManager.dispose();
    destroyAllEmbeddedBrowsers();
    killAllTerminalPtys();
    clearTimeout(serverReconnectTimer);
    serverReconnectTimer = null;
    // Only clear the module ref if this is still the current window — a recreate
    // may already have pointed it at a newer one.
    if (mainWindow === win) {
      mainWindow = null;
      mainWindowStateManager = null;
    }
  });

  // Escape hatch: a remote server that stops responding would leave the shell
  // on an unloadable page (the UI itself comes from that server), so fall back
  // to the local daemon. errorCode -3 (ERR_ABORTED) fires on normal in-app
  // navigations and must be ignored. A failing *local* server (Vite restart in
  // dev, daemon restart when packaged) instead parks the window on a wait page
  // that reloads the app as soon as the server answers again.
  win.webContents.on?.('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    if (currentServerTarget !== 'local' && localServerUrl) {
      console.error(
        `[desktop] failed to load ${validatedURL || currentServerTarget} (${errorDescription}); falling back to the local daemon`,
      );
      connectToServer('local').catch((error) => console.error(error));
      return;
    }
    if (currentServerTarget === 'local' && localServerUrl) {
      console.error(
        `[desktop] failed to load ${validatedURL || localServerUrl} (${errorDescription}); waiting for the local server to come back`,
      );
      const currentUrl = win.webContents.getURL?.() ?? '';
      if (!currentUrl.startsWith('data:')) {
        win.loadURL(serverWaitPageUrl()).catch(() => {});
      }
      scheduleServerReconnect();
    }
  });

  return win.loadURL(url);
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

function resolveShellSettingsPath() {
  try {
    if (typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'shell-settings.json');
    }
  } catch {
    // userData unavailable (tests); settings stay in-memory.
  }
  return null;
}

function resolveWindowStatePath() {
  try {
    if (typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'window-state.json');
    }
  } catch {
    // userData unavailable (tests); window state stays in-memory.
  }
  return null;
}

// The URL the app should currently load. Prefers a remembered remote target,
// then the local daemon, falling back to the dev-server URL — the same
// resolution `activate` used, factored out so tray actions can reopen a window.
function currentAppUrl() {
  if (currentServerTarget !== 'local') return currentServerTarget;
  return localServerUrl || supervisor?.url || DEV_SERVER_URL;
}

function focusExistingWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Bring the window to the foreground, recreating it if a previous close (with
// close-to-tray off, or on a fresh menu-bar launch) destroyed it. During the
// initial boot the window does not exist yet and is being created
// asynchronously; creating one here would race the boot into a second window,
// so defer to a focus-once-ready intent instead.
function showMainWindow() {
  if (mainWindow) {
    focusExistingWindow();
    return;
  }
  if (booting) {
    pendingWindowFocus = true;
    return;
  }
  createWindow(currentAppUrl()).catch((error) => console.error(error));
}

// Open the window on the Mobile settings pane. The web app reads `?section=`
// on the settings route to pick the initial pane, so a deep-link URL lands the
// user straight on the phone-pairing controls.
function openPairingSettings() {
  const base = currentAppUrl();
  let target = base;
  try {
    const url = new URL(base);
    url.pathname = url.pathname.replace(/\/+$/, '') + '/settings';
    url.searchParams.set('section', 'mobile');
    target = url.toString();
  } catch {
    // A data: URL error page or malformed base — just show the window as-is.
  }

  if (mainWindow) {
    focusExistingWindow();
    mainWindow.loadURL(target).catch((error) => console.error(error));
    return;
  }
  // The tray (the only caller) does not exist during boot, but guard anyway:
  // defer rather than race the boot into a second window.
  if (booting) {
    pendingWindowFocus = true;
    return;
  }
  createWindow(target).catch((error) => console.error(error));
}

function trayIconImage() {
  // Menu-bar template image: macOS recolors it for light/dark automatically.
  // Packaged builds ship build/ under Resources; a source checkout reads it
  // relative to this file.
  const candidates = [
    path.join(__dirname, '..', 'build', 'trayTemplate.png'),
    path.join(process.resourcesPath || '', 'build', 'trayTemplate.png'),
  ];
  for (const file of candidates) {
    const image = nativeImage.createFromPath(file);
    if (!image.isEmpty()) {
      image.setTemplateImage(true);
      return image;
    }
  }
  // Fall back to an empty image; Tray still constructs and shows a blank slot
  // rather than crashing when the asset is missing.
  return nativeImage.createEmpty();
}

function trayMenuTemplate() {
  return [
    { label: 'Open Nuncio', click: () => showMainWindow() },
    { label: 'Pair mobile device…', click: () => openPairingSettings() },
    { type: 'separator' },
    { label: 'Quit Nuncio', click: () => app.quit() },
  ];
}

function rebuildTrayMenu() {
  if (!tray || !Menu?.buildFromTemplate) return;
  try {
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
  } catch (error) {
    console.error('[desktop] failed to build the tray menu', error);
  }
}

// Create the menu-bar tray icon (idempotent). Guarded so a missing/broken asset
// can never block boot — the app still runs without a tray.
function ensureTray() {
  if (tray || typeof Tray !== 'function') return;
  try {
    tray = new Tray(trayIconImage());
    tray.setToolTip('Nuncio');
    tray.on('click', () => showMainWindow());
    rebuildTrayMenu();
  } catch (error) {
    console.error('[desktop] tray unavailable', error);
    tray = null;
  }
}

function destroyTray() {
  if (!tray) return;
  try {
    tray.destroy();
  } catch {
    // Already destroyed or platform teardown; ignore.
  }
  tray = null;
}

// Reconcile the tray with the current close-to-tray setting: present when on,
// gone when off.
function syncTray() {
  if (shellSettingsState.closeToTray) {
    ensureTray();
    rebuildTrayMenu();
  } else {
    destroyTray();
  }
}

// The app menu (darwin) hosts "Check for Updates…" right under About — the
// conventional macOS spot. Its label is the updater's live indicator
// ("Checking…" / "Downloading Update… 42%" / "Restart to Install …").
function buildAppMenuItems() {
  const items = [{ role: 'about' }];
  if (updater) {
    items.push({ type: 'separator' }, updater.updaterMenuItem());
  }
  items.push(
    { type: 'separator' },
    { role: 'services' },
    { type: 'separator' },
    { role: 'hide' },
    { role: 'hideOthers' },
    { role: 'unhide' },
    { type: 'separator' },
    { role: 'quit' },
  );
  return items;
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
    ...(process.platform === 'darwin' ? [{ label: app.name, submenu: buildAppMenuItems() }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { label: 'Server', submenu: serverItems },
    { role: 'windowMenu' },
    // Non-darwin has no app menu, so the updater indicator lives under Help.
    ...(process.platform !== 'darwin' && updater
      ? [{ role: 'help', submenu: [updater.updaterMenuItem()] }]
      : []),
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

function registerShellHandlers() {
  ipcMain.handle('shell:get-settings', () => ({ closeToTray: shellSettingsState.closeToTray }));

  ipcMain.handle('shell:set-settings', (_event, payload) => {
    // Renderer input: only strict boolean false disables; ignore anything else
    // and keep the current value when the field is absent.
    const requested =
      payload && typeof payload === 'object' && 'closeToTray' in payload
        ? shellSettings.normalizeCloseToTray(payload.closeToTray)
        : shellSettingsState.closeToTray;
    shellSettingsState = { closeToTray: requested };
    shellSettings.saveSettings(shellSettingsPath, shellSettingsState);
    // Turning the setting on brings up the tray; turning it off removes it.
    syncTray();
    return { closeToTray: shellSettingsState.closeToTray };
  });
}

async function probeServerUrl(url, timeoutMs = DEV_SERVER_PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function probeDevServer(timeoutMs = DEV_SERVER_PROBE_TIMEOUT_MS) {
  return probeServerUrl(DEV_SERVER_URL, timeoutMs);
}

// A local server (Vite in dev, the daemon when packaged) can restart under a
// live window. A reload during that downtime lands on Chromium's error page,
// which never recovers on its own while the window is occluded — the window
// stays blank until someone reloads it by hand. Park the window on a wait page
// and poll the local URL until it answers, then load the app again.
function serverWaitPageUrl() {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Nuncio — reconnecting</title>
    <style>
      body { font: 14px system-ui, sans-serif; background: #0d0f12; color: #9ca3af; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
      .card { text-align: center; }
      h1 { font-size: 16px; color: #e5e7eb; margin: 0 0 8px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Waiting for the Nuncio server…</h1>
      <p>This window reconnects automatically once the server is back.</p>
    </div>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function scheduleServerReconnect() {
  if (serverReconnectTimer) return;
  const attempt = async () => {
    serverReconnectTimer = null;
    if (!mainWindow || currentServerTarget !== 'local' || !localServerUrl) return;
    if (await probeServerUrl(localServerUrl)) {
      try {
        await mainWindow.loadURL(localServerUrl);
        return;
      } catch {
        // Server flapped between probe and load — keep retrying.
      }
    }
    if (!serverReconnectTimer) {
      serverReconnectTimer = setTimeout(attempt, SERVER_RECONNECT_INTERVAL_MS);
    }
  };
  serverReconnectTimer = setTimeout(attempt, SERVER_RECONNECT_INTERVAL_MS);
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

function normalizeExternalUrl(url) {
  const value = typeof url === 'string' ? url.trim() : '';
  if (!/^https?:\/\//i.test(value)) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function registerExternalHandlers() {
  ipcMain.handle('external:open', async (_event, url) => {
    const normalized = normalizeExternalUrl(url);
    if (!normalized) throw new Error('External URL must use http or https');
    await shell.openExternal(normalized);
    return { ok: true, url: normalized };
  });
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
      preload: path.join(__dirname, 'browser-view-preload.js'),
    },
  });
  view.setAutoResize?.({ width: true, height: true });

  const entry = { id, view, designMode: false, designModeNavHooked: false };
  wireDesignModeNavigation(entry);
  embeddedBrowserViews.set(id, entry);
  return entry;
}

function wireDesignModeNavigation(entry) {
  if (entry.designModeNavHooked) return;
  const webContents = entry.view.webContents;
  if (!webContents?.on) return;
  entry.designModeNavHooked = true;
  const reinject = () => {
    if (!entry.designMode) return;
    void injectDesignModePicker(entry).catch(() => undefined);
  };
  webContents.on('did-finish-load', reinject);
  webContents.on('did-navigate-in-page', reinject);
}

async function injectDesignModePicker(entry) {
  const webContents = entry.view.webContents;
  if (!webContents?.executeJavaScript) return;
  // Always reinstall so SPA navigations / stale flags cannot leave us without handlers.
  try {
    await webContents.executeJavaScript(buildPickerUninstallScript(), true);
  } catch {
    // First install — uninstall may no-op.
  }
  await webContents.executeJavaScript(buildPickerInstallScript(), true);
}

async function removeDesignModePicker(entry) {
  const webContents = entry.view.webContents;
  if (!webContents?.executeJavaScript) return;
  await webContents.executeJavaScript(buildPickerUninstallScript(), true);
}

function findEmbeddedBrowserByWebContents(webContents) {
  for (const entry of embeddedBrowserViews.values()) {
    if (entry.view.webContents === webContents) return entry;
  }
  return null;
}

function focusDesignModeOverlayHost() {
  if (!mainWindow) return;
  try {
    if (mainWindow.isMinimized?.()) mainWindow.restore?.();
    mainWindow.show?.();
    mainWindow.focus?.();
    mainWindow.webContents?.focus?.();
  } catch {
    // Focus is best-effort; the renderer still receives the pick event.
  }
}

async function captureDesignModeCrop(entry, bbox) {
  const webContents = entry.view.webContents;
  if (!webContents?.capturePage || !bbox) return undefined;
  try {
    const image = await webContents.capturePage({
      x: Math.max(0, bbox.x),
      y: Math.max(0, bbox.y),
      width: Math.max(1, bbox.width),
      height: Math.max(1, bbox.height),
    });
    if (!image || typeof image.toPNG !== 'function') return undefined;
    const png = image.toPNG();
    if (!png || !png.length) return undefined;
    return Buffer.from(png).toString('base64');
  } catch {
    return undefined;
  }
}

async function forwardDesignModePick(entry, rawPayload) {
  const pick = normalizeGuestPick(rawPayload);
  if (!pick.cropPngBase64) {
    const crop = await captureDesignModeCrop(entry, pick.bbox);
    if (crop) pick.cropPngBase64 = crop;
  }
  // Return keyboard focus to the app so the React Design Mode pill can receive typing.
  focusDesignModeOverlayHost();
  mainWindow?.webContents?.send?.('browser:design-mode-pick', {
    id: entry.id,
    pick,
  });
}

async function forwardDesignModeSteer(entry, rawPayload) {
  const text = typeof rawPayload?.text === 'string' ? rawPayload.text : '';
  const rawComponents = Array.isArray(rawPayload?.components) ? rawPayload.components : [];
  const components = [];
  for (const raw of rawComponents.slice(0, 8)) {
    try {
      const pick = normalizeGuestPick(raw);
      if (!pick.cropPngBase64) {
        const crop = await captureDesignModeCrop(entry, pick.bbox);
        if (crop) pick.cropPngBase64 = crop;
      }
      components.push(pick);
    } catch {
      // Skip malformed picks.
    }
  }
  mainWindow?.webContents?.send?.('browser:design-mode-steer', {
    id: entry.id,
    text,
    components,
  });
}

function forwardDesignModeExit(entry) {
  entry.designMode = false;
  void removeDesignModePicker(entry).catch(() => undefined);
  mainWindow?.webContents?.send?.('browser:design-mode-exit', { id: entry.id });
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

  ipcMain.handle('browser:design-mode-enter', async (_event, id) => {
    const entry = getEmbeddedBrowser(id);
    entry.designMode = true;
    attachEmbeddedBrowser(entry);
    await injectDesignModePicker(entry);
    return { ok: true, id: entry.id };
  });

  ipcMain.handle('browser:design-mode-leave', async (_event, id) => {
    const entry = embeddedBrowserViews.get(id);
    if (!entry) return { ok: true, id };
    entry.designMode = false;
    await removeDesignModePicker(entry);
    return { ok: true, id: entry.id };
  });

  ipcMain.on('browser:design-mode-guest-pick', (event, payload) => {
    const entry = findEmbeddedBrowserByWebContents(event.sender);
    if (!entry || !entry.designMode) return;
    void forwardDesignModePick(entry, payload).catch((error) => {
      console.error(
        '[nuncio-desktop] design mode pick failed:',
        error instanceof Error ? error.message : error,
      );
    });
  });

  ipcMain.on('browser:design-mode-guest-steer', (event, payload) => {
    const entry = findEmbeddedBrowserByWebContents(event.sender);
    if (!entry || !entry.designMode) return;
    void forwardDesignModeSteer(entry, payload).catch((error) => {
      console.error(
        '[nuncio-desktop] design mode steer failed:',
        error instanceof Error ? error.message : error,
      );
    });
  });

  ipcMain.on('browser:design-mode-guest-exit', (event) => {
    const entry = findEmbeddedBrowserByWebContents(event.sender);
    if (!entry) return;
    forwardDesignModeExit(entry);
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
  // Guard the async window creation below: a second-instance launch arriving
  // before the first window exists must not create a competing one.
  booting = true;

  registerNotifyHandler();
  registerExternalHandlers();
  registerBrowserHandlers();
  registerTerminalHandlers();
  registerServerHandlers();
  registerShellHandlers();

  serverProfilesPath = resolveServerProfilesPath();
  serverProfilesState = serverProfiles.loadProfiles(serverProfilesPath);
  shellSettingsPath = resolveShellSettingsPath();
  shellSettingsState = shellSettings.loadSettings(shellSettingsPath);
  windowStatePath = resolveWindowStatePath();

  // A packaged .app has no dev server and must never probe for one — it runs the
  // bundled server script with the Bun runtime shipped in Resources. The dev-server path stays for
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
      // Launch the bundled server script with the shipped Bun runtime, writing
      // its SQLite data under userData and serving the web bundle alongside.
      // cwd must be Resources/server so externals like @cursor/sdk resolve
      // against the staged node_modules there.
      const resourcesPath = process.resourcesPath;
      const daemonEnv = { ...process.env };
      delete daemonEnv.NUNCIO_FORCE_MOCK;
      supervisorOptions.bunPath = path.join(resourcesPath, 'bun');
      supervisorOptions.entryPath = path.join(resourcesPath, 'server', 'server.js');
      supervisorOptions.cwd = path.join(resourcesPath, 'server');
      supervisorOptions.env = {
        ...daemonEnv,
        // Share the SQLite backend with `bun run dev` and worktrees so every
        // surface sees the same sessions (the shared-backend convention).
        NUNCIO_DATA_DIR: path.join(require('node:os').homedir(), '.nuncio', 'data'),
        NUNCIO_PACKAGED: '1',
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
      updater = require('./updater');
      updater.initAutoUpdater({
        log: (message) => console.log(message),
        // Re-render the menus on every state change so the "Check for Updates…"
        // item reflects checking/downloading/ready live.
        onStateChange: () => {
          rebuildServerMenu();
          rebuildTrayMenu();
        },
        // The updater quit emits the window 'close' before 'before-quit', so mark
        // the quit here — ahead of the close — or close-to-tray would hide the
        // window and swallow the install.
        onBeforeQuitForInstall: () => {
          quitting = true;
        },
      });
      // Render the idle "Check for Updates…" item immediately.
      rebuildServerMenu();
    } catch (error) {
      console.error('[updater] initialization failed', error);
    }
  }

  // Boot is done choosing/creating the first window. Honor a focus request that
  // a second-instance launch deferred while we were still starting up.
  booting = false;
  if (pendingWindowFocus) {
    pendingWindowFocus = false;
    showMainWindow();
  }

  // Bring up the menu-bar tray when close-to-tray is on so there is always a way
  // back to the window after it is hidden. Deferred to here so the icon appears
  // once the app has a window (or an error window) to reopen.
  syncTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(currentAppUrl());
    }
  });
});

// A second launch reaches the first instance here instead of starting its own
// daemon: surface the existing window rather than opening a new one.
app.on('second-instance', () => {
  showMainWindow();
});

app.on('window-all-closed', () => {
  // With close-to-tray on, the app intentionally lives in the menu bar with no
  // window and the daemon still running — never quit here on any platform.
  if (shellSettingsState.closeToTray) {
    return;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// An update install (quitAndInstall) emits the window 'close' before
// 'before-quit'. Mark the quit here so the close-to-tray handler lets the window
// actually close instead of hiding it — otherwise the pending install is lost.
app.on('before-quit-for-update', () => {
  quitting = true;
});

app.on('before-quit', (event) => {
  // Mark that a real quit is underway so the window 'close' handler stops
  // intercepting to the tray. This also covers the updater's install-on-quit
  // path, which triggers a normal app quit.
  quitting = true;
  mainWindowStateManager?.flush();
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
