const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('nuncioDesktop', {
  marker: 'desktop',
  electron: process.versions.electron,
});
