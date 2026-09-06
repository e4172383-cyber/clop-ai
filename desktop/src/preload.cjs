const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name) => (...args) => ipcRenderer.invoke(name, ...args);
contextBridge.exposeInMainWorld('clop', {
  state: invoke('state'), settings: invoke('settings'), acceptTerms: invoke('terms-accept'),
  setMode: invoke('mode'), pickFolder: invoke('folder'), files: invoke('files'), preview: invoke('preview'),
  responseFile: invoke('response-file'),
  newChat: invoke('chat-new'), openChat: invoke('chat-open'), ask: invoke('ask'), retryAnswer: invoke('answer-retry'), stop: invoke('stop'),
  login: invoke('login'), pollLogin: invoke('login-poll'), cancelLogin: invoke('login-cancel'),
  me: invoke('me'), logout: invoke('logout'), approve: invoke('approve'),
  attach: invoke('attach'), terminal: invoke('terminal'), backups: invoke('backups'),
  window: invoke('window'), external: invoke('external'),
  onEvent: (fn) => { const listener = (_e, data) => fn(data); ipcRenderer.on('event', listener); return () => ipcRenderer.removeListener('event', listener); }
});
