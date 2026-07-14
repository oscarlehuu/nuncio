'use strict';

/**
 * Normalize a user-entered browser address for Electron loadURL.
 *
 * Important: `localhost:5173` must NOT be treated as a URI scheme. The naive
 * `/^[a-z]+:/` check matches it and leaves Electron unable to load the page.
 * Loopback hosts default to http; public hosts default to https.
 *
 * @param {unknown} url
 * @returns {string}
 */
function isLoopbackHostToken(hostToken) {
  const h = String(hostToken || '')
    .trim()
    .toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h.startsWith('localhost:') || h.endsWith('.localhost')) return true;
  if (h === '127.0.0.1' || h.startsWith('127.0.0.1:')) return true;
  if (h === '0.0.0.0' || h.startsWith('0.0.0.0:')) return true;
  if (h === '::1' || h.startsWith('::1:') || h === '[::1]' || h.startsWith('[::1]:')) return true;
  return false;
}

function normalizeBrowserUrl(url) {
  const value = typeof url === 'string' ? url.trim() : '';
  if (!value) return '';

  // Already a real scheme with authority (http://…, https://…, file://…).
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value)) return value;
  // Special single-word schemes Electron may load without //.
  if (/^(about:|data:|chrome:|chrome-error:)/i.test(value)) return value;

  let bare = value.replace(/^\/+/, '');
  // Bare IPv6 loopback needs brackets for URL parsers.
  if (bare === '::1' || bare.startsWith('::1/') || bare.startsWith('::1:')) {
    bare = bare.replace(/^::1/, '[::1]');
  }

  const hostToken = bare.split('/')[0] || '';
  const scheme = isLoopbackHostToken(hostToken) ? 'http' : 'https';
  return `${scheme}://${bare}`;
}

module.exports = { normalizeBrowserUrl, isLoopbackHostToken };
