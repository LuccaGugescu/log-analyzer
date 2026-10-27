'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PurgeQueue } = require('../src/main/purge');

// Jobs are seeded through the state file, so nothing here talks to Loki.
const queueWith = (t, jobs) => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'la-purge-')), 'purges.json');
  fs.writeFileSync(stateFile, JSON.stringify(jobs));
  const queue = new PurgeQueue({ stateFile });
  t.after(() => queue.stop());
  return queue;
};

const job = (fields) => ({ slug: 'web-01', folder: null, stoppedAt: 0, sent: [], remaining: null, done: false, folderLeft: false, ...fields });

test('a removed server blocks its name until both deletes went out and its folder is gone', (t) => {
  assert.equal(queueWith(t, { old: job({ sent: [1] }) }).blocksName('web-01'), true);
  assert.equal(queueWith(t, { old: job({ sent: [1, 2], folderLeft: true }) }).blocksName('web-01'), true);
  assert.equal(queueWith(t, { old: job({ sent: [1, 2] }) }).blocksName('web-01'), false);
  assert.equal(queueWith(t, { old: job({ sent: [1, 2], done: true }) }).blocksName('web-01'), false);
  assert.equal(queueWith(t, { old: job({ sent: [1] }) }).blocksName('db-01'), false);
});

test('a server is not blocked by its own cleanup', (t) => {
  assert.equal(queueWith(t, { same: job({ sent: [1] }) }).blocksName('web-01', 'same'), false);
});

test('reusing a name drops the old jobs for it, keeping the saved server own', (t) => {
  const queue = queueWith(t, { old: job({ sent: [1, 2] }), same: job({ sent: [1] }), other: job({ slug: 'db-01' }) });
  queue.forgetName('web-01', 'same');
  assert.equal(queue.status('old'), null);
  assert.notEqual(queue.status('same'), null);
  assert.notEqual(queue.status('other'), null);
});
