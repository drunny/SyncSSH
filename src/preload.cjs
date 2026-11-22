
const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (name, ...args) => {
  const reply = await ipcRenderer.invoke(name, ...args);
  if (reply.error) throw new Error(reply.error);
  return reply.result;
};
const methods = ['initialize', 'account', 'settings', 'configure', 'sync', 'group-save', 'server-get',
  'server-save', 'import-key', 'delete-record', 'note-save', 'image-get', 'resolve-record', 'pins',
  'forget-pin', 'trust-response', 'copy-text', 'app-info', 'open-repository', 'pick-background', 'note-export', 'dav-test', 'server-test', 'server-copy', 'server-move', 'monitor-list', 'monitor-path', 'monitor-enable', 'monitor-disable', 'connect', 'disconnect', 'files', 'upload', 'download'];
const signals = ['input', 'ack', 'resize', 'request-close', 'force-close'];
const events = ['state', 'output', 'closed', 'before-close', 'trust-request', 'trust-expired', 'metric'];
contextBridge.exposeInMainWorld('syncssh', {
  ...Object.fromEntries(methods.map((name) => [name, (...args) => invoke(name, ...args)])),
  ...Object.fromEntries(signals.map((name) => [name, (...args) => ipcRenderer.send(name, ...args)])),
  on(name, callback) {
    if (events.includes(name)) ipcRenderer.on(name, (_event, payload) => callback(payload));
  }
});
