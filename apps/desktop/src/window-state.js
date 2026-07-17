const fs = require('node:fs');
const path = require('node:path');

function finiteInteger(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

function normalizeBounds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const x = finiteInteger(value.x);
  const y = finiteInteger(value.y);
  const width = finiteInteger(value.width);
  const height = finiteInteger(value.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function loadWindowState(filePath) {
  if (!filePath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const bounds = normalizeBounds(parsed?.bounds);
    if (!bounds) return null;
    return { bounds, maximized: parsed.maximized === true };
  } catch {
    return null;
  }
}

function saveWindowState(filePath, state) {
  const bounds = normalizeBounds(state?.bounds);
  if (!filePath || !bounds) return false;

  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(temporaryPath, `${JSON.stringify({
      bounds,
      maximized: state.maximized === true,
    }, null, 2)}\n`);
    fs.renameSync(temporaryPath, filePath);
    return true;
  } catch {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // A failed cleanup cannot make window-state persistence fatal.
    }
    return false;
  }
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function fitBoundsToWorkArea(bounds, workArea, { minWidth, minHeight }) {
  const saved = normalizeBounds(bounds);
  const area = normalizeBounds(workArea);
  if (!saved || !area) return null;

  const width = area.width >= minWidth
    ? clamp(saved.width, minWidth, area.width)
    : minWidth;
  const height = area.height >= minHeight
    ? clamp(saved.height, minHeight, area.height)
    : minHeight;
  const x = area.width >= width
    ? clamp(saved.x, area.x, area.x + area.width - width)
    : area.x;
  const y = area.height >= height
    ? clamp(saved.y, area.y, area.y + area.height - height)
    : area.y;

  return { x, y, width, height };
}

function restoreWindowState(filePath, screenApi, defaultBounds, minimums) {
  const fallback = { bounds: { ...defaultBounds }, maximized: false };
  const saved = loadWindowState(filePath);
  if (!saved || typeof screenApi?.getDisplayMatching !== 'function') return fallback;

  try {
    const display = screenApi.getDisplayMatching(saved.bounds);
    const bounds = fitBoundsToWorkArea(saved.bounds, display?.workArea, minimums);
    return bounds ? { bounds, maximized: saved.maximized } : fallback;
  } catch {
    return fallback;
  }
}

function manageWindowState(win, filePath, options = {}) {
  const save = options.save ?? saveWindowState;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const debounceMs = options.debounceMs ?? 250;
  let timer = null;
  let disposed = false;
  let lastNonMinimizedMaximized = false;

  try {
    lastNonMinimizedMaximized = win.isMaximized() === true;
  } catch {
    // The default normal state is safe if the native window is unavailable.
  }

  function cancelPending() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function persist() {
    if (disposed) return false;
    try {
      const bounds = normalizeBounds(win.getNormalBounds());
      if (!bounds) return false;
      const minimized = typeof win.isMinimized === 'function'
        && win.isMinimized() === true;
      if (!minimized) {
        lastNonMinimizedMaximized = win.isMaximized() === true;
      }
      return save(filePath, {
        bounds,
        maximized: lastNonMinimizedMaximized,
      });
    } catch {
      return false;
    }
  }

  function flush() {
    cancelPending();
    return persist();
  }

  function schedule() {
    if (disposed) return;
    cancelPending();
    timer = setTimer(() => {
      timer = null;
      persist();
    }, debounceMs);
  }

  const listeners = [
    ['move', schedule],
    ['resize', schedule],
    ['maximize', flush],
    ['unmaximize', flush],
    ['minimize', flush],
    ['restore', flush],
    ['close', flush],
  ];
  for (const [eventName, listener] of listeners) win.on(eventName, listener);

  function dispose() {
    if (disposed) return;
    cancelPending();
    disposed = true;
    for (const [eventName, listener] of listeners) {
      win.removeListener?.(eventName, listener);
    }
  }

  return { dispose, flush };
}

module.exports = {
  fitBoundsToWorkArea,
  loadWindowState,
  manageWindowState,
  normalizeBounds,
  restoreWindowState,
  saveWindowState,
};
