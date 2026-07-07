const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  normalizeCloseToTray,
} = require('../src/shell-settings');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuncio-shell-settings-'));
  return { dir, file: path.join(dir, 'shell-settings.json') };
}

describe('shell-settings defaults', () => {
  test('DEFAULT_SETTINGS is close-to-tray on and frozen', () => {
    expect(DEFAULT_SETTINGS).toEqual({ closeToTray: true });
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
  });

  test('a null path (userData unavailable) yields the default in memory', () => {
    expect(loadSettings(null)).toEqual({ closeToTray: true });
  });

  test('a missing file yields the default', () => {
    const { dir, file } = tempFile();
    expect(loadSettings(file)).toEqual({ closeToTray: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('normalizeCloseToTray', () => {
  test('only strict false disables; anything else defaults on', () => {
    expect(normalizeCloseToTray(false)).toBe(false);
    expect(normalizeCloseToTray(true)).toBe(true);
    // Truthy-but-not-boolean and falsy-but-not-false all default ON.
    expect(normalizeCloseToTray(undefined)).toBe(true);
    expect(normalizeCloseToTray(null)).toBe(true);
    expect(normalizeCloseToTray(0)).toBe(true);
    expect(normalizeCloseToTray('false')).toBe(true);
    expect(normalizeCloseToTray(1)).toBe(true);
  });
});

describe('load fallbacks', () => {
  test('a corrupt (non-JSON) file yields the default', () => {
    const { dir, file } = tempFile();
    fs.writeFileSync(file, '{not json');
    expect(loadSettings(file)).toEqual({ closeToTray: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('JSON that is not an object (array/number/null) yields the default', () => {
    const { dir, file } = tempFile();
    for (const bad of ['[]', '42', 'null', '"x"']) {
      fs.writeFileSync(file, bad);
      expect(loadSettings(file)).toEqual({ closeToTray: true });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an object without closeToTray defaults on', () => {
    const { dir, file } = tempFile();
    fs.writeFileSync(file, JSON.stringify({ somethingElse: 1 }));
    expect(loadSettings(file)).toEqual({ closeToTray: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a non-boolean closeToTray is coerced (only strict false disables)', () => {
    const { dir, file } = tempFile();
    fs.writeFileSync(file, JSON.stringify({ closeToTray: 'false' }));
    expect(loadSettings(file)).toEqual({ closeToTray: true });
    fs.writeFileSync(file, JSON.stringify({ closeToTray: 0 }));
    expect(loadSettings(file)).toEqual({ closeToTray: true });
    fs.writeFileSync(file, JSON.stringify({ closeToTray: false }));
    expect(loadSettings(file)).toEqual({ closeToTray: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('save round-trip', () => {
  test('round-trips closeToTray both ways', () => {
    const { dir, file } = tempFile();
    expect(saveSettings(file, { closeToTray: false })).toBe(true);
    expect(loadSettings(file)).toEqual({ closeToTray: false });
    expect(saveSettings(file, { closeToTray: true })).toBe(true);
    expect(loadSettings(file)).toEqual({ closeToTray: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('save normalizes a non-boolean value before persisting', () => {
    const { dir, file } = tempFile();
    expect(saveSettings(file, { closeToTray: 'nope' })).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ closeToTray: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a null path or missing settings is a no-op returning false', () => {
    expect(saveSettings(null, { closeToTray: true })).toBe(false);
    const { dir, file } = tempFile();
    expect(saveSettings(file, null)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('persist failure (parent is a file) is non-fatal and returns false', () => {
    const parentFile = path.join(os.tmpdir(), `nuncio-shell-not-a-dir-${Date.now()}`);
    fs.writeFileSync(parentFile, 'x');
    const file = path.join(parentFile, 'shell-settings.json');
    expect(saveSettings(file, { closeToTray: false })).toBe(false);
    fs.rmSync(parentFile, { force: true });
  });
});
