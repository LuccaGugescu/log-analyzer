'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startOffset, completeLines, parseTailReply, BACKFILL_BYTES } = require('../src/main/fetcher');
const { selectLogFiles, familyName, parseScan } = require('../src/main/discovery');
const { validateServer, isValidTarget, remotePathToFileName, shellQuote, toSlug } = require('../src/main/validate');
const { sshTarget, scpSource } = require('../src/main/ssh');
const { parsePs } = require('../src/main/docker');

const NOW = 1_800_000_000;
const server = (overrides = {}) => ({
  name: 'web-01', user: 'root', host: '10.0.0.5', port: 22, mode: 'tail', logDirs: ['/var/log'], ...overrides,
});
const file = (path, { ageDays = 0, size = 100 } = {}) => ({ path, size, mtime: NOW - ageDays * 86_400 });
const keptPaths = (entries) => selectLogFiles(entries, NOW).kept.map((f) => f.path);

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

test('familyName collapses rotation markers', () => {
  assert.equal(familyName('server.1.log'), 'server.log');
  assert.equal(familyName('server.log.2'), 'server.log');
  assert.equal(familyName('server-3.log'), 'server.log');
  assert.equal(familyName('syslog.2.gz'), 'syslog');
  assert.equal(familyName('syslog-20261020'), 'syslog');
  assert.equal(familyName('app-2026-10-25.log'), 'app.log');
  assert.equal(familyName('app-2026-10-24.1.log.gz'), 'app.log');
  assert.equal(familyName('php8.2-fpm.log'), 'php8.2-fpm.log');
});

test('only the live file of a rotation family is imported', () => {
  const kept = keptPaths([
    file('/var/log/app/server.log'),
    file('/var/log/app/server.1.log', { ageDays: 1 }),
    file('/var/log/app/server.2.log', { ageDays: 2 }),
    file('/var/log/app/server.log.3.gz', { ageDays: 3 }),
    file('/var/log/syslog'),
    file('/var/log/syslog.1', { ageDays: 1 }),
  ]);
  assert.deepEqual(kept, ['/var/log/app/server.log', '/var/log/syslog']);
});

test('without a live file the newest rotation wins', () => {
  const kept = keptPaths([
    file('/var/log/app-2026-10-24.log', { ageDays: 1 }),
    file('/var/log/app-2026-10-25.log'),
  ]);
  assert.deepEqual(kept, ['/var/log/app-2026-10-25.log']);
});

test('same file name in different folders stays separate', () => {
  assert.equal(keptPaths([file('/var/log/a/error.log'), file('/var/log/b/error.log')]).length, 2);
});

test('stale, empty and binary files are skipped with a reason', () => {
  const { kept, skipped } = selectLogFiles(
    [file('/var/log/old.log', { ageDays: 60 }), file('/var/log/empty.log', { size: 0 }), file('/var/log/wtmp'), file('/var/log/ok.log')],
    NOW,
  );
  assert.deepEqual(kept.map((f) => f.path), ['/var/log/ok.log']);
  assert.equal(skipped.length, 3);
  assert.ok(skipped.every((s) => s.reason));
});

test('parseScan reads "mtime size path" lines, spaces in paths included', () => {
  assert.deepEqual(parseScan('1700000000 42 /var/log/my app.log\ngarbage\n'), [
    { path: '/var/log/my app.log', mtime: 1700000000, size: 42 },
  ]);
});

test('parseTailReply splits one batched reply per file', () => {
  const files = [{ path: '/a', offset: 0 }, { path: '/b', offset: 5 }, { path: '/c', offset: -1 }];
  const reply = Buffer.from('@@LA@@ 0 0 5\nx\nyy\n@@LA@@ 1 5 5\nok\npa@@LA@@ 2 -1 0\n');
  const [a, b, c] = parseTailReply(reply, files);
  assert.equal(a.data.toString(), 'x\nyy\n');
  assert.equal(a.offset, 5);
  assert.equal(b.data.toString(), 'ok\n');
  assert.equal(b.offset, 8);
  assert.match(c.error, /not readable/);
});

test('parseTailReply marks the rest as errors when the stream desyncs', () => {
  const files = [{ path: '/a', offset: 0 }, { path: '/b', offset: 0 }];
  const [a, b] = parseTailReply(Buffer.from('@@LA@@ 0 0 2\nx\nGARBAGE'), files);
  assert.equal(a.data.toString(), 'x\n');
  assert.match(b.error, /out of sync/);
});

test('user and host must never become ssh options', () => {
  assert.deepEqual(validateServer(server()), []);
  assert.ok(validateServer(server({ user: '-oProxyCommand=calc' })).length > 0);
  assert.ok(validateServer(server({ host: '-oProxyCommand=calc' })).length > 0);
  assert.ok(validateServer(server({ host: 'a b' })).length > 0);
  assert.ok(validateServer(server({ logDirs: [] })).length > 0);
  assert.ok(validateServer(server({ logDirs: ['var/log'] })).length > 0);
  assert.ok(isValidTarget('ubuntu@203.0.113.7'));
  assert.ok(!isValidTarget('203.0.113.7'));
});

test('ssh and scp targets handle IPv6', () => {
  assert.equal(sshTarget(server({ host: '[2001:db8::1]' })), 'root@2001:db8::1');
  assert.equal(scpSource(server({ host: '2001:db8::1' }), '/var/log/x'), 'root@[2001:db8::1]:/var/log/x');
  assert.equal(scpSource(server(), '/var/log/x'), 'root@10.0.0.5:/var/log/x');
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
