'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clopAgent', {
  state: () => ipcRenderer.invoke('agent-state'),
  open: () => ipcRenderer.send('agent-open-main'),
  menu: () => ipcRenderer.send('agent-menu'),
  onCursor: (fn) => {
    const listener = (_event, value) => fn(value);
    ipcRenderer.on('agent-cursor', listener);
    return () => ipcRenderer.removeListener('agent-cursor', listener);
  },
  onNetwork: (fn) => {
    const listener = (_event, value) => fn(value);
    ipcRenderer.on('agent-network', listener);
    return () => ipcRenderer.removeListener('agent-network', listener);
  },
});
