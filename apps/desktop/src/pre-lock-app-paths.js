const path = require('node:path');

const SMOKE_APP_DATA_ROOT_ENV = 'NUNCIO_DESKTOP_SMOKE_APP_DATA_ROOT';
const SMOKE_TEMP_ROOT_ENV = 'NUNCIO_DESKTOP_SMOKE_TEMP_ROOT';
const SMOKE_NONCE_ENV = 'NUNCIO_DESKTOP_SMOKE_NONCE';
const DATA_DIR_ENV = 'NUNCIO_DATA_DIR';

function invalidSmokeRoot(reason) {
  throw new Error(`Invalid desktop smoke app-data root: ${reason}`);
}

function absoluteEnvironmentPath(env, name) {
  const value = env?.[name];
  if (typeof value !== 'string' || value.length === 0) {
    invalidSmokeRoot(`${name} must be a non-empty absolute path`);
  }
  if (!path.isAbsolute(value)) {
    invalidSmokeRoot(`${name} must be an absolute path`);
  }
  return path.resolve(value);
}

function isStrictDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function resolveSmokeAppDataRoot(env = process.env) {
  if (env?.[SMOKE_APP_DATA_ROOT_ENV] === undefined) return null;

  if (typeof env?.[SMOKE_NONCE_ENV] !== 'string' || !/^[a-f0-9]{64}$/.test(env[SMOKE_NONCE_ENV])) {
    invalidSmokeRoot(`${SMOKE_NONCE_ENV} must be a valid smoke launch nonce`);
  }

  const smokeTempRoot = absoluteEnvironmentPath(env, SMOKE_TEMP_ROOT_ENV);
  const dataDir = absoluteEnvironmentPath(env, DATA_DIR_ENV);
  const appDataRoot = absoluteEnvironmentPath(env, SMOKE_APP_DATA_ROOT_ENV);

  if (!isStrictDescendant(smokeTempRoot, dataDir)) {
    invalidSmokeRoot(`${DATA_DIR_ENV} must be inside ${SMOKE_TEMP_ROOT_ENV}`);
  }
  if (!isStrictDescendant(smokeTempRoot, appDataRoot)) {
    invalidSmokeRoot(`${SMOKE_APP_DATA_ROOT_ENV} must be inside ${SMOKE_TEMP_ROOT_ENV}`);
  }
  if (!isStrictDescendant(dataDir, appDataRoot)) {
    invalidSmokeRoot(`${SMOKE_APP_DATA_ROOT_ENV} must be inside ${DATA_DIR_ENV}`);
  }

  return appDataRoot;
}

function formatSmokePreLockPathEvidence({ appData, userData }) {
  return `[desktop] smoke pre-lock paths ${JSON.stringify({ appData, userData })}`;
}

function configurePackagedPreLockPaths(app, env = process.env) {
  const smokeAppDataRoot = resolveSmokeAppDataRoot(env);
  if (smokeAppDataRoot) {
    app.setPath('appData', smokeAppDataRoot);
  }

  // Stable and Dev deliberately share this pre-channel namespace. The winner
  // restores its channel-specific userData only after acquiring the lock.
  app.setName('Nuncio');
  const userData = path.join(app.getPath('appData'), 'Nuncio');
  app.setPath('userData', userData);

  return {
    appData: app.getPath('appData'),
    userData,
    smokeIsolated: smokeAppDataRoot !== null,
  };
}

module.exports = {
  configurePackagedPreLockPaths,
  formatSmokePreLockPathEvidence,
  resolveSmokeAppDataRoot,
};
