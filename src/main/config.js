'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_CONFIG = { pollSeconds: 60, autoStart: true, servers: [] };
const MIN_POLL_SECONDS = 5;

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

// Write to a temp file then rename, so a crash mid-write never leaves a
// half-written config behind.
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
};

class ConfigStore {
  constructor(file) {
    this.file = file;
    this.config = { ...DEFAULT_CONFIG, ...readJson(file, {}) };
  }

  get() {
    return this.config;
  }

  setSettings({ pollSeconds, autoStart }) {
    this.config.pollSeconds = Math.max(MIN_POLL_SECONDS, Math.round(Number(pollSeconds) || DEFAULT_CONFIG.pollSeconds));
    this.config.autoStart = Boolean(autoStart);
    this.save();
  }

  upsertServer(server) {
    const saved = { ...server, id: server.id || randomUUID() };
    const index = this.config.servers.findIndex((existing) => existing.id === saved.id);
    if (index >= 0) this.config.servers[index] = saved;
    else this.config.servers.push(saved);
    this.save();
    return saved;
  }

  deleteServer(id) {
    this.config.servers = this.config.servers.filter((server) => server.id !== id);
    this.save();
  }

  save() {
    writeJson(this.file, this.config);
  }
}

module.exports = { ConfigStore, readJson, writeJson, MIN_POLL_SECONDS };
