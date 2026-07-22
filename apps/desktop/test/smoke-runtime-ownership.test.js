import { describe, expect, test } from 'bun:test';
import { assertRuntimeOwnership } from '../scripts/smoke-runtime-ownership.mjs';
import preLockPaths from '../src/pre-lock-app-paths.js';

const { formatSmokePreLockPathEvidence } = preLockPaths;
const LEASED_PORT = 43_123;
const FALLBACK_PORT = 43_124;
const OWNERSHIP_NONCE = 'a'.repeat(64);
const SMOKE_APP_DATA_ROOT = '/tmp/nuncio-desktop-smoke/data/electron-app-data';
const SMOKE_USER_DATA = `${SMOKE_APP_DATA_ROOT}/Nuncio`;
const PRE_LOCK_EVIDENCE = formatSmokePreLockPathEvidence({
  appData: SMOKE_APP_DATA_ROOT,
  userData: SMOKE_USER_DATA,
});

const goodHealth = (port = LEASED_PORT, smokeNonce = OWNERSHIP_NONCE) => ({
  port,
  statusCode: 200,
  body: { status: 'ok', service: 'nuncio-server', smokeNonce },
});

function goodEvidence(overrides = {}) {
  return {
    log: PRE_LOCK_EVIDENCE,
    expectedPort: LEASED_PORT,
    expectedNonce: OWNERSHIP_NONCE,
    expectedAppDataRoot: SMOKE_APP_DATA_ROOT,
    expectedUserData: SMOKE_USER_DATA,
    rendererUrl: `http://127.0.0.1:${LEASED_PORT}/`,
    persistedPort: LEASED_PORT,
    electronExit: null,
    spawnError: null,
    health: goodHealth(),
    ...overrides,
  };
}

describe('desktop smoke runtime ownership evidence', () => {
  test('accepts the exact pre-lock path marker with otherwise benign logs', () => {
    expect(assertRuntimeOwnership(goodEvidence())).toBe(true);
    expect(
      assertRuntimeOwnership(
        goodEvidence({ log: `${PRE_LOCK_EVIDENCE}\n[daemon stdout] listening on ${LEASED_PORT}` }),
      ),
    ).toBe(true);
  });

  test.each([
    ['missing marker', ''],
    [
      'foreign appData root',
      formatSmokePreLockPathEvidence({
        appData: '/tmp/foreign-smoke/electron-app-data',
        userData: SMOKE_USER_DATA,
      }),
    ],
    [
      'foreign userData path',
      formatSmokePreLockPathEvidence({
        appData: SMOKE_APP_DATA_ROOT,
        userData: '/tmp/foreign-smoke/Nuncio',
      }),
    ],
  ])('rejects %s pre-lock path evidence', (_label, log) => {
    expect(() => assertRuntimeOwnership(goodEvidence({ log }))).toThrow(/pre-lock path/i);
  });

  test.each([
    ['address already in use', '[daemon stderr] error: listen EADDRINUSE: address already in use'],
    ['unhandled promise rejection', '[main:err] Unhandled promise rejection: boom'],
    ['Node unhandledRejection spelling', '[main:err] unhandledRejection Error: boom'],
    ['Node UnhandledPromiseRejection spelling', '[main:err] UnhandledPromiseRejection: boom'],
    ['unexpected daemon exit', '[daemon exit] code=0 signal=null'],
    ['daemon restart after exit', '[daemon] unexpected exit; restarting (1/3)'],
    ['uncaught exception', '[main:err] Uncaught Exception: boom'],
    ['Electron main-process crash', 'A JavaScript error occurred in the main process'],
  ])('rejects %s evidence', (_label, log) => {
    expect(() =>
      assertRuntimeOwnership(goodEvidence({ log: `${PRE_LOCK_EVIDENCE}\n${log}` })),
    ).toThrow(/fatal runtime ownership evidence/i);
  });

  test('rejects Electron exit by code or signal and spawn errors', () => {
    expect(() =>
      assertRuntimeOwnership(goodEvidence({ electronExit: { code: 2, signal: null } })),
    ).toThrow('code=2');
    expect(() =>
      assertRuntimeOwnership(goodEvidence({ electronExit: { code: null, signal: 'SIGTERM' } })),
    ).toThrow('SIGTERM');
    expect(() =>
      assertRuntimeOwnership(goodEvidence({ spawnError: new Error('ENOENT') })),
    ).toThrow('ENOENT');
  });

  test.each([
    [null, false],
    [undefined, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [0, false],
    [-1, false],
    [1.5, false],
    [1, true],
    [65_535, true],
    [65_536, false],
  ])('validates TCP port boundary %p through public ownership behavior', (port, valid) => {
    const evidence = goodEvidence({
      expectedPort: port,
      rendererUrl: `http://127.0.0.1:${port}/`,
      persistedPort: port,
      health: goodHealth(port),
    });

    if (valid) {
      expect(assertRuntimeOwnership(evidence)).toBe(true);
    } else {
      expect(() => assertRuntimeOwnership(evidence)).toThrow(/invalid smoke daemon port/i);
    }
  });

  test.each([
    ['missing response', null],
    ['wrong status', { port: LEASED_PORT, statusCode: 503, body: goodHealth().body }],
    ['wrong port', goodHealth(FALLBACK_PORT)],
    ['missing body', { port: LEASED_PORT, statusCode: 200, body: null }],
    [
      'wrong status payload',
      {
        port: LEASED_PORT,
        statusCode: 200,
        body: { status: 'down', service: 'nuncio-server', smokeNonce: OWNERSHIP_NONCE },
      },
    ],
    [
      'foreign service',
      {
        port: LEASED_PORT,
        statusCode: 200,
        body: { status: 'ok', service: 'other-daemon', smokeNonce: OWNERSHIP_NONCE },
      },
    ],
  ])('rejects %s as ownership health evidence', (_label, health) => {
    expect(() => assertRuntimeOwnership(goodEvidence({ health }))).toThrow();
  });

  test.each([
    ['missing launch nonce', undefined],
    ['foreign launch nonce', 'b'.repeat(64)],
  ])('rejects a same-service foreign responder with %s', (_label, smokeNonce) => {
    const health = {
      port: LEASED_PORT,
      statusCode: 200,
      body: { status: 'ok', service: 'nuncio-server', ...(smokeNonce ? { smokeNonce } : {}) },
    };

    expect(() => assertRuntimeOwnership(goodEvidence({ health }))).toThrow(/nonce/i);
  });

  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['uppercase', 'A'.repeat(64)],
    ['Unicode', '工具'.repeat(32)],
    ['whitespace-padded', ` ${'a'.repeat(64)} `],
  ])('rejects %s expected nonce evidence', (_label, expectedNonce) => {
    expect(() => assertRuntimeOwnership(goodEvidence({ expectedNonce }))).toThrow(/nonce/i);
  });

  test.each([
    ['missing renderer URL', undefined],
    ['malformed renderer URL', 'not a url'],
    ['fallback renderer port', `http://127.0.0.1:${FALLBACK_PORT}/`],
    ['foreign renderer host', `http://localhost:${LEASED_PORT}/`],
    ['non-http renderer', `https://127.0.0.1:${LEASED_PORT}/`],
  ])('rejects %s', (_label, rendererUrl) => {
    expect(() => assertRuntimeOwnership(goodEvidence({ rendererUrl }))).toThrow(/renderer/i);
  });

  test.each([
    ['missing daemon-port evidence', undefined],
    ['zero daemon-port evidence', 0],
    ['fallback daemon-port evidence', FALLBACK_PORT],
    ['string daemon-port evidence', String(LEASED_PORT)],
  ])('rejects %s', (_label, persistedPort) => {
    expect(() => assertRuntimeOwnership(goodEvidence({ persistedPort }))).toThrow(/daemon-port/i);
  });
});
