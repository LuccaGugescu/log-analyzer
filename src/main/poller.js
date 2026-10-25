'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { fetchNewLines } = require('./fetcher');
const { readJson, writeJson } = require('./config');
const { toSlug, remotePathToFileName } = require('./validate');

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
    this.offsets = readJson(stateFile, {});
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
    writeJson(this.stateFile, this.offsets);
  }

  tick() {
    for (const server of this.getConfig().servers) {
      // A slow server must not pile up overlapping pulls; it simply skips a beat.
      if (server.enabled === false || this.busy.has(server.id)) continue;
      this.busy.add(server.id);
      this.pollServer(server).finally(() => this.busy.delete(server.id));
    }
  }

  async pollServer(server) {
    const serverDir = path.join(this.logsDir, toSlug(server.name));
    await fs.mkdir(serverDir, { recursive: true });
    const offsets = (this.offsets[server.id] ??= {});
    const errors = [];
    let bytes = 0;

    for (const remotePath of server.paths) {
      try {
        const result = await fetchNewLines(server, remotePath, offsets[remotePath] ?? -1, this.tempDir);
        if (result.data.length > 0) {
          await fs.appendFile(path.join(serverDir, remotePathToFileName(remotePath)), result.data);
          bytes += result.data.length;
        }
        offsets[remotePath] = result.offset;
      } catch (error) {
        errors.push(`${remotePath}: ${error.message}`);
      }
    }

    writeJson(this.stateFile, this.offsets);
    const status = { serverId: server.id, at: new Date().toISOString(), ok: errors.length === 0, bytes, errors };
    this.emit('status', status);
    if (bytes > 0) this.emit('activity', `${server.name}: +${formatBytes(bytes)}`);
    for (const error of errors) this.emit('activity', `${server.name}: ${error}`);
  }
}

const formatBytes = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

module.exports = { Poller };
