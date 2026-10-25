'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const GRAFANA_URL = 'http://localhost:3000';
const LOKI_URL = 'http://127.0.0.1:3100';
const READY_TIMEOUT_MS = 90_000;

// Forward slashes: Loki and Grafana configs read them fine on Windows and
// they need no escaping inside YAML.
const posix = (p) => p.replace(/\\/g, '/');

const isReady = async (url, check = (r) => r.ok) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return check(response);
  } catch {
    return false;
  }
};

const SERVICES = {
  loki: () => isReady(`${LOKI_URL}/ready`),
  grafana: () => isReady(`${GRAFANA_URL}/api/health`),
};

// Runs the bundled Windows builds of Loki and Grafana as child processes, so
// no Docker is needed. Configs and data live under dataDir; process output
// goes to dataDir/logs. If something already answers on the ports (e.g. the
// Docker stack from stack/docker-compose.yml) it is used as is.
class NativeStack {
  constructor({ vendorDir, stackDir, dataDir }) {
    this.vendorDir = vendorDir;
    this.stackDir = stackDir;
    this.dataDir = dataDir;
    this.children = new Map();
  }

  get installed() {
    return fs.existsSync(this.lokiExe) && fs.existsSync(this.grafanaExe);
  }

  get lokiExe() {
    return path.join(this.vendorDir, 'loki', 'loki-windows-amd64.exe');
  }

  get grafanaExe() {
    return path.join(this.vendorDir, 'grafana', 'bin', 'grafana.exe');
  }

  // Same settings as stack/loki/config.yaml (shared with the Docker stack),
  // with paths moved to dataDir and listeners bound to localhost.
  writeLokiConfig() {
    const dir = posix(path.join(this.dataDir, 'loki'));
    const config = fs
      .readFileSync(path.join(this.stackDir, 'loki', 'config.yaml'), 'utf8')
      .replace(/: \/loki\b/g, `: ${dir}`)
      .replace('  http_listen_port: 3100', '  http_listen_address: 127.0.0.1\n  http_listen_port: 3100\n  grpc_listen_address: 127.0.0.1')
      .concat(`\ningester:\n  wal:\n    dir: ${dir}/wal\n`);
    const file = path.join(this.dataDir, 'loki.yaml');
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(file, config);
    return file;
  }

  writeGrafanaProvisioning() {
    const root = path.join(this.dataDir, 'grafana', 'provisioning');
    const dashboards = posix(path.join(this.stackDir, 'grafana', 'dashboards'));
    fs.mkdirSync(path.join(root, 'datasources'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dashboards'), { recursive: true });
    for (const sub of ['plugins', 'alerting', 'notifiers']) fs.mkdirSync(path.join(root, sub), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'datasources', 'loki.yaml'),
      fs.readFileSync(path.join(this.stackDir, 'grafana', 'provisioning', 'datasources', 'loki.yaml'), 'utf8').replace('http://loki:3100', LOKI_URL),
    );
    fs.writeFileSync(
      path.join(root, 'dashboards', 'dashboards.yaml'),
      fs.readFileSync(path.join(this.stackDir, 'grafana', 'provisioning', 'dashboards', 'dashboards.yaml'), 'utf8').replace('/var/lib/grafana/dashboards', dashboards),
    );
    return { root, home: `${dashboards}/log-analyzer.json` };
  }

  grafanaEnv() {
    const { root, home } = this.writeGrafanaProvisioning();
    const data = path.join(this.dataDir, 'grafana');
    return {
      ...process.env,
      GF_PATHS_DATA: data,
      GF_PATHS_LOGS: path.join(data, 'log'),
      GF_PATHS_PLUGINS: path.join(data, 'plugins'),
      GF_PATHS_PROVISIONING: root,
      GF_SERVER_HTTP_ADDR: '127.0.0.1',
      GF_SERVER_HTTP_PORT: '3000',
      GF_SECURITY_ADMIN_USER: 'admin',
      GF_SECURITY_ADMIN_PASSWORD: process.env.GRAFANA_ADMIN_PASSWORD || 'admin',
      GF_AUTH_ANONYMOUS_ENABLED: 'true',
      GF_AUTH_ANONYMOUS_ORG_ROLE: 'Viewer',
      GF_USERS_VIEWERS_CAN_EDIT: 'true',
      GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH: home,
      GF_ANALYTICS_REPORTING_ENABLED: 'false',
      GF_ANALYTICS_CHECK_FOR_UPDATES: 'false',
    };
  }

  launch(name, exe, args, options = {}) {
    const logDir = path.join(this.dataDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const out = fs.openSync(path.join(logDir, `${name}.log`), 'a');
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', out, out], ...options });
    fs.closeSync(out);
    child.on('exit', () => this.children.delete(name));
    this.children.set(name, child);
  }

  async start() {
    if (!this.installed) return { ok: false, output: 'Grafana/Loki are not bundled with this build (run npm run fetch-binaries).' };
    if (!(await SERVICES.loki()) && !this.children.has('loki')) {
      this.launch('loki', this.lokiExe, [`-config.file=${this.writeLokiConfig()}`]);
    }
    if (!(await SERVICES.grafana()) && !this.children.has('grafana')) {
      const home = path.join(this.vendorDir, 'grafana');
      this.launch('grafana', this.grafanaExe, ['server', '--homepath', home], { cwd: home, env: this.grafanaEnv() });
    }
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = await this.status();
      if (status.services.every((s) => s.state === 'running')) return { ok: true, output: 'Grafana and Loki are running.' };
      await new Promise((r) => setTimeout(r, 1500));
    }
    return { ok: false, output: `Not ready after ${READY_TIMEOUT_MS / 1000}s; see ${path.join(this.dataDir, 'logs')}.` };
  }

  // Only stops what this app started; an external (Docker) stack is left alone.
  async stop() {
    for (const child of this.children.values()) child.kill();
    this.children.clear();
    return { ok: true, output: 'Stopped.' };
  }

  async status() {
    const services = await Promise.all(
      Object.entries(SERVICES).map(async ([name, ready]) => {
        const up = await ready();
        const starting = !up && this.children.has(name);
        return {
          name,
          state: up ? 'running' : starting ? 'starting' : 'stopped',
          status: up ? (this.children.has(name) ? 'running (bundled)' : 'running (external)') : starting ? 'starting' : 'stopped',
        };
      }),
    );
    return { ok: true, services };
  }
}

module.exports = { NativeStack, GRAFANA_URL, LOKI_URL };
