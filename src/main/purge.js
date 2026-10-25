'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { readJson, writeJson } = require('./config');

const LOKI_URL = 'http://127.0.0.1:3100';
// Alloy may still be shipping lines it read just before the stop (multiline
// entries wait up to 90s), so a second delete request covers that window.
const FOLLOW_UP_AFTER_MS = 100_000;
const CHECK_EVERY_MS = 15_000;
// Loki rejects a delete start of 0; anything before retention works.
const DELETE_FROM_SECONDS = 1_600_000_000;

const lokiCount = async (slug) => {
  const query = encodeURIComponent(`sum(count_over_time({server="${slug}"}[720h]))`);
  const response = await fetch(`${LOKI_URL}/loki/api/v1/query?query=${query}`);
  if (!response.ok) throw new Error(`Loki query failed (${response.status})`);
  const body = await response.json();
  return Number(body.data.result[0]?.value[1] ?? 0);
};

const lokiDelete = async (slug, endMs) => {
  const params = new URLSearchParams({
    query: `{server="${slug}"}`,
    start: String(DELETE_FROM_SECONDS),
    end: String(Math.floor(endMs / 1000)),
  });
  const response = await fetch(`${LOKI_URL}/loki/api/v1/delete?${params}`, { method: 'POST' });
  if (!response.ok) throw new Error(`Loki delete failed (${response.status}): ${await response.text()}`);
};

// Removes everything a stopped server sent to Grafana: its local log folder
// right away, then its lines in Loki. Loki's delete API is eventually
// consistent (queries can show the lines for a few more minutes), so each job
// is re-checked until Loki returns none, and survives app restarts and a
// stopped Docker stack. Emits "status" { serverId, phase, remaining, error }.
class PurgeQueue extends EventEmitter {
  constructor({ stateFile }) {
    super();
    this.stateFile = stateFile;
    // jobs[serverId] = { slug, folder, stoppedAt, sent: [endMs], remaining, done, folderLeft }
    this.jobs = readJson(stateFile, {});
    this.timer = setInterval(() => this.runAll(), CHECK_EVERY_MS);
    this.running = false;
  }

  status(serverId) {
    const job = this.jobs[serverId];
    if (!job) return null;
    return {
      serverId,
      phase: job.done ? 'done' : 'removing',
      remaining: job.remaining ?? null,
      error: job.error ?? null,
      // Starting again before the follow-up delete went out would let it remove fresh lines.
      canRestart: job.done || job.sent.length >= 2,
    };
  }

  async purge(serverId, slug, folder) {
    this.jobs[serverId] = { slug, folder, stoppedAt: Date.now(), sent: [], remaining: null, done: false, folderLeft: true };
    this.save();
    await this.run(serverId);
  }

  // On Windows the folder can't be removed while Docker/Alloy still has its
  // files open, so they are emptied first (nothing left to ship) and the
  // folder is removed on a later check once the handles are released.
  async removeFolder(job) {
    try {
      await fs.rm(job.folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      job.folderLeft = false;
    } catch {
      const names = await fs.readdir(job.folder).catch(() => []);
      await Promise.all(names.map((name) => fs.truncate(path.join(job.folder, name), 0).catch(() => {})));
    }
  }

  forget(serverId) {
    delete this.jobs[serverId];
    this.save();
  }

  async runAll() {
    if (this.running) return;
    this.running = true;
    try {
      for (const serverId of Object.keys(this.jobs)) {
        const job = this.jobs[serverId];
        if (!job.done || job.folderLeft) await this.run(serverId);
      }
    } finally {
      this.running = false;
    }
  }

  async run(serverId) {
    const job = this.jobs[serverId];
    if (!job) return;
    if (job.folderLeft && job.folder) await this.removeFolder(job);
    if (job.done) return this.save();
    try {
      if (job.sent.length === 0) {
        await lokiDelete(job.slug, Date.now());
        job.sent.push(Date.now());
      } else if (job.sent.length === 1 && Date.now() - job.stoppedAt >= FOLLOW_UP_AFTER_MS) {
        await lokiDelete(job.slug, job.stoppedAt + FOLLOW_UP_AFTER_MS);
        job.sent.push(Date.now());
      }
      job.remaining = await lokiCount(job.slug);
      job.done = job.sent.length >= 2 && job.remaining === 0;
      delete job.error;
    } catch (error) {
      // Typically the Grafana stack is stopped; retried on the next check.
      job.error = error.cause?.code === 'ECONNREFUSED' ? 'waiting for the Grafana stack to run' : error.message;
    }
    this.save();
    this.emit('status', this.status(serverId));
  }

  save() {
    writeJson(this.stateFile, this.jobs);
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = { PurgeQueue, FOLLOW_UP_AFTER_MS };
