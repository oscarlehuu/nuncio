const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nuncioDesktop', {
  marker: 'desktop',
  electron: process.versions.electron,
  notify: (payload) => ipcRenderer.invoke('nuncio:notify', payload),
  external: {
    open: (url) => ipcRenderer.invoke('external:open', url),
  },
  browser: {
    show: (payload) => ipcRenderer.invoke('browser:show', payload),
    navigate: (id, url) => ipcRenderer.invoke('browser:navigate', id, url),
    reload: (id) => ipcRenderer.invoke('browser:reload', id),
    resize: (id, bounds) => ipcRenderer.invoke('browser:resize', id, bounds),
    hide: (id) => ipcRenderer.invoke('browser:hide', id),
  },
  servers: {
    list: () => ipcRenderer.invoke('servers:list'),
    connect: (target) => ipcRenderer.invoke('servers:connect', target),
  },
  terminal: {
    create: (payload) => ipcRenderer.invoke('terminal:create', payload),
    write: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    kill: (id) => ipcRenderer.invoke('terminal:kill', id),
    onData: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on('terminal:data', listener);
      return () => ipcRenderer.removeListener('terminal:data', listener);
    },
    onExit: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on('terminal:exit', listener);
      return () => ipcRenderer.removeListener('terminal:exit', listener);
    },
  },
});
