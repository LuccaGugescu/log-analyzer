'use strict';

const path = require('node:path').posix;
const { sshExec } = require('./ssh');
const { shellQuote } = require('./validate');

const SCAN_DEPTH = 4;
const MAX_FILES_PER_SERVER = 50;
const STALE_AFTER_DAYS = 30;

// Archives and binary/system files that are never worth shipping.
const ARCHIVE_RE = /\.(gz|xz|bz2|zst|lz4|zip|tar|tgz|7z|Z)$/i;
const BINARY_NAMES = new Set(['wtmp', 'btmp', 'utmp', 'lastlog', 'faillog', 'tallylog']);
const BINARY_EXT_RE = /\.(journal|journal~|bin|db|sqlite|pid|lock|sock|swp|old|bak)$/i;

// Rotation markers, stripped repeatedly so e.g. "app-2026-10-25.1.log.gz"
// collapses onto its family "app.log".
const ROTATION_PATTERNS = [
  /^(.*)\.\d+$/, // syslog.1, server.log.2
  /^(.*)[._-]\d+(\.log)$/i, // server.1.log, server-2.log
  /^(.*)[._-]\d{4}-?\d{2}-?\d{2}(?:[T_-]?\d{2}-?\d{2}(?:-?\d{2})?)?(\.log)?$/i, // app-2026-10-25.log, syslog-20261025
];

const familyName = (name) => {
  let current = name.replace(ARCHIVE_RE, '');
  for (let changed = true; changed; ) {
    changed = false;
    for (const pattern of ROTATION_PATTERNS) {
      const match = current.match(pattern);
      if (match && match[1]) {
        current = match[1] + (match[2] ?? '');
        changed = true;
      }
    }
  }
  return current;
};

const skipReason = (entry, nowSeconds) => {
  const name = path.basename(entry.path);
  if (ARCHIVE_RE.test(name)) return 'rotated archive';
  if (BINARY_NAMES.has(name) || BINARY_EXT_RE.test(name)) return 'binary / not a text log';
  if (entry.size === 0) return 'empty';
  if (nowSeconds - entry.mtime > STALE_AFTER_DAYS * 86_400) return `not written for ${STALE_AFTER_DAYS}+ days`;
  return null;
};

// Picks what to ship from a directory listing: one file per rotation family —
// the live file ("server.log") when it exists, otherwise the newest member —
// and nothing stale, empty, compressed or binary.
const selectLogFiles = (entries, nowSeconds = Date.now() / 1000) => {
  const skipped = [];
  const families = new Map();

  for (const entry of entries) {
    const reason = skipReason(entry, nowSeconds);
    if (reason) {
      skipped.push({ path: entry.path, reason });
      continue;
    }
    const key = path.join(path.dirname(entry.path), familyName(path.basename(entry.path)));
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(entry);
  }

  const kept = [];
  for (const [key, members] of families) {
    const live = members.find((m) => m.path === key);
    const chosen = live ?? members.reduce((a, b) => (b.mtime > a.mtime ? b : a));
    kept.push(chosen);
    for (const m of members) {
      if (m !== chosen) skipped.push({ path: m.path, reason: `older rotation of ${path.basename(chosen.path)}` });
    }
  }

  kept.sort((a, b) => b.mtime - a.mtime);
  for (const extra of kept.splice(MAX_FILES_PER_SERVER)) {
    skipped.push({ path: extra.path, reason: `over the ${MAX_FILES_PER_SERVER}-file limit` });
  }
  kept.sort((a, b) => a.path.localeCompare(b.path));
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  return { kept, skipped };
};

// One `find` per directory, readable regular files only, as "mtime size path".
// `stat -c` works on GNU and BusyBox alike (unlike `find -printf`).
const scanScript = (dirs) =>
  dirs
    .map(
      (dir) =>
        `find ${shellQuote(dir)} -maxdepth ${SCAN_DEPTH} -type f -exec sh -c 'for f; do [ -r "$f" ] && stat -c "%Y %s %n" "$f"; done' sh {} + 2>/dev/null`,
    )
    .join('; ');

const parseScan = (output) =>
  output
    .split('\n')
    .map((line) => line.match(/^(\d+) (\d+) (\/.*)$/))
    .filter(Boolean)
    .map(([, mtime, size, filePath]) => ({ path: filePath, mtime: Number(mtime), size: Number(size) }));

const discoverLogs = async (server) => {
  const result = await sshExec(server, scanScript(server.logDirs), { timeoutMs: 60_000 });
  const entries = parseScan(result.stdout.toString('utf8'));
  if (entries.length === 0 && result.code !== 0) throw new Error(result.stderr || `scan failed (${result.code})`);
  return { at: new Date().toISOString(), ...selectLogFiles(entries) };
};

// The configured log directory a discovered file lives under, as the user typed
// it (without trailing slashes); the most specific one wins when dirs nest.
const logDirOf = (remotePath, logDirs) => {
  let best = null;
  for (const raw of logDirs ?? []) {
    const dir = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
    const inside = dir === '/' || remotePath === dir || remotePath.startsWith(`${dir}/`);
    if (inside && (best === null || dir.length > best.length)) best = dir;
  }
  return best;
};

module.exports = { discoverLogs, selectLogFiles, familyName, parseScan, scanScript, logDirOf, MAX_FILES_PER_SERVER };
