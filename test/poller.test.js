'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Poller } = require('../src/main/poller');

const servers = [
  { id: 'a', name: 'web-01' },
  { id: 'b', name: 'db-01' },
  { id: 'c', name: 'off', enabled: false },
];

test('tick reports pulls starting and ending, and skips servers still busy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'la-poll-'));
  const poller = new Poller({ getConfig: () => ({ servers }), logsDir: root, stateFile: path.join(root, 's.json'), tempDir: root });
  const finish = {};
  poller.pollServer = (server) => new Promise((resolve) => (finish[server.id] = resolve));
  const events = [];
  poller.on('polling', (event) => events.push(event));

  const first = poller.tick();
  assert.deepEqual(first.started.map((s) => s.id), ['a', 'b']);
  assert.deepEqual(first.skipped, []);
  assert.deepEqual(poller.pollingIds().sort(), ['a', 'b']);

  finish.a();
  await new Promise(setImmediate);
  const second = poller.tick();
  assert.deepEqual(second.started.map((s) => s.id), ['a']);
  assert.deepEqual(second.skipped.map((s) => s.id), ['b']);
  assert.deepEqual(events.slice(0, 3), [
    { serverId: 'a', polling: true },
    { serverId: 'b', polling: true },
    { serverId: 'a', polling: false },
  ]);
});
