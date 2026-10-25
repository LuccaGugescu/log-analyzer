'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startOffset, completeLines, BACKFILL_BYTES } = require('../src/main/fetcher');
const { validateServer, isValidTarget, remotePathToFileName, shellQuote, toSlug } = require('../src/main/validate');
const { parsePs } = require('../src/main/docker');

const server = (overrides = {}) => ({
  name: 'web-01', target: 'root@10.0.0.5', port: 22, mode: 'scp', paths: ['/var/log/syslog'], ...overrides,
});

test('startOffset backfills only the tail of an unseen file', () => {
  assert.equal(startOffset(100, -1), 0);
  assert.equal(startOffset(BACKFILL_BYTES + 10, -1), 10);
});

test('startOffset resumes, and restarts after rotation', () => {
  assert.equal(startOffset(500, 200), 200);
  assert.equal(startOffset(50, 200), 0);
});

test('completeLines drops a trailing partial line', () => {
  assert.equal(completeLines(Buffer.from('a\nb\npart')).toString(), 'a\nb\n');
  assert.equal(completeLines(Buffer.from('no newline')).length, 0);
});

test('target must be user@host and never an option', () => {
  assert.ok(isValidTarget('ubuntu@203.0.113.7'));
  assert.ok(isValidTarget('deploy@host.example.com'));
  assert.ok(!isValidTarget('-oProxyCommand=calc@x'));
  assert.ok(!isValidTarget('203.0.113.7'));
  assert.ok(!isValidTarget('a@b c'));
});

test('validateServer reports bad fields', () => {
  assert.deepEqual(validateServer(server()), []);
  assert.equal(validateServer(server({ paths: [] })).length, 1);
  assert.equal(validateServer(server({ paths: ['relative.log'] })).length, 1);
  assert.equal(validateServer(server({ port: 70000 })).length, 1);
});

test('file and folder names are filesystem safe', () => {
  assert.equal(remotePathToFileName('/var/log/nginx/access.log'), 'var_log_nginx_access.log.log');
  assert.equal(toSlug('web 01 (prod)'), 'web_01__prod_');
});

test('shellQuote survives single quotes', () => {
  assert.equal(shellQuote("/tmp/it's.log"), `'/tmp/it'\\''s.log'`);
});

test('parsePs accepts both docker compose output shapes', () => {
  assert.equal(parsePs('{"Service":"loki","State":"running"}\n{"Service":"grafana","State":"running"}').length, 2);
  assert.equal(parsePs('[{"Service":"loki","State":"running"}]').length, 1);
  assert.equal(parsePs('').length, 0);
});
