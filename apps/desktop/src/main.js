const path = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');
const { DaemonSupervisor } = require('./daemon');

const DEV_SERVER_URL = process.env.NUNCIO_DESKTOP_DEV_URL || 'http://localhost:5173';
const DEV_SERVER_PROBE_TIMEOUT_MS = 600;
const DEV_SERVER_RETRY_INTERVAL_MS = 300;
const FORCED_DEV_SERVER_TIMEOUT_MS = 30_000;

let mainWindow = null;
let supervisor = null;
let quittingAfterDaemonStop = false;

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
    mainWindow = null;
  });

  return mainWindow.loadURL(url);
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

app.whenReady().then(async () => {
  const forcedDevMode = process.env.NUNCIO_DESKTOP_DEV === '1';
  const useDevServer = forcedDevMode
    ? await waitForDevServer(FORCED_DEV_SERVER_TIMEOUT_MS)
    : await shouldUseDevServer();

  if (useDevServer) {
    console.log('[desktop] dev mode', DEV_SERVER_URL);
    await createWindow(DEV_SERVER_URL);
    mainWindow?.webContents.openDevTools({ mode: 'detach' });
  } else if (forcedDevMode) {
    const error = new Error(
      `Nuncio desktop dev server never came up at ${DEV_SERVER_URL} within ${FORCED_DEV_SERVER_TIMEOUT_MS / 1000} seconds.`,
    );
    console.error(error);
    await createErrorWindow(error);
  } else {
    supervisor = new DaemonSupervisor({
      log: (message) => console.log(message),
    });

    try {
      const { url } = await supervisor.start();
      await createWindow(url);
    } catch (error) {
      console.error(error);
      await createErrorWindow(error);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(supervisor?.url || DEV_SERVER_URL);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
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
