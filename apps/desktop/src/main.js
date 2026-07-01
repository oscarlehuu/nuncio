const path = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');
const { DaemonSupervisor } = require('./daemon');

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && supervisor?.url) {
      createWindow(supervisor.url);
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
