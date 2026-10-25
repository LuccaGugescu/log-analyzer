# Log Analyzer

A Windows desktop app that pulls log files from any number of Linux servers over **SCP/SSH every 15 seconds** and ships them into a local **Grafana + Loki** stack running in **Docker**.

```
 ┌────────────── Windows ───────────────┐
 │  Log Analyzer (Electron)             │        ┌─ server A (user@ip) ─┐
 │   every 15s ── scp / ssh tail ───────┼──────► │ /var/log/syslog      │
 │        │                             │        └──────────────────────┘
 │        ▼                             │        ┌─ server B (user@ip) ─┐
 │  %USERPROFILE%\LogAnalyzer\logs\     │ ─────► │ /var/log/nginx/*.log │
 │    <server>\<file>.log               │        └──────────────────────┘
 │        │                             │
 │  ┌─────┴──── Docker ──────────────┐  │
 │  │ Alloy ─► Loki ─► Grafana :3000 │  │
 │  └────────────────────────────────┘  │
 └──────────────────────────────────────┘
```

## Features

- **Multiple servers** — each one is a user, an IP/host and the log directory (e.g. `/var/log`). Port, private key and display name are optional.
- **Finds the logs for you** — every log file in the directory (4 levels deep) is discovered automatically. To keep load on the server low, only what matters is imported:
  - one file per rotation family: `server.log` is kept, `server.1.log`, `server.log.2`, `server-3.log`, `syslog.1`, `app-2026-10-24.log` are skipped (when there is no plain `server.log`, the newest rotation is used);
  - compressed archives (`.gz`, `.xz`, `.zip`…), binary files (`wtmp`, `lastlog`, `.journal`…), empty files and files untouched for 30+ days are skipped;
  - at most 50 files per server (most recently written first).
  "Scan log directory" in the Add server dialog shows exactly what will be imported and why each other file is skipped. The directory is re-scanned every 5 minutes, so new logs are picked up.
- **Polling every 15 s** (configurable, min 5 s). A slow server skips a beat instead of piling up overlapping transfers.
- **Two transfer modes**
  - `ssh tail` (default, lightest) — **one** SSH session per poll for all of the server's files, sending only the new bytes (max 4 MB per file per poll).
  - `scp` — copies each file with `scp`, then appends only the new bytes. Heavier: the whole file crosses the network every poll.
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
2. **+ Add server** → user (e.g. `root`), IP, and the log directory (default `/var/log`). Under *Advanced*: port, private key (blank = your default `~/.ssh` key / ssh-agent), transfer mode.
3. **Test connection**, then **Scan log directory** to preview which files will be imported.
4. Save. Polling starts automatically; the dot turns green after the first successful pull.
5. Switch to the **Dashboard** tab (or **Open Grafana** for http://localhost:3000 in your browser) (anonymous read access; admin login `admin` / `admin`, change it with `GRAFANA_ADMIN_PASSWORD`).

The remote user needs read access to the log directory and its files (e.g. add it to the `adm` group for `/var/log/syslog` on Debian/Ubuntu).

Host keys are trusted on first connection (`StrictHostKeyChecking=accept-new`) and pinned in your `known_hosts` after that.

### Where things live

| What | Path |
|---|---|
| Servers + settings | `%APPDATA%\log-analyzer\config.json` |
| Read offsets per file | `%APPDATA%\log-analyzer\offsets.json` |
| Pulled logs (mounted into Alloy) | `%USERPROFILE%\LogAnalyzer\logs\<server>\<file>.log` |
| Loki / Grafana data | Docker volumes `log-analyzer_loki-data`, `log-analyzer_grafana-data` |

All Docker ports bind to `127.0.0.1` only: Grafana `3000`, Loki `3100`, Alloy UI `12345`.

## Try it with the mock server

No server handy? `mock/` runs a fake Linux box in Docker: key-only SSH on `127.0.0.1:2222` and a generator writing app, nginx and worker logs into `/var/log/mock` every 2 s. It rotates `server.log` every ~3 minutes and leaves rotated files, archives, an empty file, a stale file and `wtmp` lying around, so you can watch discovery skip them.

```powershell
powershell -ExecutionPolicy Bypass -File mock\start-mock.ps1
```

It creates its SSH key in `mock\.ssh\` (git-ignored) and prints what to enter in **+ Add server**: user `mock`, IP `127.0.0.1`, log directory `/var/log/mock`, and under *Advanced* port `2222` and the key path. Stop it with `docker compose -f mock\docker-compose.yml down -v`.

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
  discovery.js  scans the log directory, picks live files, skips rotations
  fetcher.js    batched ssh-tail / scp transfer and offset logic
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
