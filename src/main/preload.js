'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = (channel) => (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  getConfig: invoke('config:get'),
  saveSettings: invoke('settings:save'),
  saveServer: invoke('server:save'),
  deleteServer: invoke('server:delete'),
  testServer: invoke('server:test'),
  browseServer: invoke('server:browse'),
  startPolling: invoke('poller:start'),
  stopPolling: invoke('poller:stop'),
  pollNow: invoke('poller:now'),
  stackUp: invoke('stack:up'),
  stackDown: invoke('stack:down'),
  stackStatus: invoke('stack:status'),
  openGrafana: invoke('open:grafana'),
  openLogs: invoke('open:logs'),
  pickKey: invoke('dialog:key'),
  onPollStatus: subscribe('poll-status'),
  onActivity: subscribe('activity'),
});
