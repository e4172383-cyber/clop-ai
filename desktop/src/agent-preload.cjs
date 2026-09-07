'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clopAgent', {
  state: () => ipcRenderer.invoke('agent-state'),
  open: () => ipcRenderer.send('agent-open-main'),
  menu: () => ipcRenderer.send('agent-menu'),
  dragStart: (point) => ipcRenderer.send('agent-drag-start', point),
  dragMove: (point) => ipcRenderer.send('agent-drag-move', point),
  dragEnd: () => ipcRenderer.send('agent-drag-end'),
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
  onTasks: (fn) => {
    const listener = (_event, value) => fn(value);
    ipcRenderer.on('agent-tasks', listener);
    return () => ipcRenderer.removeListener('agent-tasks', listener);
  },
});
