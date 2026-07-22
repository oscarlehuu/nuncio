import { describe, expect, test } from 'bun:test';
import { buildHealthResponse } from '../../../src/health/health.controller';

describe('HealthController smoke ownership identity', () => {
  test('keeps the normal health response byte-shape compatible without a smoke nonce', () => {
    expect(buildHealthResponse({})).toEqual({
      status: 'ok',
      service: 'nuncio-server',
    });
  });

  test('exposes a valid per-run smoke nonce only on the smoke daemon health response', () => {
    const smokeNonce = 'a'.repeat(64);

    expect(buildHealthResponse({ NUNCIO_DESKTOP_SMOKE_NONCE: smokeNonce })).toEqual({
      status: 'ok',
      service: 'nuncio-server',
      smokeNonce,
    });
  });

  test.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['uppercase', 'A'.repeat(64)],
    ['Unicode', '工具'.repeat(32)],
  ])('does not expose a malformed %s smoke nonce', (_label, malformedNonce) => {
    expect(buildHealthResponse({ NUNCIO_DESKTOP_SMOKE_NONCE: malformedNonce })).toEqual({
      status: 'ok',
      service: 'nuncio-server',
    });
  });
});
