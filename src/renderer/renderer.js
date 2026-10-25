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
    const statusText = server.enabled === false
      ? 'disabled'
      : !status ? 'waiting for first poll'
      : status.ok ? `ok · ${timeAgo(status.at)}`
      : `error · ${timeAgo(status.at)}`;

    const edit = el('button', { className: 'secondary small', textContent: 'Edit', onclick: () => openServerDialog(server) });
    const remove = el('button', { className: 'danger small', textContent: 'Delete', onclick: () => deleteServer(server) });

    const card = el('li', { className: 'server' }, [
      el('span', { className: `dot ${dotClass}`, title: statusText }),
      el('div', { className: 'server-main' }, [
        el('strong', { textContent: server.name }),
        el('span', { className: 'muted', textContent: ` ${server.target}:${server.port} · ${server.mode}` }),
        el('div', { className: 'muted small', textContent: statusText }),
        el('ul', { className: 'paths' }, server.paths.map((p) => el('li', { textContent: p }))),
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
    target: data.get('target'),
    port: Number(data.get('port')),
    identityFile: data.get('identityFile'),
    mode: data.get('mode'),
    enabled: serverForm.elements.enabled.checked,
    paths: String(data.get('paths')).split(/\r?\n/).map((p) => p.trim()).filter(Boolean),
  };
};

const openServerDialog = (server) => {
  serverForm.reset();
  feedback(null);
  $('#server-dialog-title').textContent = server ? `Edit ${server.name}` : 'Add server';
  const fields = serverForm.elements;
  fields.id.value = server?.id ?? '';
  fields.name.value = server?.name ?? '';
  fields.target.value = server?.target ?? '';
  fields.port.value = server?.port ?? 22;
  fields.identityFile.value = server?.identityFile ?? '';
  fields.mode.value = server?.mode ?? 'scp';
  fields.paths.value = (server?.paths ?? []).join('\n');
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

// ---------- browse remote files ----------

let browseFiles = [];
const selected = new Set();

const renderBrowse = () => {
  const filter = $('#browse-filter').value.toLowerCase();
  const list = $('#browse-list');
  list.replaceChildren();
  for (const file of browseFiles.filter((f) => f.toLowerCase().includes(filter))) {
    const box = el('input', { type: 'checkbox', checked: selected.has(file) });
    box.onchange = () => (box.checked ? selected.add(file) : selected.delete(file), updateBrowseCount());
    list.append(el('li', {}, [el('label', {}, [box, ` ${file}`])]));
  }
  updateBrowseCount();
};
const updateBrowseCount = () => ($('#browse-count').textContent = `${selected.size} selected · ${browseFiles.length} found`);

const listRemote = async () => {
  $('#browse-list').replaceChildren(el('li', { className: 'muted', textContent: 'Listing…' }));
  const result = await window.api.browseServer(readServerForm(), $('#browse-root').value.trim());
  if (!result.ok) {
    $('#browse-list').replaceChildren(el('li', { className: 'error', textContent: result.output }));
    return;
  }
  browseFiles = result.files;
  renderBrowse();
};

$('#browse-server').onclick = () => {
  const current = readServerForm();
  selected.clear();
  current.paths.forEach((p) => selected.add(p));
  browseFiles = [];
  $('#browse-filter').value = '';
  $('#browse-dialog').showModal();
  listRemote();
};
$('#browse-refresh').onclick = listRemote;
$('#browse-filter').oninput = renderBrowse;
$('#browse-cancel').onclick = () => $('#browse-dialog').close();
$('#browse-form').addEventListener('submit', (event) => {
  event.preventDefault();
  serverForm.elements.paths.value = [...selected].join('\n');
  $('#browse-dialog').close();
});

// ---------- polling ----------

const renderPolling = () => {
  const running = state.config.running;
  $('#poll-state').textContent = running ? 'running' : 'stopped';
  $('#poll-state').className = `pill ${running ? 'ok' : ''}`;
  $('#poll-toggle').textContent = running ? 'Stop' : 'Start';
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
  state.statuses[status.serverId] = status;
  renderServers();
});
window.api.onActivity(logActivity);

// ---------- docker stack ----------

const refreshStack = async () => {
  const result = await window.api.stackStatus();
  const pill = $('#stack-state');
  const running = result.services.filter((s) => s.state === 'running').length;
  if (!result.ok) {
    pill.textContent = 'docker unavailable';
    pill.className = 'pill err';
    pill.title = result.output ?? '';
  } else {
    pill.textContent = running === 0 ? 'stopped' : `${running}/3 running`;
    pill.className = `pill ${running === 3 ? 'ok' : running > 0 ? 'warn' : ''}`;
    pill.title = result.services.map((s) => `${s.name}: ${s.status}`).join('\n');
  }
};

const runStack = (button, action, label) =>
  withBusy(button, async () => {
    note(`${label}…`);
    const result = await action();
    note(result.ok ? `${label}: done` : `${label} failed:\n${result.output}`);
    await refreshStack();
  });

$('#stack-up').onclick = (event) =>
  runStack(event.target, window.api.stackUp, 'Starting Grafana stack').then(() => {
    // Grafana needs a few seconds after its container starts before it serves pages.
    if (dashboard.grafanaReachable === false) setTimeout(reloadDashboard, 5000);
  });
$('#stack-down').onclick = (event) => runStack(event.target, window.api.stackDown, 'Stopping Grafana stack');
$('#open-grafana').onclick = () => window.api.openGrafana();
$('#open-logs').onclick = () => window.api.openLogs();

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
