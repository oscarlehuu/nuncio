import { describe, expect, it } from 'bun:test';
import {
  decodeJwtExpMs,
  decodeKeychainJson,
} from '../../../src/usage/usage-credentials';
import { clampPercent, formatUsd, titleCase } from '../../../src/usage/usage-parse';

describe('usage-credentials helpers', () => {
  it('decodes hex-encoded keychain JSON', () => {
    const payload = Buffer.from(JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }), 'utf8').toString(
      'hex',
    );
    const decoded = decodeKeychainJson(payload) as { claudeAiOauth: { accessToken: string } };
    expect(decoded.claudeAiOauth.accessToken).toBe('tok');
  });

  it('decodes JWT exp to epoch ms', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ exp: 1_700_000_000 })).toString('base64url');
    expect(decodeJwtExpMs(`${header}.${body}.sig`)).toBe(1_700_000_000_000);
  });
});

describe('usage-parse helpers', () => {
  it('clamps percents and formats usd', () => {
    expect(clampPercent(120)).toBe(100);
    expect(clampPercent(-5)).toBe(0);
    expect(formatUsd(5.39)).toContain('5.39');
    expect(titleCase('max_20x')).toBe('Max 20x');
  });
});
