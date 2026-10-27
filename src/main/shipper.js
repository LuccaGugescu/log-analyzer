'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { readJson, writeJson } = require('./config');
const { ENTRY_MARK } = require('./entries');

const LOKI_PUSH_URL = 'http://127.0.0.1:3100/loki/api/v1/push';
const SHIP_EVERY_MS = 5_000;
// The newest entry in a file may still get continuation lines (a payload or
// stack trace) in the next poll; it is held back until the file has been
// quiet this long. Longer than the default 60s poll.
const HOLD_LAST_ENTRY_MS = 90_000;
// One read becomes one push. Loki's distributor forwards it to the ingester
// over gRPC, which rejects messages over 4 MB; JSON escaping and labels grow a
// read by ~25%, so a 4 MB read failed forever (and was retried forever).
const MAX_READ_BYTES = 1024 * 1024;
const MAX_ENTRY_LINES = 1000;
const MAX_ENTRY_BYTES = 200 * 1024; // Loki rejects lines over 256 KB by default
const INDEX_FILE = '.files.json';

// First level word in the entry, normalized the way the dashboard expects.
const LEVEL_RE = /\b(trace|debug|info|notice|warn(?:ing)?|err(?:or)?|crit(?:ical)?|fatal|alert|emerg(?:ency)?|panic)\b/i;
const LEVELS = {
  warning: 'warn', err: 'error', notice: 'info',
  crit: 'fatal', critical: 'fatal', alert: 'fatal', emerg: 'fatal', emergency: 'fatal', panic: 'fatal',
};
const levelOf = (text) => {
  const match = text.match(LEVEL_RE);
  if (!match) return 'unknown';
  const word = match[1].toLowerCase();
  return LEVELS[word] ?? word;
};

const capEntry = (text) => {
  let lines = text.split('\n');
  if (lines.length > MAX_ENTRY_LINES) lines = [...lines.slice(0, MAX_ENTRY_LINES), `… ${lines.length - MAX_ENTRY_LINES} more lines cut`];
  const joined = lines.join('\n');
  return Buffer.byteLength(joined) > MAX_ENTRY_BYTES ? `${joined.slice(0, MAX_ENTRY_BYTES)} … [cut]` : joined;
};

// Index values are { path, dir }; before the `dir` label they were the bare
// remote path, and a spool file missing from the index ships under its own name.
const sourceOf = (indexed, spoolName) =>
  typeof indexed === 'object' && indexed !== null ? indexed : { path: indexed ?? spoolName, dir: null };

// Splits spool text into entries. Every entry starts with ENTRY_MARK at the
// beginning of a line; text before the first mark belongs to an entry that
// was already shipped and is attached as its own entry only if nothing else
// claims it (a file written before marks existed).
const splitEntries = (text) => {
  const parts = text.split(`\n${ENTRY_MARK}`);
  if (parts[0].startsWith(ENTRY_MARK)) parts[0] = parts[0].slice(1);
  return parts.map((part) => part.replace(/\n$/, '')).filter((part) => part.length > 0);
};

// Reads each server's spool files from where it last stopped, pushes whole
// entries to Loki and remembers the new position, so a stopped Loki or an app
// restart loses nothing. Replaces Grafana Alloy.
class Shipper {
  constructor({ logsDir, stateFile }) {
    this.logsDir = logsDir;
    this.stateFile = stateFile;
    // shipped[absoluteSpoolPath] = bytes already pushed
    this.shipped = readJson(stateFile, {});
    this.timer = null;
    this.busy = false;
    this.lastError = null;
    this.sequence = 0;
  }

  start() {
    if (!this.timer) this.timer = setInterval(() => this.shipAll(), SHIP_EVERY_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  forgetServer(serverDir) {
    for (const file of Object.keys(this.shipped)) {
      if (file.startsWith(serverDir + path.sep)) delete this.shipped[file];
    }
    this.save();
  }

  async shipAll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const servers = await fs.readdir(this.logsDir, { withFileTypes: true }).catch(() => []);
      let lastError = null;
      // A push one server's logs keep failing must not hold back the others.
      for (const server of servers.filter((d) => d.isDirectory())) {
        try {
          await this.shipServer(server.name);
        } catch (error) {
          // Loki not up yet / stopped: try again on the next round.
          lastError = `${server.name}: ${error.message}`;
        }
      }
      this.lastError = lastError;
    } finally {
      this.busy = false;
    }
  }

  async shipServer(server) {
    const dir = path.join(this.logsDir, server);
    const index = readJson(path.join(dir, INDEX_FILE), {});
    const names = (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith('.log'));
    for (const name of names) await this.shipFile(server, path.join(dir, name), sourceOf(index[name], name));
  }

  async shipFile(server, file, source) {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) return;
    let offset = this.shipped[file] ?? 0;
    if (stat.size < offset) offset = 0; // emptied by Stop, or recreated
    if (stat.size === offset) return;

    const handle = await fs.open(file, 'r');
    let text;
    try {
      const buffer = Buffer.alloc(Math.min(stat.size - offset, MAX_READ_BYTES));
      await handle.read(buffer, 0, buffer.length, offset);
      text = buffer.toString('utf8');
    } finally {
      await handle.close();
    }

    // Keep the last entry back while the file may still grow, unless this
    // read did not reach the end of the file anyway.
    const reachedEnd = offset + Buffer.byteLength(text) >= stat.size;
    const quiet = Date.now() - stat.mtimeMs >= HOLD_LAST_ENTRY_MS;
    let shipText = text;
    if (reachedEnd && !quiet) {
      const lastStart = text.lastIndexOf(`\n${ENTRY_MARK}`);
      if (lastStart < 0) return; // a single, possibly growing entry: wait
      shipText = text.slice(0, lastStart + 1);
    } else if (!reachedEnd) {
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline < 0) return;
      shipText = text.slice(0, lastNewline + 1);
    }

    const entries = splitEntries(shipText);
    if (entries.length > 0) await this.push(server, source, entries);
    this.shipped[file] = offset + Buffer.byteLength(shipText);
    this.save();
  }

  async push(server, source, entries) {
    // One stream per level; timestamps are unique and increasing per stream.
    const streams = new Map();
    const base = BigInt(Date.now()) * 1_000_000n;
    for (const entry of entries) {
      // The entry's own line decides; a level further down (a payload field) is the fallback.
      const firstLineLevel = levelOf(entry.split('\n', 1)[0]);
      const level = firstLineLevel === 'unknown' ? levelOf(entry) : firstLineLevel;
      if (!streams.has(level)) streams.set(level, []);
      this.sequence = (this.sequence + 1) % 1_000_000;
      streams.get(level).push([String(base + BigInt(this.sequence)), capEntry(entry)]);
    }
    const body = {
      streams: [...streams].map(([level, values]) => ({
        stream: { server, ...(source.dir ? { dir: source.dir } : {}), file: source.path, level, service_name: server },
        values,
      })),
    };
    const response = await fetch(LOKI_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Loki push ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  save() {
    writeJson(this.stateFile, this.shipped);
  }
}

module.exports = { Shipper, splitEntries, levelOf, capEntry, INDEX_FILE };
