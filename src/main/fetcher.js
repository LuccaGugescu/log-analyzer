'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { sshExec, scpDownload } = require('./ssh');
const { shellQuote } = require('./validate');

// On the first pull of a file only its tail is ingested, so adding a server
// with a multi-GB log does not flood Loki with history.
const BACKFILL_BYTES = 5 * 1024 * 1024;
const NEWLINE = 0x0a;

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
      const buffer = Buffer.alloc(size - start);
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

// Tail mode: one ssh round trip that returns only the new bytes. The remote
// script prints the offset it actually started from on the first line.
const tailScript = (remotePath, offset) =>
  [
    `f=${shellQuote(remotePath)}`,
    `o=${offset}`,
    `b=${BACKFILL_BYTES}`,
    `s=$(wc -c < "$f") || exit 3`,
    `if [ "$o" -lt 0 ]; then o=$(( s > b ? s - b : 0 )); elif [ "$s" -lt "$o" ]; then o=0; fi`,
    `echo "$o"`,
    `tail -c +$(( o + 1 )) "$f" | head -c $(( s - o ))`,
  ].join('; ');

const fetchWithTail = async (server, remotePath, offset) => {
  const result = await sshExec(server, tailScript(remotePath, offset), { timeoutMs: 120_000 });
  if (result.code !== 0) throw new Error(result.stderr || `ssh exited with ${result.code}`);

  const headerEnd = result.stdout.indexOf(NEWLINE);
  const start = Number(result.stdout.subarray(0, headerEnd).toString('ascii'));
  if (headerEnd < 0 || !Number.isFinite(start)) throw new Error('Unexpected reply from remote tail.');

  const data = completeLines(result.stdout.subarray(headerEnd + 1));
  return { data, offset: start + data.length };
};

const fetchNewLines = (server, remotePath, offset, tempDir) =>
  server.mode === 'tail'
    ? fetchWithTail(server, remotePath, offset)
    : fetchWithScp(server, remotePath, offset, tempDir);

module.exports = { fetchNewLines, startOffset, completeLines, tailScript, BACKFILL_BYTES };
