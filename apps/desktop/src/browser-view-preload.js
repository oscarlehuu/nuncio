'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Bridge for the embedded BrowserView guest page (Design Mode picker).
 * Chat/composer lives in the React shell (BrowserView cannot host reliable overlays
 * on CSP-locked sites like Google).
 */
contextBridge.exposeInMainWorld('__nuncioDesignModeBridge', {
  reportPick(payload) {
    ipcRenderer.send('browser:design-mode-guest-pick', payload);
  },
  exitDesignMode() {
    ipcRenderer.send('browser:design-mode-guest-exit');
  },
});
