const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  fitBoundsToWorkArea,
  loadWindowState,
  manageWindowState,
  restoreWindowState,
  saveWindowState,
} = require('../src/window-state');

const minimums = { minWidth: 960, minHeight: 640 };

function tempStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuncio-window-state-'));
  return { dir, file: path.join(dir, 'window-state.json') };
}

describe('window state persistence', () => {
  test('missing, corrupt, and malformed state files are ignored', () => {
    const { dir, file } = tempStateFile();
    try {
      expect(loadWindowState(null)).toBeNull();
      expect(loadWindowState(file)).toBeNull();

      for (const invalid of [
        '{bad json',
        'null',
        '[]',
        JSON.stringify({ bounds: { x: 0, y: 0, width: 0, height: 700 } }),
        JSON.stringify({ bounds: { x: Number.MAX_VALUE, y: 0, width: Infinity, height: 700 } }),
      ]) {
        fs.writeFileSync(file, invalid);
        expect(loadWindowState(file)).toBeNull();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rounds finite geometry, accepts negative display coordinates, and requires strict maximized true', () => {
    const { dir, file } = tempStateFile();
    try {
      fs.writeFileSync(file, JSON.stringify({
        bounds: { x: -1439.6, y: 20.4, width: 1100.5, height: 719.5 },
        maximized: 'true',
      }));
      expect(loadWindowState(file)).toEqual({
        bounds: { x: -1440, y: 20, width: 1101, height: 720 },
        maximized: false,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('saves and reloads normal bounds plus maximized state', () => {
    expect(typeof saveWindowState).toBe('function');
    const { dir, file } = tempStateFile();
    try {
      const state = {
        bounds: { x: 120, y: 80, width: 1100, height: 720 },
        maximized: true,
      };
      expect(saveWindowState(file, state)).toBe(true);
      expect(loadWindowState(file)).toEqual(state);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a persistence failure is non-fatal', () => {
    expect(typeof saveWindowState).toBe('function');
    const parentFile = path.join(os.tmpdir(), `nuncio-window-parent-${Date.now()}`);
    fs.writeFileSync(parentFile, 'not a directory');
    try {
      expect(saveWindowState(path.join(parentFile, 'window-state.json'), {
        bounds: { x: 0, y: 0, width: 1280, height: 900 },
        maximized: false,
      })).toBe(false);
    } finally {
      fs.rmSync(parentFile, { force: true });
    }
  });
});

describe('display-safe restoration', () => {
  test('keeps valid bounds unchanged on a negative-origin display', () => {
    const bounds = { x: -1400, y: 40, width: 1100, height: 720 };
    expect(fitBoundsToWorkArea(
      bounds,
      { x: -1440, y: 0, width: 1440, height: 900 },
      minimums,
    )).toEqual(bounds);
  });

  test('re-homes removed-monitor bounds inside the selected current work area', () => {
    expect(fitBoundsToWorkArea(
      { x: 4000, y: 2000, width: 1100, height: 720 },
      { x: 0, y: 0, width: 1920, height: 1080 },
      minimums,
    )).toEqual({ x: 820, y: 360, width: 1100, height: 720 });
  });

  test('shrinks oversized bounds and pins below-minimum work areas at their origin', () => {
    expect(fitBoundsToWorkArea(
      { x: -100, y: -100, width: 3000, height: 2000 },
      { x: 10, y: 20, width: 1600, height: 1000 },
      minimums,
    )).toEqual({ x: 10, y: 20, width: 1600, height: 1000 });

    expect(fitBoundsToWorkArea(
      { x: 900, y: 700, width: 1200, height: 800 },
      { x: 10, y: 20, width: 800, height: 500 },
      minimums,
    )).toEqual({ x: 10, y: 20, width: 960, height: 640 });
  });

  test('falls back to defaults when display lookup is unavailable', () => {
    const { dir, file } = tempStateFile();
    try {
      fs.writeFileSync(file, JSON.stringify({
        bounds: { x: 120, y: 80, width: 1100, height: 720 },
        maximized: true,
      }));
      expect(restoreWindowState(
        file,
        { getDisplayMatching: () => { throw new Error('screen unavailable'); } },
        { width: 1280, height: 900 },
        minimums,
      )).toEqual({ bounds: { width: 1280, height: 900 }, maximized: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('window lifecycle tracking', () => {
  test('coalesces geometry writes and flushes normal bounds on state changes and close', () => {
    expect(typeof manageWindowState).toBe('function');

    const handlers = new Map();
    const win = {
      bounds: { x: 140, y: 90, width: 1120, height: 760 },
      maximized: false,
      minimized: false,
      on(eventName, handler) {
        const listeners = handlers.get(eventName) ?? new Set();
        listeners.add(handler);
        handlers.set(eventName, listeners);
      },
      removeListener(eventName, handler) {
        handlers.get(eventName)?.delete(handler);
      },
      emit(eventName) {
        for (const handler of handlers.get(eventName) ?? []) handler();
      },
      getNormalBounds() {
        return { ...this.bounds };
      },
      isMaximized() {
        return this.maximized;
      },
      isMinimized() {
        return this.minimized;
      },
    };

    let nextTimerId = 0;
    const timers = new Map();
    const writes = [];
    const manager = manageWindowState(win, '/window-state.json', {
      save: (_filePath, state) => {
        writes.push(state);
        return true;
      },
      setTimer: (callback) => {
        nextTimerId += 1;
        timers.set(nextTimerId, callback);
        return nextTimerId;
      },
      clearTimer: (timerId) => timers.delete(timerId),
    });

    win.emit('move');
    win.bounds = { x: 180, y: 120, width: 1180, height: 780 };
    win.emit('resize');
    expect(writes).toHaveLength(0);
    expect(timers.size).toBe(1);
    const pending = [...timers.values()][0];
    timers.clear();
    pending();
    expect(writes).toEqual([{
      bounds: { x: 180, y: 120, width: 1180, height: 780 },
      maximized: false,
    }]);

    win.maximized = true;
    win.emit('maximize');
    expect(writes.at(-1)).toEqual({
      bounds: { x: 180, y: 120, width: 1180, height: 780 },
      maximized: true,
    });

    win.minimized = true;
    win.maximized = false;
    win.emit('minimize');
    win.emit('close');
    expect(writes.at(-1)).toEqual({
      bounds: { x: 180, y: 120, width: 1180, height: 780 },
      maximized: true,
    });

    win.minimized = false;
    win.maximized = false;
    win.emit('unmaximize');
    win.bounds = { x: 220, y: 160, width: 1200, height: 800 };
    win.emit('move');
    expect(timers.size).toBe(1);
    win.emit('close');
    expect(timers.size).toBe(0);
    expect(writes.at(-1)).toEqual({
      bounds: { x: 220, y: 160, width: 1200, height: 800 },
      maximized: false,
    });

    const writesBeforeDispose = writes.length;
    manager.dispose();
    win.emit('resize');
    expect(writes).toHaveLength(writesBeforeDispose);
  });
});
