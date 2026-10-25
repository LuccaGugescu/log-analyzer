'use strict';

// Inputs end up as ssh/scp arguments and inside a remote shell command, so they
// are checked strictly: user and host can never start with "-" (option
// injection) and a remote path can never carry a newline or NUL.
const USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
const HOST_RE = /^[A-Za-z0-9.:_[\]][A-Za-z0-9.:_[\]-]{0,252}$/;
const NAME_RE = /^[A-Za-z0-9._ -]{1,64}$/;

const isValidUser = (user) => typeof user === 'string' && USER_RE.test(user);
const isValidHost = (host) => typeof host === 'string' && HOST_RE.test(host);
const isValidTarget = (target) => {
  if (typeof target !== 'string') return false;
  const [user, host, ...rest] = target.split('@');
  return rest.length === 0 && isValidUser(user) && isValidHost(host);
};

const isValidRemotePath = (path) =>
  typeof path === 'string' && path.startsWith('/') && path.length < 1024 && !/[\r\n\0]/.test(path);

const isValidPort = (port) => Number.isInteger(port) && port > 0 && port < 65536;

const validateServer = (server) => {
  const errors = [];
  if (!NAME_RE.test(server.name ?? '')) errors.push('Name: 1-64 letters, digits, space, dot, dash or underscore.');
  if (!isValidUser(server.user)) errors.push('User: letters, digits, dot, dash, underscore (e.g. root, ubuntu).');
  if (!isValidHost(server.host)) errors.push('IP / host is not valid (e.g. 203.0.113.10 or logs.example.com).');
  if (!isValidPort(server.port)) errors.push('Port must be 1-65535.');
  if (!['scp', 'tail'].includes(server.mode)) errors.push('Mode must be "scp" or "tail".');
  if (!Array.isArray(server.logDirs) || server.logDirs.length === 0) errors.push('Add the log directory, e.g. /var/log.');
  for (const dir of server.logDirs ?? []) {
    if (!isValidRemotePath(dir)) errors.push(`Log directory must be an absolute path: ${dir}`);
  }
  return errors;
};

// "web-01 (prod)" -> "web-01_prod_"; used as a folder name and as the Loki `server` label.
const toSlug = (value) => value.replace(/[^A-Za-z0-9._-]/g, '_');

// "/var/log/nginx/access.log" -> "var_log_nginx_access.log.log" keeps every remote file distinct.
const remotePathToFileName = (remotePath) => `${toSlug(remotePath.replace(/^\/+/, ''))}.log`;

// POSIX single-quote escaping for the remote shell.
const shellQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;

module.exports = {
  isValidUser,
  isValidHost,
  isValidTarget,
  isValidRemotePath,
  validateServer,
  toSlug,
  remotePathToFileName,
  shellQuote,
};
