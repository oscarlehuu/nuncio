const { describe, expect, test } = require('bun:test');
const { normalizeBrowserUrl } = require('../src/browser-url');

describe('normalizeBrowserUrl', () => {
  test('keeps explicit http/https URLs', () => {
    expect(normalizeBrowserUrl('http://localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeBrowserUrl('https://example.com/path')).toBe('https://example.com/path');
  });

  test('treats localhost:port as http, not a custom scheme', () => {
    expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeBrowserUrl('localhost:3000/app')).toBe('http://localhost:3000/app');
    expect(normalizeBrowserUrl('127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(normalizeBrowserUrl('::1')).toBe('http://[::1]');
  });

  test('defaults public hosts to https', () => {
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com');
    expect(normalizeBrowserUrl('example.com/docs')).toBe('https://example.com/docs');
  });

  test('returns empty for blank input', () => {
    expect(normalizeBrowserUrl('')).toBe('');
    expect(normalizeBrowserUrl('   ')).toBe('');
    expect(normalizeBrowserUrl(null)).toBe('');
  });
});
