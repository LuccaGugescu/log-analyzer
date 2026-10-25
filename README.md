# Log Analyzer

A Windows desktop app that pulls log files from any number of Linux servers over **SCP/SSH every 60 seconds** and ships them into a local **Grafana + Loki** stack that comes **bundled with the app**: one installer, no Docker.

```
 ┌────────────── Windows ───────────────┐
 │  Log Analyzer (Electron)             │        ┌─ server A (user@ip) ─┐
 │   every 60s ── scp / ssh tail ───────┼──────► │ /var/log/syslog      │
 │        │                             │        └──────────────────────┘
 │        ▼                             │        ┌─ server B (user@ip) ─┐
 │  %USERPROFILE%\LogAnalyzer\logs\     │ ─────► │ /var/log/nginx/*.log │
 │    <server>\<file>.log               │        └──────────────────────┘
 │        │                             │
 │  ┌─────┴──── bundled ─────────────┐  │
 │  │ app ─► Loki ─► Grafana :3000   │  │
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
- **Polling every 60 s** (configurable in the top bar, min 5 s). A slow server skips a beat instead of piling up overlapping transfers.
- **Two transfer modes**
  - `ssh tail` (default, lightest) — **one** SSH session per poll for all of the server's files, sending only the new bytes (max 4 MB per file per poll).
  - `scp` — copies each file with `scp`, then appends only the new bytes. Heavier: the whole file crosses the network every poll.
- **Only new, complete lines** are ingested: half-written last lines wait for the next poll, rotated/truncated files are detected and restart from the top, and the first pull of a file backfills at most its last 5 MB.
- **Grafana + Loki included** — the installer bundles the Windows builds of Grafana 11.4 and Loki 3.3; the app starts them when it opens and stops them when it closes (Start/Stop in the top bar). The app itself ships entries to Loki, so there is no separate log agent. Grafana Grafana opens on a provisioned **Log Analyzer** dashboard (volume per server, errors per server, level breakdown, full-text search, live log view). Logs are kept 30 days.
- **Dashboard built into the app** — the Dashboard tab shows Grafana inside the window (full Grafana: explore, edit, sign in). "Open in browser" is still there if you prefer a tab.
- Labels in Loki: `server` (the name you gave it) and `file` (the remote path), plus Loki's automatic `detected_level`.

## Requirements

- Windows 10/11
- Nothing else: Grafana and Loki come with the installer (about 200 MB). Docker is optional (see below).
- Windows' built-in OpenSSH client (`ssh`, `scp` — present by default on Windows 10 1809+)
- **Key-based SSH access** to each server. Password logins are deliberately not supported: polls run unattended, so `BatchMode=yes` is always on and nothing ever waits for a prompt.

## Install

Download `Log Analyzer Setup x.y.z.exe` from [Releases](../../releases), or build it yourself (below).

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
| Pulled logs (spool the app ships from) | `%USERPROFILE%\LogAnalyzer\logs\<server>\<file>.log` |
| Loki / Grafana data, their logs | `%USERPROFILE%\LogAnalyzer\data\` |

Grafana (`3000`) and Loki (`3100`) listen on `127.0.0.1` only. If something already answers on those ports, the app uses it instead of starting its own.

## Filtering logs

The **Dashboard** (Grafana dashboard) has a filter bar; every filter combines with the others and applies to all panels:

| Filter | How |
|---|---|
| Server / File / Level | pick one or more |
| Contains (regex) | type a word or regex, press Enter; add several to OR them (`error`, `timeout`, `user=(alice\|bob)`). Case-insensitive. |
| Excludes (regex) | same, hides matching lines (`health check`, `GET /static`) |
| Label filters | `+` to add `label = / != / =~ / !~ value`; or open a log line and click the **+ / −** magnifier next to a label to filter for / against it |

**Drilldown** (switch above the embedded Grafana, or the *Logs Drilldown* link on the dashboard) is Grafana's point-and-click log explorer: click any label or field value to include or exclude it, add line filters with regex, and see recurring log **patterns**.

Every line gets a `level` label (trace, debug, info, warn, error, fatal, or unknown) taken from the first level word in the line.

The dashboard JSON is generated: edit `stack/grafana/build-dashboard.js` and run `node stack/grafana/build-dashboard.js`.

## Stopping a server

**Stop** on a server card stops reading that server and removes everything it sent to Grafana:

1. no more SSH reads; a read already in flight is discarded;
2. its pulled files in `%USERPROFILE%\LogAnalyzer\logs\<server>\` are deleted;
3. its lines are deleted from Loki (`/loki/api/v1/delete`), with a second request 100 s later for anything still being shipped. Loki applies deletes with a delay, so the card shows "removing its logs from Grafana (N lines left)" until Loki returns none, usually within a few minutes. If the Grafana stack is not running, the cleanup waits and continues when it is.

**Start** reads the server again from its current files (the last 5 MB of each, as on a first pull). **Delete** removes the server and its logs the same way.

## Multi-line entries (payloads, stack traces)

A log entry that spans several lines stays **one entry** in Grafana: an API call followed by its request payload, the response line with its response payload, or an error with its stack trace:

```
2026-10-25T14:00:01Z INFO --> POST /api/orders req=r10003 user=alice
Request body:
{
  "items": [ { "sku": "SKU-13", "qty": 2 } ]
}
2026-10-25T14:00:01Z INFO <-- 201 POST /api/orders req=r10003 45ms
Response body:
{ "orderId": 5003, "status": "created" }
```

shows up as two entries (request + payload, response + payload). Filter **Contains** with `req=r10003` to see the call and its response together.

A new entry starts at a line beginning with a timestamp (`2026-10-25T14:00`, `2026/10/25 14:00`, `[25/Oct/2026:14:00`, `Oct 25 14:00:00`), a level word (`ERROR …`), a client IP (access logs) or a JSON-lines object (`{"time":…`). Every other line belongs to the entry above it. A file in which no line ever looks like an entry start keeps one entry per line, so unknown formats never collapse into one giant block. Entries are capped at 1000 lines.

## Try it with the mock server

No server handy? `mock/` runs a fake Linux box in Docker: key-only SSH on `127.0.0.1:2222` and a generator writing app, nginx and worker logs into `/var/log/mock` every 2 s. It also writes `app/api.log` with request/response payload blocks and stack traces, rotates `server.log` every ~3 minutes and leaves rotated files, archives, an empty file, a stale file and `wtmp` lying around, so you can watch discovery skip them.

```powershell
powershell -ExecutionPolicy Bypass -File mock\start-mock.ps1
```

It creates its SSH key in `mock\.ssh\` (git-ignored) and prints what to enter in **+ Add server**: user `mock`, IP `127.0.0.1`, log directory `/var/log/mock`, and under *Advanced* port `2222` and the key path. Stop it with `docker compose -f mock\docker-compose.yml down -v`.

## Docker instead of the bundled stack (optional)

```bash
cd stack
docker compose up -d
```

starts the same Loki + Grafana in Docker on the same ports; the app finds them and uses them instead of starting its own.
## Develop

```bash
npm install
npm start        # run the app
npm test         # unit tests
npm run dist     # download Grafana + Loki into vendor/, build dist\Log Analyzer Setup x.y.z.exe
```

```
src/main/       Electron main process
  main.js       window + IPC
  poller.js     poll loop (60 s default), per-server state, appends to the logs folder
  discovery.js  scans the log directory, picks live files, skips rotations
  fetcher.js    batched ssh-tail / scp transfer and offset logic
  ssh.js        spawns ssh.exe / scp.exe
  stack.js      starts/stops the bundled Loki + Grafana, writes their configs`n  shipper.js    pushes spooled entries to Loki (replaces a log agent)
  grafana-view.js  Grafana embedded as a native view in the window
  config.js     JSON config store
  validate.js   input validation and quoting
src/renderer/   UI (plain HTML/CSS/JS, no framework)
stack/          Loki config, Grafana provisioning + dashboard, optional docker-compose.yml`nscripts/        fetch-binaries.js: Windows builds of Grafana + Loki into vendor/
```

## License

MIT
