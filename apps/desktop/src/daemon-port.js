const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const PORT_FILE = 'daemon-port';
const MIN_PORT = 1;
const MAX_PORT = 65_535;
// A valid port is at most 5 decimal digits; a larger file is corrupt/hostile and
// must not be slurped into memory. Read only a small prefix and match strictly.
const MAX_PORT_FILE_BYTES = 64;
const PORT_PATTERN = /^\d{1,5}$/;

/**
 * Resolves the data directory the supervisor persists into. Honors a
 * NUNCIO_DATA_DIR passed in the daemon env (absolute, or a ~/$HOME-style prefix),
 * falling back to ~/.nuncio/data so a source run and a packaged app agree.
 */
function resolveDataDir(env = {}) {
  const raw = env.NUNCIO_DATA_DIR;
  if (typeof raw === 'string' && raw.trim()) {
    return expandHome(raw.trim());
  }
  return path.join(os.homedir(), '.nuncio', 'data');
}

/** Expand a leading ~ or $HOME so persisted paths resolve regardless of how they arrive. */
function expandHome(value) {
  if (value === '~' || value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(1));
  }
  if (value.startsWith('$HOME/') || value === '$HOME') {
    return path.join(os.homedir(), value.slice('$HOME'.length));
  }
  return value;
}

function portFilePath(dataDir) {
  return path.join(dataDir, PORT_FILE);
}

/** Reads a previously persisted port, or null when absent/oversized/corrupt/out of range. */
function readPersistedPort(dataDir) {
  let fd;
  try {
    fd = fs.openSync(portFilePath(dataDir), 'r');
    // Stat first: an oversized file is corrupt — reject without reading it all.
    if (fs.fstatSync(fd).size > MAX_PORT_FILE_BYTES) {
      return null;
    }
    const buffer = Buffer.alloc(MAX_PORT_FILE_BYTES);
    const bytes = fs.readSync(fd, buffer, 0, MAX_PORT_FILE_BYTES, 0);
    const raw = buffer.toString('utf8', 0, bytes).trim();
    if (!PORT_PATTERN.test(raw)) {
      return null;
    }
    const port = Number(raw);
    if (Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT) {
      return port;
    }
    return null;
  } catch {
    // Missing file (ENOENT) or any read error → behave as if unset.
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // fd already invalid
      }
    }
  }
}

/** True when nothing else holds the port right now (same bind test findFreePort uses). */
function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close((error) => resolve(!error));
    });
  });
}

/**
 * Persists the chosen port. Failure is non-fatal: a missing daemon-port file just
 * means the next launch leases a fresh random port, so we log and continue.
 */
function persistPort(dataDir, port, log = () => {}) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(portFilePath(dataDir), `${port}\n`, 'utf8');
    return true;
  } catch (error) {
    log(`[daemon] could not persist port ${port}: ${error.message}`);
    return false;
  }
}

/**
 * Resolves the port a launch should bind: reuse the persisted one when it is still
 * free (so LAN QR URLs survive a restart), otherwise lease a fresh port via
 * `findFreePort` and re-persist it. Persist errors never block startup.
 */
async function resolveStablePort({ dataDir, findFreePort, host = '127.0.0.1', log = () => {} }) {
  const persisted = readPersistedPort(dataDir);
  if (persisted !== null && (await isPortFree(persisted, host))) {
    return persisted;
  }

  const port = await findFreePort(host);
  persistPort(dataDir, port, log);
  return port;
}

module.exports = {
  resolveDataDir,
  expandHome,
  portFilePath,
  readPersistedPort,
  isPortFree,
  persistPort,
  resolveStablePort,
};
