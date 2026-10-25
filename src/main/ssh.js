'use strict';

const { spawn } = require('node:child_process');

// Key-based auth only: BatchMode stops ssh/scp from ever waiting on a password
// prompt, which would hang a background poll. New hosts are trusted on first
// use and pinned in the user's known_hosts from then on.
const baseOptions = (server) => {
  const options = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2',
  ];
  if (server.identityFile) options.push('-i', server.identityFile);
  return options;
};

const run = (command, args, { timeoutMs = 60_000 } = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill(), timeoutMs);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: error.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const errorText = Buffer.concat(stderr).toString('utf8').trim();
      resolve({
        code: signal ? -1 : code,
        stdout: Buffer.concat(stdout),
        stderr: signal ? `timed out after ${timeoutMs / 1000}s ${errorText}`.trim() : errorText,
      });
    });
  });

const sshExec = (server, remoteCommand, options) =>
  run('ssh', [...baseOptions(server), '-p', String(server.port), '--', server.target, remoteCommand], options);

const scpDownload = (server, remotePath, localPath, options) =>
  run('scp', [...baseOptions(server), '-q', '-P', String(server.port), '--', `${server.target}:${remotePath}`, localPath], options);

module.exports = { run, sshExec, scpDownload };
