/**
 * Minimal Chrome DevTools Protocol client for the packaged-desktop boot smoke.
 *
 * The packaged app ships an Electron whose Chromium outpaces the Chromium the
 * stable playwright-core bundles, so Playwright's `_electron`/`connectOverCDP`
 * hang on its CDP handshake. These helpers speak only stable Protocol 1.3 over
 * the HTTP target list + a target WebSocket, which is version-independent.
 */
import http from 'node:http';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GET a CDP HTTP JSON endpoint (e.g. /json/list) on the debugging port. */
export function cdpJson(port, path) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path, timeout: 1_500 }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('cdp json request timed out'));
    });
  });
}

/**
 * Poll /json/list until the app-shell page target appears: a `page` whose URL is
 * the loopback daemon (http://127.0.0.1:<port>/) with an attachable websocket.
 */
export async function waitForAppPageTarget(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await cdpJson(port, '/json/list');
      const page = targets.find(
        (t) =>
          t.type === 'page' &&
          /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url || '') &&
          t.webSocketDebuggerUrl,
      );
      if (page) return page;
    } catch {
      // endpoint not ready yet
    }
    await sleep(400);
  }
  throw new Error('no app-shell page target appeared over CDP (window never loaded the daemon)');
}

/** Connect to a target's websocket. Only needs request/response correlated by id. */
export function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error('CDP websocket failed to open'));
  });
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { ready, send, close: () => socket.close() };
}
