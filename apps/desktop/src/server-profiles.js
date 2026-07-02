const fs = require('node:fs');
const path = require('node:path');

/**
 * Persistent server-connection profiles for the desktop shell.
 * Stored as JSON at <userData>/servers.json:
 *   { lastUsed: 'local' | '<url>', servers: [{ name, url }] }
 * All functions are pure or filesystem-defensive so the shell keeps booting
 * (with in-memory defaults) when the file is missing, corrupt, or unwritable.
 */

const DEFAULT_PROFILES = Object.freeze({ lastUsed: 'local', servers: [] });

function normalizeServerUrl(input) {
  const value = typeof input === 'string' ? input.trim() : '';
  if (!value) return null;

  const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value) ? value : `http://${value}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    return null;
  }
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return url.origin + pathname;
}

function serverNameFromUrl(url) {
  try {
    return new URL(url).hostname.split('.')[0] || url;
  } catch {
    return url;
  }
}

function loadProfiles(filePath) {
  const fallback = { lastUsed: 'local', servers: [] };
  if (!filePath) return fallback;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object') return fallback;

  const servers = (Array.isArray(parsed.servers) ? parsed.servers : [])
    .map((entry) => {
      const url = normalizeServerUrl(entry?.url);
      if (!url) return null;
      const name = typeof entry?.name === 'string' && entry.name ? entry.name : serverNameFromUrl(url);
      return { name, url };
    })
    .filter(Boolean);

  const lastUsed =
    parsed.lastUsed === 'local' ? 'local' : (normalizeServerUrl(parsed.lastUsed) ?? 'local');

  return { lastUsed, servers };
}

function saveProfiles(filePath, profiles) {
  if (!filePath || !profiles) return false;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(profiles, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Adds or replaces a server (deduped by normalized url). Returns a new profiles object. */
function upsertServer(profiles, url, name) {
  const normalized = normalizeServerUrl(url);
  const base = profiles && typeof profiles === 'object' ? profiles : { lastUsed: 'local', servers: [] };
  if (!normalized) return base;

  const servers = (base.servers ?? []).filter((entry) => entry.url !== normalized);
  servers.push({ name: name || serverNameFromUrl(normalized), url: normalized });
  return { ...base, servers };
}

module.exports = {
  DEFAULT_PROFILES,
  loadProfiles,
  normalizeServerUrl,
  saveProfiles,
  serverNameFromUrl,
  upsertServer,
};
