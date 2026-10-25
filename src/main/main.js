'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { ConfigStore } = require('./config');
const { Poller } = require('./poller');
const { sshExec } = require('./ssh');
const { stackUp, stackDown, stackStatus, GRAFANA_URL } = require('./docker');
const { GrafanaView } = require('./grafana-view');
const { discoverLogs } = require('./discovery');
const { validateServer, toSlug } = require('./validate');

const userData = app.getPath('userData');
// Not under AppData: when the app is started by a packaged (MSIX) Windows app,
// AppData writes are redirected to a private copy that Docker never sees.
const logsDir = path.join(app.getPath('home'), 'LogAnalyzer', 'logs');
const stackDir = app.isPackaged ? path.join(process.resourcesPath, 'stack') : path.join(__dirname, '..', '..', 'stack');

const store = new ConfigStore(path.join(userData, 'config.json'));
const poller = new Poller({
  getConfig: () => store.get(),
  logsDir,
  stateFile: path.join(userData, 'offsets.json'),
  tempDir: app.getPath('temp'),
});

let window = null;
let grafana = null;
const send = (channel, payload) => window?.webContents.send(channel, payload);
poller.on('status', (status) => send('poll-status', status));
poller.on('activity', (message) => send('activity', { at: new Date().toISOString(), message }));

const cleanList = (values) => [...new Set((values ?? []).map((v) => String(v).trim().replace(/(.)\/+$/, '$1')).filter(Boolean))];

// Also upgrades v0.1 servers, which had `target: "user@ip"` and a list of files.
const normalizeServer = (input) => {
  const [legacyUser, legacyHost] = String(input.target ?? '').split('@');
  const host = String(input.host ?? legacyHost ?? '').trim();
  const legacyDirs = (input.paths ?? []).map((p) => path.posix.dirname(String(p)));
  return {
    id: input.id || undefined,
    name: String(input.name ?? '').trim() || host,
    user: String(input.user ?? legacyUser ?? '').trim(),
    host,
    port: Number(input.port) || 22,
    identityFile: String(input.identityFile ?? '').trim(),
    // Tail sends only new bytes in one session per poll: the lightest load on the server.
    mode: input.mode === 'scp' ? 'scp' : 'tail',
    enabled: input.enabled !== false,
    logDirs: cleanList(input.logDirs ?? legacyDirs),
  };
};

for (const server of store.get().servers) store.upsertServer(normalizeServer(server));

const handlers = {
  'config:get': () => ({
    ...store.get(),
    running: poller.running,
    logsDir,
    grafanaUrl: GRAFANA_URL,
    discovery: Object.fromEntries(store.get().servers.map((s) => [s.id, poller.discoveryFor(s.id)])),
  }),

  'settings:save': (_event, settings) => {
    store.setSettings(settings);
    poller.restart();
    return store.get();
  },

  'server:save': (_event, input) => {
    const server = normalizeServer(input);
    const errors = validateServer(server);
    const clash = store.get().servers.find((s) => s.id !== server.id && toSlug(s.name) === toSlug(server.name));
    if (clash) errors.push(`Another server is already called "${clash.name}".`);
    if (errors.length > 0) return { ok: false, errors };
    const saved = store.upsertServer(server);
    poller.rescan(saved.id);
    if (poller.running) poller.tick();
    return { ok: true, server: saved };
  },

  'server:delete': (_event, id) => {
    store.deleteServer(id);
    poller.forget(id);
    return { ok: true };
  },

  'server:test': async (_event, input) => {
    const server = normalizeServer(input);
    const result = await sshExec(server, 'echo connected; uname -sn', { timeoutMs: 20_000 });
    return { ok: result.code === 0, output: result.code === 0 ? result.stdout.toString('utf8').trim() : result.stderr };
  },

  // Preview of what polling would ship from the log directory, before saving.
  'server:scan': async (_event, input) => {
    const server = normalizeServer(input);
    const errors = validateServer(server);
    if (errors.length > 0) return { ok: false, output: errors.join('\n') };
    try {
      return { ok: true, ...(await discoverLogs(server)) };
    } catch (error) {
      return { ok: false, output: error.message };
    }
  },

  'poller:start': () => (poller.start(), true),
  'poller:stop': () => (poller.stop(), false),
  'poller:now': () => (poller.tick(), poller.running),

  'stack:up': () => stackUp(stackDir, logsDir),
  'stack:down': () => stackDown(stackDir, logsDir),
  'stack:status': () => stackStatus(stackDir, logsDir),

  'open:grafana': () => shell.openExternal(GRAFANA_URL),
  'grafana:show': (_event, bounds) => grafana?.show(bounds),
  'grafana:hide': () => grafana?.hide(),
  'grafana:reload': () => grafana?.reload(),
  'open:logs': () => shell.openPath(logsDir),

  'dialog:key': async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose SSH private key',
      defaultPath: path.join(app.getPath('home'), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
    });
    return result.canceled ? null : result.filePaths[0];
  },
};

const createWindow = () => {
  window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Log Analyzer',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  grafana = new GrafanaView({ window, url: GRAFANA_URL, onState: (state) => send('grafana-state', state) });
  window.on('closed', () => {
    grafana.destroy();
    grafana = null;
    window = null;
  });
};

app.whenReady().then(() => {
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);
  createWindow();
  if (store.get().autoStart) poller.start();
});

app.on('window-all-closed', () => {
  poller.stop();
  app.quit();
});
