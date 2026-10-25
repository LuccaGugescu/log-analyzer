'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const GRAFANA_URL = 'http://localhost:3000';

const compose = (stackDir, logsDir, args, timeoutMs = 300_000) =>
  new Promise((resolve) => {
    const child = spawn('docker', ['compose', '-f', path.join(stackDir, 'docker-compose.yml'), ...args], {
      cwd: stackDir,
      windowsHide: true,
      env: { ...process.env, LOGS_DIR: logsDir },
    });
    let output = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `${error.message}. Is Docker Desktop installed?` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output.trim() });
    });
  });

// `docker compose ps --format json` prints one object per line on recent
// versions and a single array on older ones; accept both.
const parsePs = (output) => {
  const trimmed = output.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  return trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
};

const stackStatus = async (stackDir, logsDir) => {
  const result = await compose(stackDir, logsDir, ['ps', '--format', 'json'], 30_000);
  if (!result.ok) return { ok: false, services: [], output: result.output };
  try {
    const services = parsePs(result.output).map((row) => ({ name: row.Service, state: row.State, status: row.Status }));
    return { ok: true, services };
  } catch {
    return { ok: false, services: [], output: result.output };
  }
};

const stackUp = (stackDir, logsDir) => compose(stackDir, logsDir, ['up', '-d']);
const stackDown = (stackDir, logsDir) => compose(stackDir, logsDir, ['down']);

module.exports = { stackUp, stackDown, stackStatus, parsePs, GRAFANA_URL };
