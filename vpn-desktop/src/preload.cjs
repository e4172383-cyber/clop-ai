'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name) => (...args) => ipcRenderer.invoke(name, ...args);
contextBridge.exposeInMainWorld('clopVpn', {
  state: invoke('state'), login: invoke('login'), pollLogin: invoke('login-poll'), cancelLogin: invoke('login-cancel'),
  logout: invoke('logout'), connect: invoke('connect'), disconnect: invoke('disconnect'), refresh: invoke('refresh'),
  installDependency: invoke('install-dependency'), window: invoke('window'),
  onState: (fn) => { const listener = (_event, value) => fn(value); ipcRenderer.on('state-changed', listener); return () => ipcRenderer.removeListener('state-changed', listener); },
});
