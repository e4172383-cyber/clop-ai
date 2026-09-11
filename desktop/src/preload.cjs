const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name) => (...args) => ipcRenderer.invoke(name, ...args);
contextBridge.exposeInMainWorld('clop', {
  state: invoke('state'), settings: invoke('settings'), acceptTerms: invoke('terms-accept'),
  setMode: invoke('mode'), pickFolder: invoke('folder'), files: invoke('files'), preview: invoke('preview'),
  responseFile: invoke('response-file'),
  cloudStorage: invoke('cloud-storage'), cloudUpload: invoke('cloud-upload'), cloudDownload: invoke('cloud-download'),
  cloudDelete: invoke('cloud-delete'), cloudOptimize: invoke('cloud-optimize'), cloudBackup: invoke('cloud-backup'),
  newChat: invoke('chat-new'), openChat: invoke('chat-open'), ask: invoke('ask'), retryAnswer: invoke('answer-retry'), stop: invoke('stop'),
  hint: invoke('hint'),
  login: invoke('login'), pollLogin: invoke('login-poll'), cancelLogin: invoke('login-cancel'),
  me: invoke('me'), bugs: invoke('bugs'), submitBug: invoke('bug-submit'), logout: invoke('logout'), approve: invoke('approve'),
  remoteDecision: invoke('remote-decision'), remoteStop: invoke('remote-stop'),
  attach: invoke('attach'), terminal: invoke('terminal'), backups: invoke('backups'),
  window: invoke('window'), external: invoke('external'), serviceLinks: invoke('service-links'),
  checkUpdate: invoke('update-check'), installUpdate: invoke('update-install'),
  ownProviders: invoke('own-providers'), ownProviderToggle: invoke('own-provider-toggle'),
  ownProviderLogin: invoke('own-provider-login'), ownProviderInstall: invoke('own-provider-install'),
  onEvent: (fn) => { const listener = (_e, data) => fn(data); ipcRenderer.on('event', listener); return () => ipcRenderer.removeListener('event', listener); }
});
