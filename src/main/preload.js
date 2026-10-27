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
  stopServer: invoke('server:stop'),
  startServer: invoke('server:start'),
  onPurgeStatus: subscribe('purge-status'),
  testServer: invoke('server:test'),
  scanServer: invoke('server:scan'),
  startPolling: invoke('poller:start'),
  stopPolling: invoke('poller:stop'),
  pollNow: invoke('poller:now'),
  stackUp: invoke('stack:up'),
  stackDown: invoke('stack:down'),
  stackStatus: invoke('stack:status'),
  openGrafana: invoke('open:grafana'),
  showGrafana: invoke('grafana:show'),
  hideGrafana: invoke('grafana:hide'),
  reloadGrafana: invoke('grafana:reload'),
  openGrafanaPage: invoke('grafana:open'),
  onGrafanaState: subscribe('grafana-state'),
  openLogs: invoke('open:logs'),
  pickKey: invoke('dialog:key'),
  onPollStatus: subscribe('poll-status'),
  onPollProgress: subscribe('poll-progress'),
  onActivity: subscribe('activity'),
});
