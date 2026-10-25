'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { fetchNewLines } = require('./fetcher');
const { discoverLogs } = require('./discovery');
const { readJson, writeJson } = require('./config');
const { toSlug, remotePathToFileName } = require('./validate');

// The directory listing is far heavier than reading a few new bytes, so it is
// refreshed every few minutes rather than on every poll.
const RESCAN_MS = 5 * 60 * 1000;

// v0.1 stored the offsets map at the top level of the state file.
const loadState = (file) => {
  const raw = readJson(file, {});
  return raw.offsets ? { offsets: raw.offsets, discovered: raw.discovered ?? {} } : { offsets: raw, discovered: {} };
};

// Pulls every enabled server on a fixed interval and appends new lines to
// <logsDir>/<server>/<file>.log, which Alloy tails into Loki.
// Emits "status" per server and "activity" for the human-readable log.
class Poller extends EventEmitter {
  constructor({ getConfig, logsDir, stateFile, tempDir }) {
    super();
    this.getConfig = getConfig;
    this.logsDir = logsDir;
    this.stateFile = stateFile;
    this.tempDir = tempDir;
    // offsets[serverId][remotePath] = bytes of that remote file already ingested
    // discovered[serverId] = { at, kept: [{ path, size, mtime }], skipped: [{ path, reason }] }
    const state = loadState(stateFile);
    this.offsets = state.offsets;
    this.discovered = state.discovered;
    this.busy = new Set();
    this.timer = null;
  }

  get running() {
    return this.timer !== null;
  }

  start() {
    if (this.running) return;
    const { pollSeconds } = this.getConfig();
    this.timer = setInterval(() => this.tick(), pollSeconds * 1000);
    this.emit('activity', `Polling every ${pollSeconds}s`);
    this.tick();
  }

  stop() {
    if (!this.running) return;
    clearInterval(this.timer);
    this.timer = null;
    this.emit('activity', 'Polling stopped');
  }

  restart() {
    if (!this.running) return;
    this.stop();
    this.start();
  }

  forget(serverId) {
    delete this.offsets[serverId];
    delete this.discovered[serverId];
    this.saveState();
  }

  // Called after a server is edited: its directories may have changed.
  rescan(serverId) {
    delete this.discovered[serverId];
    this.saveState();
  }

  discoveryFor(serverId) {
    return this.discovered[serverId] ?? null;
  }

  saveState() {
    writeJson(this.stateFile, { offsets: this.offsets, discovered: this.discovered });
  }

  tick() {
    for (const server of this.getConfig().servers) {
      // A slow server must not pile up overlapping pulls; it simply skips a beat.
      if (server.enabled === false || this.busy.has(server.id)) continue;
      this.busy.add(server.id);
      this.pollServer(server).finally(() => this.busy.delete(server.id));
    }
  }

  async refreshDiscovery(server) {
    const previous = this.discovered[server.id];
    if (previous && Date.now() - new Date(previous.at).getTime() < RESCAN_MS) return previous;

    const found = await discoverLogs(server);
    this.discovered[server.id] = found;
    const before = new Set(previous?.kept.map((f) => f.path) ?? []);
    const added = found.kept.filter((f) => !before.has(f.path));
    if (added.length > 0) {
      this.emit('activity', `${server.name}: watching ${added.map((f) => f.path).join(', ')}`);
    }
    return found;
  }

  async pollServer(server) {
    let discovery;
    try {
      discovery = await this.refreshDiscovery(server);
    } catch (error) {
      this.reportStatus(server, { errors: [`scan: ${error.message}`], bytes: 0 });
      return;
    }

    const serverDir = path.join(this.logsDir, toSlug(server.name));
    await fs.mkdir(serverDir, { recursive: true });
    const known = this.offsets[server.id] ?? {};
    const files = discovery.kept.map((f) => ({ path: f.path, offset: known[f.path] ?? -1 }));
    const errors = [];
    let bytes = 0;

    // Only offsets of files still being watched are kept, so state stays small.
    const offsets = {};
    let results = [];
    try {
      results = files.length > 0 ? await fetchNewLines(server, files, this.tempDir) : [];
    } catch (error) {
      errors.push(error.message);
      results = files.map(() => ({ error: null }));
    }

    for (const [index, file] of files.entries()) {
      const result = results[index] ?? {};
      if (result.error !== undefined) {
        if (result.error) errors.push(`${file.path}: ${result.error}`);
        if (file.offset >= 0) offsets[file.path] = file.offset;
        continue;
      }
      if (result.data.length > 0) {
        await fs.appendFile(path.join(serverDir, remotePathToFileName(file.path)), result.data);
        bytes += result.data.length;
      }
      offsets[file.path] = result.offset;
    }

    this.offsets[server.id] = offsets;
    this.saveState();
    this.reportStatus(server, { errors, bytes, discovery });
  }

  reportStatus(server, { errors, bytes, discovery }) {
    this.emit('status', {
      serverId: server.id,
      at: new Date().toISOString(),
      ok: errors.length === 0,
      bytes,
      errors,
      watching: discovery?.kept.length ?? 0,
      skipped: discovery?.skipped.length ?? 0,
    });
    if (bytes > 0) this.emit('activity', `${server.name}: +${formatBytes(bytes)}`);
    for (const error of errors) this.emit('activity', `${server.name}: ${error}`);
  }
}

const formatBytes = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

module.exports = { Poller, RESCAN_MS };
