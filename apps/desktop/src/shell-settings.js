const fs = require('node:fs');
const path = require('node:path');

/**
 * Persistent shell (window/tray) settings for the desktop app.
 * Stored as JSON at <userData>/shell-settings.json:
 *   { closeToTray: boolean }
 *
 * closeToTray defaults ON: closing the window hides it to the menu-bar/tray so
 * the local daemon keeps running and paired phones stay connected. Only an
 * explicit strict `false` opts out — any other value falls back to the default
 * so a hand-edited or partial file never accidentally disables it.
 *
 * All functions are filesystem-defensive: a missing, corrupt, or unwritable
 * file leaves the app booting with in-memory defaults.
 */

const DEFAULT_SETTINGS = Object.freeze({ closeToTray: true });

/** Only strict boolean false disables close-to-tray; everything else defaults on. */
function normalizeCloseToTray(value) {
  return value === false ? false : true;
}

function loadSettings(filePath) {
  const fallback = { closeToTray: true };
  if (!filePath) return fallback;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;

  return { closeToTray: normalizeCloseToTray(parsed.closeToTray) };
}

function saveSettings(filePath, settings) {
  if (!filePath || !settings || typeof settings !== 'object') return false;
  const next = { closeToTray: normalizeCloseToTray(settings.closeToTray) };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  normalizeCloseToTray,
};
