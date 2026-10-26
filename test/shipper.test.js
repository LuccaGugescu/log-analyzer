'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Shipper, splitEntries, levelOf, capEntry, INDEX_FILE } = require('../src/main/shipper');
const { ENTRY_MARK: M } = require('../src/main/entries');

test('splitEntries cuts on marked line starts only', () => {
  assert.deepEqual(splitEntries(`${M}a 1\npayload\n${M}b 2\n`), ['a 1\npayload', 'b 2']);
});

test('levelOf normalizes level words', () => {
  assert.equal(levelOf('2026-10-25 WARNING disk'), 'warn');
  assert.equal(levelOf('[err] boom'), 'error');
  assert.equal(levelOf('CRITICAL x'), 'fatal');
  assert.equal(levelOf('GET / 200'), 'unknown');
});

test('capEntry bounds huge entries', () => {
  assert.ok(capEntry('x\n'.repeat(5000)).split('\n').length <= 1001);
  assert.ok(Buffer.byteLength(capEntry('y'.repeat(300 * 1024))) < 210 * 1024);
});

test('shipper pushes whole entries with the remote path, holds the growing last one', async (t) => {
  const pushes = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      pushes.push(JSON.parse(body));
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => server.listen(3100, '127.0.0.1', resolve)).catch(() => t.skip('port 3100 busy'));
  t.after(() => server.close());

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'la-ship-'));
  const dir = path.join(root, 'web-01');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, INDEX_FILE), JSON.stringify({ 'var_log_app.log.log': '/var/log/app.log' }));
  fs.writeFileSync(path.join(dir, 'var_log_app.log.log'), `${M}2026 INFO --> POST\n{ "a": 1 }\n${M}2026 ERROR <-- 500\n`);

  const shipper = new Shipper({ logsDir: root, stateFile: path.join(root, 'shipped.json') });
  await shipper.shipAll();
  assert.equal(shipper.lastError, null);
  assert.equal(pushes.length, 1);
  const [stream] = pushes[0].streams;
  assert.deepEqual(stream.stream, { server: 'web-01', file: '/var/log/app.log', level: 'info', service_name: 'web-01' });
  assert.equal(stream.values[0][1], '2026 INFO --> POST\n{ "a": 1 }');

  // Nothing new and the last entry still held: no second push.
  await shipper.shipAll();
  assert.equal(pushes.length, 1);
});

test('shipper labels entries with the configured directory', async (t) => {
  const pushes = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      pushes.push(JSON.parse(body));
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => server.listen(3100, '127.0.0.1', resolve)).catch(() => t.skip('port 3100 busy'));
  t.after(() => server.close());

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'la-ship-'));
  const dir = path.join(root, 'web-01');
  fs.mkdirSync(dir);
  const index = { 'opt_svc_logs_a.log.log': { path: '/opt/svc/logs/a.log', dir: '/opt/svc/logs' } };
  fs.writeFileSync(path.join(dir, INDEX_FILE), JSON.stringify(index));
  fs.writeFileSync(path.join(dir, 'opt_svc_logs_a.log.log'), `${M}2026 WARN slow
${M}2026 INFO ok
`);

  const shipper = new Shipper({ logsDir: root, stateFile: path.join(root, 'shipped.json') });
  await shipper.shipAll();
  assert.equal(shipper.lastError, null);
  assert.deepEqual(pushes[0].streams[0].stream, {
    server: 'web-01', dir: '/opt/svc/logs', file: '/opt/svc/logs/a.log', level: 'warn', service_name: 'web-01',
  });
});
