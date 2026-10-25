'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { sshExec, scpDownload } = require('./ssh');
const { shellQuote } = require('./validate');

// On the first pull of a file only its tail is ingested, so adding a server
// with a multi-GB log does not flood Loki with history.
const BACKFILL_BYTES = 5 * 1024 * 1024;
// Upper bound per file per poll; a file that grows faster catches up over the next polls.
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const NEWLINE = 0x0a;
const MARKER = '@@LA@@';

// Where to start reading a remote file of `size` bytes, given what was already
// ingested. `offset < 0` means never seen; `size < offset` means it was rotated
// or truncated, so start over from the beginning.
const startOffset = (size, offset) => {
  if (offset < 0) return Math.max(0, size - BACKFILL_BYTES);
  if (size < offset) return 0;
  return offset;
};

// Keep only whole lines; a half-written last line is picked up on the next poll.
const completeLines = (buffer) => buffer.subarray(0, buffer.lastIndexOf(NEWLINE) + 1);

// SCP mode: copy the whole file, then keep only the bytes past the last offset.
const fetchWithScp = async (server, remotePath, offset, tempDir) => {
  const tempFile = path.join(tempDir, `pull-${process.pid}-${Date.now()}.tmp`);
  try {
    const result = await scpDownload(server, remotePath, tempFile, { timeoutMs: 120_000 });
    if (result.code !== 0) throw new Error(result.stderr || `scp exited with ${result.code}`);

    const handle = await fs.open(tempFile, 'r');
    try {
      const { size } = await handle.stat();
      const start = startOffset(size, offset);
      const buffer = Buffer.alloc(Math.min(size - start, MAX_CHUNK_BYTES));
      if (buffer.length > 0) await handle.read(buffer, 0, buffer.length, start);
      const data = completeLines(buffer);
      return { data, offset: start + data.length };
    } finally {
      await handle.close();
    }
  } finally {
    await fs.rm(tempFile, { force: true });
  }
};

// Tail mode: ONE ssh session per poll for all of a server's files. For each
// file the remote side prints "@@LA@@ <index> <start> <length>" followed by
// exactly <length> new bytes (start -1 = unreadable).
const tailScript = (files) =>
  [
    `emit() { f=$1; o=$2`,
    `if [ ! -r "$f" ]; then echo "${MARKER} $3 -1 0"; return; fi`,
    `s=$(( $(wc -c < "$f") ))`,
    `if [ "$o" -lt 0 ]; then o=$(( s > ${BACKFILL_BYTES} ? s - ${BACKFILL_BYTES} : 0 )); elif [ "$s" -lt "$o" ]; then o=0; fi`,
    `n=$(( s - o )); if [ "$n" -gt ${MAX_CHUNK_BYTES} ]; then n=${MAX_CHUNK_BYTES}; fi`,
    `echo "${MARKER} $3 $o $n"`,
    `if [ "$n" -gt 0 ]; then tail -c +$(( o + 1 )) "$f" | head -c "$n"; fi; }`,
    ...files.map(({ path: remotePath, offset }, index) => `emit ${shellQuote(remotePath)} ${offset} ${index}`),
  ].join('\n');

const HEADER_RE = /^@@LA@@ (\d+) (-?\d+) (\d+)$/;

// Splits the batched reply back into one result per file. If the stream goes
// out of step (a file shrank mid-read), the remaining files report an error
// and keep their offsets, so nothing is skipped or duplicated.
const parseTailReply = (stdout, files) => {
  const results = files.map(() => ({ error: 'no reply' }));
  let cursor = 0;
  while (cursor < stdout.length) {
    const headerEnd = stdout.indexOf(NEWLINE, cursor);
    const match = headerEnd < 0 ? null : stdout.subarray(cursor, headerEnd).toString('ascii').match(HEADER_RE);
    if (!match) {
      for (const result of results) if (result.error === 'no reply') result.error = 'reply out of sync, retrying next poll';
      break;
    }
    const [index, start, length] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const body = stdout.subarray(headerEnd + 1, headerEnd + 1 + length);
    cursor = headerEnd + 1 + length;
    if (index >= files.length) continue;
    if (start < 0) {
      results[index] = { error: 'not readable (missing or no permission)' };
      continue;
    }
    const data = completeLines(body);
    results[index] = { data, offset: start + data.length };
  }
  return results;
};

const fetchWithTail = async (server, files) => {
  const result = await sshExec(server, tailScript(files), { timeoutMs: 120_000 });
  if (result.code !== 0 && result.stdout.length === 0) throw new Error(result.stderr || `ssh exited with ${result.code}`);
  return parseTailReply(result.stdout, files);
};

// files: [{ path, offset }] -> [{ data, offset } | { error }] in the same order.
const fetchNewLines = async (server, files, tempDir) => {
  if (server.mode === 'tail') return fetchWithTail(server, files);
  const results = [];
  for (const file of files) {
    try {
      results.push(await fetchWithScp(server, file.path, file.offset, tempDir));
    } catch (error) {
      results.push({ error: error.message });
    }
  }
  return results;
};

module.exports = { fetchNewLines, startOffset, completeLines, tailScript, parseTailReply, BACKFILL_BYTES, MAX_CHUNK_BYTES };
