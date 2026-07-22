import preLockPaths from '../src/pre-lock-app-paths.js';

const { formatSmokePreLockPathEvidence } = preLockPaths;

const FATAL_RUNTIME_PATTERNS = [
  {
    kind: 'main-process-error',
    pattern: /A JavaScript error occurred in the main process/i,
  },
  {
    kind: 'uncaught-exception',
    pattern: /Uncaught Exception/i,
  },
  {
    kind: 'unhandled-rejection',
    pattern: /UnhandledPromiseRejection|unhandled(?:\s+promise)?\s*rejection/i,
  },
  {
    kind: 'address-in-use',
    pattern: /EADDRINUSE/i,
  },
  {
    kind: 'daemon-exit',
    pattern: /\[daemon exit\]\s+code=/i,
  },
  {
    kind: 'daemon-restart',
    pattern: /\[daemon\]\s+unexpected exit;/i,
  },
];

function findFatalRuntimeEvidence(log) {
  const text = String(log ?? '');
  for (const candidate of FATAL_RUNTIME_PATTERNS) {
    const match = text.match(candidate.pattern);
    if (match) {
      return { kind: candidate.kind, match: match[0] };
    }
  }
  return null;
}

function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function isValidOwnershipNonce(nonce) {
  return typeof nonce === 'string' && /^[a-f0-9]{64}$/.test(nonce);
}

function assertRendererOwnership(rendererUrl, expectedPort) {
  if (typeof rendererUrl !== 'string' || !rendererUrl) {
    throw new Error('renderer URL ownership evidence is missing');
  }

  let parsed;
  try {
    parsed = new URL(rendererUrl);
  } catch {
    throw new Error(`renderer URL ownership evidence is malformed: ${rendererUrl}`);
  }

  const rendererPort = parsed.port ? Number(parsed.port) : 80;
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    rendererPort !== expectedPort
  ) {
    throw new Error(
      `renderer URL does not belong to the leased daemon: ${rendererUrl} (expected http://127.0.0.1:${expectedPort})`,
    );
  }
}

function describeElectronExit(exit) {
  const code = exit?.code ?? 'null';
  const signal = exit?.signal ?? 'null';
  return `code=${code} signal=${signal}`;
}

function assertPreLockPathEvidence(log, expectedAppDataRoot, expectedUserData) {
  if (typeof expectedAppDataRoot !== 'string' || !expectedAppDataRoot) {
    throw new Error('pre-lock path ownership evidence is missing the expected appData root');
  }
  if (typeof expectedUserData !== 'string' || !expectedUserData) {
    throw new Error('pre-lock path ownership evidence is missing the expected userData path');
  }

  const expected = formatSmokePreLockPathEvidence({
    appData: expectedAppDataRoot,
    userData: expectedUserData,
  });
  if (!String(log ?? '').includes(expected)) {
    throw new Error(`pre-lock path ownership evidence is missing: ${expected}`);
  }
}

export function assertRuntimeOwnership({
  log,
  expectedPort,
  expectedNonce,
  expectedAppDataRoot,
  expectedUserData,
  rendererUrl,
  persistedPort,
  electronExit,
  spawnError,
  health,
}) {
  if (spawnError) {
    throw new Error(`electron spawn failed: ${spawnError.message || spawnError}`);
  }
  if (electronExit) {
    throw new Error(`electron exited before ownership verification (${describeElectronExit(electronExit)})`);
  }

  assertPreLockPathEvidence(log, expectedAppDataRoot, expectedUserData);
  const fatal = findFatalRuntimeEvidence(log);
  if (fatal) {
    throw new Error(`fatal runtime ownership evidence (${fatal.kind}): ${fatal.match}`);
  }
  if (!isValidPort(expectedPort)) {
    throw new Error(`invalid smoke daemon port: ${expectedPort}`);
  }
  if (!isValidOwnershipNonce(expectedNonce)) {
    throw new Error('invalid smoke ownership nonce');
  }
  assertRendererOwnership(rendererUrl, expectedPort);
  if (!isValidPort(persistedPort) || persistedPort !== expectedPort) {
    throw new Error(
      `isolated daemon-port ownership mismatch: ${persistedPort ?? 'missing'} (expected ${expectedPort})`,
    );
  }
  if (!health || typeof health !== 'object') {
    throw new Error('daemon health ownership evidence is missing');
  }
  if (health.port !== expectedPort) {
    throw new Error(`daemon health came from port ${health.port ?? 'missing'}, expected ${expectedPort}`);
  }
  if (health.statusCode !== 200) {
    throw new Error(`daemon health check failed with status ${health.statusCode ?? 'missing'}`);
  }
  if (!health.body || typeof health.body !== 'object' || Array.isArray(health.body)) {
    throw new Error('daemon health response body is missing or malformed');
  }
  if (health.body.status !== 'ok' || health.body.service !== 'nuncio-server') {
    throw new Error(
      `daemon health identity mismatch: status=${health.body.status ?? 'missing'} service=${health.body.service ?? 'missing'}`,
    );
  }
  if (health.body.smokeNonce !== expectedNonce) {
    throw new Error('daemon health ownership nonce mismatch');
  }

  return true;
}
