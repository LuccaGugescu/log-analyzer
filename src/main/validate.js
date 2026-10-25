'use strict';

// Inputs end up as ssh/scp arguments and inside a remote shell command, so they
// are checked strictly: a target can never start with "-" (option injection)
// and a remote path can never carry a newline or NUL.
const TARGET_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*@[A-Za-z0-9.:_-]+$/;
const NAME_RE = /^[A-Za-z0-9._ -]{1,64}$/;

const isValidTarget = (target) => typeof target === 'string' && TARGET_RE.test(target);

const isValidRemotePath = (path) =>
  typeof path === 'string' && path.startsWith('/') && path.length < 1024 && !/[\r\n\0]/.test(path);

const isValidPort = (port) => Number.isInteger(port) && port > 0 && port < 65536;

const validateServer = (server) => {
  const errors = [];
  if (!NAME_RE.test(server.name ?? '')) errors.push('Name: 1-64 letters, digits, space, dot, dash or underscore.');
  if (!isValidTarget(server.target)) errors.push('Target must look like user@host (e.g. root@10.0.0.5).');
  if (!isValidPort(server.port)) errors.push('Port must be 1-65535.');
  if (!['scp', 'tail'].includes(server.mode)) errors.push('Mode must be "scp" or "tail".');
  if (!Array.isArray(server.paths) || server.paths.length === 0) errors.push('Add at least one log path.');
  for (const path of server.paths ?? []) {
    if (!isValidRemotePath(path)) errors.push(`Invalid remote path: ${path}`);
  }
  return errors;
};

// "web-01 (prod)" -> "web-01_prod_"; used as a folder name and as the Loki `server` label.
const toSlug = (value) => value.replace(/[^A-Za-z0-9._-]/g, '_');

// "/var/log/nginx/access.log" -> "var_log_nginx_access.log.log" keeps every remote file distinct.
const remotePathToFileName = (remotePath) => `${toSlug(remotePath.replace(/^\/+/, ''))}.log`;

// POSIX single-quote escaping for the remote shell.
const shellQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;

module.exports = { isValidTarget, isValidRemotePath, validateServer, toSlug, remotePathToFileName, shellQuote };
