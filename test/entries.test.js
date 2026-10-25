'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { markEntries, isEntryStart, ENTRY_MARK: M } = require('../src/main/entries');

const mark = (text, structured = false) => {
  const result = markEntries(Buffer.from(text), structured);
  return { text: result.data.toString(), structured: result.structured };
};

test('recognises common entry-start formats', () => {
  for (const line of [
    '2026-10-25T14:00:01.123Z INFO started',
    '2026-10-25 14:00:01,123 ERROR boom',
    '[2026-10-25 14:00:01] local.ERROR: boom',
    '2026/10/25 14:00:01 [error] 7#7: upstream timed out',
    'Oct 25 14:00:01 host sshd[1]: Accepted publickey',
    '10.0.0.7 - - [25/Oct/2026:14:00:01 +0000] "GET / HTTP/1.1" 200 5',
    'WARN cache miss',
    '{"time":"2026-10-25T14:00:01Z","level":"info","msg":"ok"}',
  ]) assert.ok(isEntryStart(line), line);

  for (const line of ['{', '  "items": [', '\tat com.shop.Payment.charge(Payment.java:42)', 'Caused by: java.io.IOException', 'Request body:']) {
    assert.ok(!isEntryStart(line), line);
  }
});

test('payload and stack-trace lines stay with the entry above them', () => {
  const { text, structured } = mark(
    '2026-10-25T14:00:01Z INFO --> POST /api/orders req=r1\nRequest body:\n{\n  "qty": 2\n}\n' +
      '2026-10-25T14:00:02Z INFO <-- 201 req=r1\n{ "orderId": 7 }\n',
  );
  assert.equal(
    text,
    `${M}2026-10-25T14:00:01Z INFO --> POST /api/orders req=r1\nRequest body:\n{\n  "qty": 2\n}\n` +
      `${M}2026-10-25T14:00:02Z INFO <-- 201 req=r1\n{ "orderId": 7 }\n`,
  );
  assert.equal(structured, true);
});

test('a chunk that starts mid-block continues the previous poll\'s entry', () => {
  assert.equal(mark('  "total": 5\n}\n', true).text, '  "total": 5\n}\n');
});

test('a file with no recognisable entry starts keeps one entry per line', () => {
  const { text, structured } = mark('alpha\nbeta\n');
  assert.equal(text, `${M}alpha\n${M}beta\n`);
  assert.equal(structured, false);
});

test('Kubernetes CRI prefixes are removed so stack traces still group', () => {
  const { text } = mark(
    '2026-10-25T15:00:00.123456789Z stdout F 2026-10-25T15:00:00Z ERROR payment failed\n' +
      '2026-10-25T15:00:00.123456790Z stderr F     at Payment.charge (payment.ts:42)\n' +
      '2026-10-25T15:00:01.000000000+00:00 stdout P {"level":"info","msg":"very long \n' +
      '2026-10-25T15:00:01.000000001+00:00 stdout F line"}\n',
  );
  assert.equal(
    text,
    `${M}2026-10-25T15:00:00Z ERROR payment failed\n    at Payment.charge (payment.ts:42)\n` +
      `${M}{"level":"info","msg":"very long line"}\n`,
  );
});

test('empty chunk passes through', () => {
  assert.equal(markEntries(Buffer.alloc(0), true).data.length, 0);
});
