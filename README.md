# Log Analyzer

A Windows desktop app that pulls log files from any number of Linux servers over **SCP/SSH every 15 seconds** and ships them into a local **Grafana + Loki** stack running in **Docker**.

```
 ┌────────────── Windows ───────────────┐
 │  Log Analyzer (Electron)             │        ┌─ server A (user@ip) ─┐
 │   every 15s ── scp / ssh tail ───────┼──────► │ /var/log/syslog      │
 │        │                             │        └──────────────────────┘
 │        ▼                             │        ┌─ server B (user@ip) ─┐
 │  %APPDATA%\log-analyzer\logs\        │ ─────► │ /var/log/nginx/*.log │
 │    <server>\<file>.log               │        └──────────────────────┘
 │        │                             │
 │  ┌─────┴──── Docker ──────────────┐  │
 │  │ Alloy ─► Loki ─► Grafana :3000 │  │
 │  └────────────────────────────────┘  │
 └──────────────────────────────────────┘
```

## Features

- **Multiple servers** — each one is a `user@ip`, SSH port, optional private key and a list of remote log files.
- **Pick files from the server** — "Select files from server…" lists files under `/var/log` (or any folder) over SSH so you tick them instead of typing paths.
- **Polling every 15 s** (configurable, min 5 s). A slow server skips a beat instead of piling up overlapping transfers.
- **Two transfer modes**
  - `scp` — copies the file with `scp`, then appends only the bytes that are new since the last poll.
  - `ssh tail` — one SSH round trip that sends only the new bytes. Use it for big files.
- **Only new, complete lines** are ingested: half-written last lines wait for the next poll, rotated/truncated files are detected and restart from the top, and the first pull of a file backfills at most its last 5 MB.
- **One-click Docker stack** — Start/Stop Grafana, Loki and Alloy from the app; Grafana opens on a provisioned **Log Analyzer** dashboard (volume per server, errors per server, level breakdown, full-text search, live log view). Logs are kept 30 days.
- **Dashboard built into the app** — the Dashboard tab shows Grafana inside the window (full Grafana: explore, edit, sign in). "Open in browser" is still there if you prefer a tab.
- Labels in Loki: `server` (the name you gave it) and `file` (the remote path), plus Loki's automatic `detected_level`.

## Requirements

- Windows 10/11
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (running)
- Windows' built-in OpenSSH client (`ssh`, `scp` — present by default on Windows 10 1809+)
- **Key-based SSH access** to each server. Password logins are deliberately not supported: polls run unattended, so `BatchMode=yes` is always on and nothing ever waits for a prompt.

## Install

Download `Log Analyzer Setup x.y.z.exe` (installer) or `Log Analyzer x.y.z.exe` (portable) from [Releases](../../releases), or build it yourself (below).

## Usage

1. **Start** the Grafana stack from the top bar (first start pulls the images).
2. **+ Add server** → name, `user@ip`, port, private key (blank = your default `~/.ssh` key / ssh-agent).
3. **Test connection**, then **Select files from server…** or type paths one per line.
4. Save. Polling starts automatically; the dot turns green after the first successful pull.
5. Switch to the **Dashboard** tab (or **Open Grafana** for http://localhost:3000 in your browser) (anonymous read access; admin login `admin` / `admin`, change it with `GRAFANA_ADMIN_PASSWORD`).

The remote user needs read access to the selected files (e.g. add it to the `adm` group for `/var/log/syslog` on Debian/Ubuntu).

Host keys are trusted on first connection (`StrictHostKeyChecking=accept-new`) and pinned in your `known_hosts` after that.

### Where things live

| What | Path |
|---|---|
| Servers + settings | `%APPDATA%\log-analyzer\config.json` |
| Read offsets per file | `%APPDATA%\log-analyzer\offsets.json` |
| Pulled logs (mounted into Alloy) | `%APPDATA%\log-analyzer\logs\<server>\<file>.log` |
| Loki / Grafana data | Docker volumes `log-analyzer_loki-data`, `log-analyzer_grafana-data` |

All Docker ports bind to `127.0.0.1` only: Grafana `3000`, Loki `3100`, Alloy UI `12345`.

## Run the stack without the app

```bash
cd stack
docker compose up -d
```

With no `LOGS_DIR` set it ingests `stack/sample-logs/`, so you can try the dashboard straight away. Point it at your own folder with `LOGS_DIR=C:\path\to\logs`; Alloy expects `<folder>\<server>\<file>.log`.

## Develop

```bash
npm install
npm start        # run the app
npm test         # unit tests
npm run dist     # build dist\Log Analyzer Setup x.y.z.exe and the portable exe
```

```
src/main/       Electron main process
  main.js       window + IPC
  poller.js     15 s loop, per-server state, appends to the logs folder
  fetcher.js    scp / ssh-tail transfer and offset logic
  ssh.js        spawns ssh.exe / scp.exe
  docker.js     docker compose up / down / ps
  grafana-view.js  Grafana embedded as a native view in the window
  config.js     JSON config store
  validate.js   input validation and quoting
src/renderer/   UI (plain HTML/CSS/JS, no framework)
stack/          docker-compose.yml, Loki, Alloy and Grafana provisioning
```

## License

MIT
