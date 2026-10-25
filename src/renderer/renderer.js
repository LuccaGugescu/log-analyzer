'use strict';

const $ = (selector) => document.querySelector(selector);
const state = { config: null, statuses: {} };
const MAX_ACTIVITY = 300;

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of [].concat(children)) node.append(child);
  return node;
};

const timeAgo = (iso) => {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return new Date(iso).toLocaleTimeString();
};

// ---------- activity ----------

const logActivity = ({ at, message }) => {
  const list = $('#activity');
  list.prepend(el('li', {}, [el('time', { textContent: new Date(at).toLocaleTimeString() }), ` ${message}`]));
  while (list.children.length > MAX_ACTIVITY) list.lastChild.remove();
};
const note = (message) => logActivity({ at: new Date().toISOString(), message });

// ---------- servers ----------

const renderServers = () => {
  const list = $('#server-list');
  list.replaceChildren();
  const { servers } = state.config;
  $('#empty-servers').hidden = servers.length > 0;

  for (const server of servers) {
    const status = state.statuses[server.id];
    const dotClass = server.enabled === false ? 'off' : !status ? 'idle' : status.ok ? 'ok' : 'err';
    const discovery = state.config.discovery?.[server.id];
    const statusText = server.enabled === false
      ? 'disabled'
      : !status ? 'waiting for first poll'
      : `${status.ok ? 'ok' : 'error'} · ${timeAgo(status.at)} · watching ${status.watching} files, skipped ${status.skipped}`;

    const edit = el('button', { className: 'secondary small', textContent: 'Edit', onclick: () => openServerDialog(server) });
    const remove = el('button', { className: 'danger small', textContent: 'Delete', onclick: () => deleteServer(server) });
    const watched = discovery
      ? el('details', { className: 'watched' }, [
          el('summary', { className: 'muted small', textContent: `Files in Grafana (${discovery.kept.length})` }),
          el('ul', { className: 'paths' }, discovery.kept.map((f) => el('li', { textContent: f.path }))),
        ])
      : '';

    const card = el('li', { className: 'server' }, [
      el('span', { className: `dot ${dotClass}`, title: statusText }),
      el('div', { className: 'server-main' }, [
        el('strong', { textContent: server.name }),
        el('span', { className: 'muted', textContent: ` ${server.user}@${server.host}:${server.port} · ${server.mode}` }),
        el('div', { className: 'muted small', textContent: statusText }),
        el('ul', { className: 'paths' }, server.logDirs.map((dir) => el('li', { textContent: `${dir}/` }))),
        watched,
        status && !status.ok ? el('pre', { className: 'feedback error', textContent: status.errors.join('\n') }) : '',
      ]),
      el('div', { className: 'server-actions' }, [edit, remove]),
    ]);
    list.append(card);
  }
};

const deleteServer = async (server) => {
  if (!confirm(`Delete server "${server.name}"? Logs already pulled stay on disk.`)) return;
  await window.api.deleteServer(server.id);
  await reloadConfig();
  note(`Removed ${server.name}`);
};

// ---------- server dialog ----------

const serverForm = $('#server-form');
const feedback = (text, isError = false) => {
  const box = $('#server-feedback');
  box.hidden = !text;
  box.textContent = text ?? '';
  box.classList.toggle('error', isError);
};

const readServerForm = () => {
  const data = new FormData(serverForm);
  return {
    id: data.get('id') || undefined,
    name: data.get('name'),
    user: data.get('user'),
    host: data.get('host'),
    port: Number(data.get('port')),
    identityFile: data.get('identityFile'),
    mode: data.get('mode'),
    enabled: serverForm.elements.enabled.checked,
    logDirs: String(data.get('logDirs')).split(/\r?\n/).map((p) => p.trim()).filter(Boolean),
  };
};

const openServerDialog = (server) => {
  serverForm.reset();
  feedback(null);
  $('#scan-result').hidden = true;
  $('#server-dialog-title').textContent = server ? `Edit ${server.name}` : 'Add server';
  const fields = serverForm.elements;
  fields.id.value = server?.id ?? '';
  fields.name.value = server?.name ?? '';
  fields.user.value = server?.user ?? '';
  fields.host.value = server?.host ?? '';
  fields.port.value = server?.port ?? 22;
  fields.identityFile.value = server?.identityFile ?? '';
  fields.mode.value = server?.mode ?? 'tail';
  fields.logDirs.value = (server?.logDirs ?? ['/var/log']).join('\n');
  fields.enabled.checked = server?.enabled !== false;
  $('#server-dialog').showModal();
};

const withBusy = async (button, task) => {
  button.disabled = true;
  try {
    return await task();
  } finally {
    button.disabled = false;
  }
};

serverForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await window.api.saveServer(readServerForm());
  if (!result.ok) return feedback(result.errors.join('\n'), true);
  $('#server-dialog').close();
  await reloadConfig();
  note(`Saved ${result.server.name}`);
});

$('#cancel-server').onclick = () => $('#server-dialog').close();
$('#add-server').onclick = () => openServerDialog(null);

$('#pick-key').onclick = async () => {
  const file = await window.api.pickKey();
  if (file) serverForm.elements.identityFile.value = file;
};

$('#test-server').onclick = (event) =>
  withBusy(event.target, async () => {
    feedback('Connecting…');
    const result = await window.api.testServer(readServerForm());
    feedback(result.output || (result.ok ? 'Connected.' : 'Failed.'), !result.ok);
  });

// ---------- scan preview ----------

// Shows which files polling will ship and why the others are left out, so the
// user can check the directory before saving.
const renderScan = ({ kept, skipped }) => {
  const box = $('#scan-result');
  const keptList = el('ul', { className: 'paths kept' }, kept.map((f) => el('li', { textContent: `${f.path}  (${formatSize(f.size)})` })));
  const skippedList = el('ul', { className: 'paths' }, skipped.map((f) => el('li', { textContent: `${f.path} — ${f.reason}` })));
  box.replaceChildren(
    el('strong', { textContent: `Will import ${kept.length} file${kept.length === 1 ? '' : 's'}` }),
    keptList,
    skipped.length > 0
      ? el('details', {}, [el('summary', { className: 'muted', textContent: `Skipped ${skipped.length} (rotated, old, empty or binary)` }), skippedList])
      : '',
  );
  box.hidden = false;
};

const formatSize = (bytes) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

$('#scan-server').onclick = (event) =>
  withBusy(event.target, async () => {
    feedback('Scanning…');
    $('#scan-result').hidden = true;
    const result = await window.api.scanServer(readServerForm());
    if (!result.ok) return feedback(result.output, true);
    feedback(null);
    renderScan(result);
  });

// ---------- toolbar status ----------

// One status chip + one action per control: the button only ever offers the
// next sensible step, and is orange only when that step is needed.
const setStatus = (selector, tone, text, title = '') => {
  const chip = $(selector);
  chip.querySelector('.dot').className = `dot ${tone}`;
  chip.querySelector('.status-text').textContent = text;
  chip.title = title;
};

const setAction = (button, label, primary) => {
  button.textContent = label;
  button.classList.toggle('secondary', !primary);
};

// ---------- polling ----------

const renderPolling = () => {
  const running = state.config.running;
  setStatus('#poll-state', running ? 'ok' : 'off', running ? 'running' : 'paused');
  setAction($('#poll-toggle'), running ? 'Pause' : 'Resume', !running);
  $('#poll-seconds').value = state.config.pollSeconds;
};

$('#poll-toggle').onclick = async () => {
  state.config.running = state.config.running ? await window.api.stopPolling() : await window.api.startPolling();
  renderPolling();
};
$('#poll-now').onclick = () => window.api.pollNow();
$('#poll-seconds').onchange = async (event) => {
  const saved = await window.api.saveSettings({ pollSeconds: event.target.value, autoStart: true });
  state.config.pollSeconds = saved.pollSeconds;
  renderPolling();
  note(`Poll interval set to ${saved.pollSeconds}s`);
};

window.api.onPollStatus((status) => {
  const previous = state.statuses[status.serverId];
  state.statuses[status.serverId] = status;
  // The watched-file list lives in config; refetch it only when it changed.
  if (previous?.watching !== status.watching || previous?.skipped !== status.skipped) reloadConfig();
  else renderServers();
});
window.api.onActivity(logActivity);

// ---------- docker stack ----------

const SERVICE_COUNT = 3;
const stack = { running: 0, busy: false };

const renderStack = (result) => {
  const button = $('#stack-toggle');
  button.disabled = stack.busy || !result.ok;
  if (!result.ok) {
    setStatus('#stack-state', 'err', 'Docker not running', result.output ?? '');
    setAction(button, 'Start', true);
    return;
  }
  stack.running = result.services.filter((s) => s.state === 'running').length;
  const details = result.services.map((s) => `${s.name}: ${s.status}`).join('\n');
  if (stack.running === SERVICE_COUNT) setStatus('#stack-state', 'ok', 'running', details);
  else if (stack.running > 0) setStatus('#stack-state', 'idle', `${stack.running}/${SERVICE_COUNT} up`, details);
  else setStatus('#stack-state', 'off', 'stopped', details);
  // Partly up still offers Start: `up -d` brings the missing services back.
  const fullyUp = stack.running === SERVICE_COUNT;
  setAction(button, fullyUp ? 'Stop' : 'Start', !fullyUp);
};

const refreshStack = async () => renderStack(await window.api.stackStatus());

$('#stack-toggle').onclick = async (event) => {
  const starting = stack.running < SERVICE_COUNT;
  const label = starting ? 'Starting Grafana stack' : 'Stopping Grafana stack';
  stack.busy = true;
  event.target.disabled = true;
  setStatus('#stack-state', 'idle', starting ? 'starting…' : 'stopping…');
  note(`${label}…`);
  const result = await (starting ? window.api.stackUp() : window.api.stackDown());
  note(result.ok ? `${label}: done` : `${label} failed:\n${result.output}`);
  stack.busy = false;
  await refreshStack();
  // Grafana needs a few seconds after its container starts before it serves pages.
  if (starting && dashboard.grafanaReachable === false) setTimeout(reloadDashboard, 5000);
};$('#open-logs').onclick = () => window.api.openLogs();

// ---------- embedded dashboard ----------

// Grafana is a native view drawn over #dashboard-host; the renderer only tells
// the main process where that box is. `grafanaReachable` stays null until the
// first load settles, and false hides the view so the offline hint shows.
const dashboard = { active: false, grafanaReachable: null };
const dashboardHost = $('#dashboard-host');

const placeGrafana = () => {
  if (!dashboard.active || dashboard.grafanaReachable === false) return window.api.hideGrafana();
  const { x, y, width, height } = dashboardHost.getBoundingClientRect();
  window.api.showGrafana({ x, y, width, height });
};

const showTab = (name) => {
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.tab === name);
  $('#tab-servers').hidden = name !== 'servers';
  $('#tab-dashboard').hidden = name !== 'dashboard';
  dashboard.active = name === 'dashboard';
  placeGrafana();
};

const reloadDashboard = () => {
  dashboard.grafanaReachable = null;
  $('#dashboard-offline').hidden = true;
  $('#dashboard-state').textContent = 'Loading Grafana…';
  window.api.reloadGrafana();
  placeGrafana();
};

window.api.onGrafanaState(({ ok, error }) => {
  dashboard.grafanaReachable = ok;
  $('#dashboard-offline').hidden = ok;
  $('#dashboard-state').textContent = ok ? 'Grafana · localhost:3000' : `Grafana unreachable (${error})`;
  placeGrafana();
});

for (const tab of document.querySelectorAll('.tab')) tab.onclick = () => showTab(tab.dataset.tab);
new ResizeObserver(placeGrafana).observe(dashboardHost);
$('#dashboard-reload').onclick = reloadDashboard;
$('#dashboard-external').onclick = () => window.api.openGrafana();

// ---------- boot ----------

const reloadConfig = async () => {
  state.config = await window.api.getConfig();
  renderServers();
  renderPolling();
};

reloadConfig().then(() => note(`Logs are written to ${state.config.logsDir}`));
refreshStack();
setInterval(refreshStack, 15_000);
setInterval(renderServers, 5_000);
