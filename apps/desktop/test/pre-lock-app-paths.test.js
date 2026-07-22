const { afterEach, describe, expect, test } = require('bun:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const desktopDir = path.resolve(__dirname, '..');
const helperPath = path.join(desktopDir, 'src', 'pre-lock-app-paths.js');
const electronPackageDir = path.dirname(
  require.resolve('electron/package.json'),
);
const electronBinary = path.join(
  electronPackageDir,
  'dist',
  fs.readFileSync(path.join(electronPackageDir, 'path.txt'), 'utf8').trim(),
);
const tempRoots = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

function makeProbeScript(root) {
  const outputPath = path.join(root, 'result.json');
  const scriptPath = path.join(root, 'probe.cjs');
  fs.writeFileSync(
    scriptPath,
    `const fs = require('node:fs');
const { app } = require('electron');
const { configurePackagedPreLockPaths } = require(${JSON.stringify(helperPath)});
const outputPath = ${JSON.stringify(outputPath)};
try {
  const defaultAppData = app.getPath('appData');
  const paths = configurePackagedPreLockPaths(app, process.env);
  const lockAcquired = app.requestSingleInstanceLock();
  fs.writeFileSync(outputPath, JSON.stringify({
    defaultAppData,
    paths,
    beforeLock: {
      appData: app.getPath('appData'),
      userData: app.getPath('userData'),
    },
    lockAcquired,
  }));
  app.whenReady().then(() => app.quit());
} catch (error) {
  fs.writeFileSync(outputPath, JSON.stringify({ error: error?.stack || String(error) }));
  app.exit(1);
}
`,
  );
  return { outputPath, scriptPath };
}

describe('desktop pre-lock app paths', () => {
  if (process.platform === 'darwin') {
    test('real Electron resolves smoke appData and userData before the macOS lock', () => {
      const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nuncio-réel-工具-'));
      tempRoots.push(smokeRoot);
      const smokeHome = path.join(smokeRoot, 'home');
      const dataDir = path.join(smokeHome, '.nuncio', 'data');
      const appDataRoot = path.join(dataDir, 'electron-app-data');
      const userData = path.join(appDataRoot, 'Nuncio');
      fs.mkdirSync(appDataRoot, { recursive: true });
      const { outputPath, scriptPath } = makeProbeScript(smokeRoot);

      const result = spawnSync(electronBinary, [scriptPath], {
        cwd: desktopDir,
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          ...process.env,
          HOME: smokeHome,
          NUNCIO_DATA_DIR: dataDir,
          NUNCIO_DESKTOP_SMOKE_TEMP_ROOT: smokeRoot,
          NUNCIO_DESKTOP_SMOKE_APP_DATA_ROOT: appDataRoot,
          NUNCIO_DESKTOP_SMOKE_NONCE: 'a'.repeat(64),
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(fs.existsSync(outputPath)).toBe(true);
      const proof = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      expect(proof.error).toBeUndefined();
      expect(proof.lockAcquired).toBe(true);
      expect(proof.paths).toEqual({
        appData: appDataRoot,
        userData,
        smokeIsolated: true,
      });
      expect(proof.beforeLock).toEqual({ appData: appDataRoot, userData });
      expect(proof.defaultAppData).not.toBe(appDataRoot);
    });
  }
});
