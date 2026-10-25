// Downloads the Windows builds of Grafana and Loki into vendor/, which the
// installer bundles so the app runs without Docker. Run: npm run fetch-binaries
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const VENDOR = path.join(__dirname, '..', 'vendor');
const BINARIES = [
  {
    name: 'grafana',
    version: '11.4.0',
    url: 'https://dl.grafana.com/oss/release/grafana-11.4.0.windows-amd64.zip',
    // The zip holds one folder, grafana-v11.4.0/, renamed to vendor/grafana.
    check: 'grafana/bin/grafana.exe',
  },
  {
    name: 'loki',
    version: '3.3.2',
    url: 'https://github.com/grafana/loki/releases/download/v3.3.2/loki-windows-amd64.exe.zip',
    check: 'loki/loki-windows-amd64.exe',
  },
];

const download = async (url, file) => {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file));
};

// Windows 10+ and GitHub's runners ship bsdtar, which unpacks zips.
const unzip = (zip, dir) => {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xf', zip, '-C', dir], { stdio: 'inherit' });
};

// Parts of the Grafana zip that a running server never reads (~165 MB):
// docs, the component storybook, npm build artifacts and JS source maps.
const pruneGrafana = (dir) => {
  for (const sub of ['docs', 'storybook', 'npm-artifacts', 'packaging', 'tools']) {
    fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
  }
  const removeMaps = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) removeMaps(full);
      else if (entry.name.endsWith('.map')) fs.rmSync(full);
    }
  };
  removeMaps(path.join(dir, 'public'));
};

const fetchBinary = async ({ name, version, url, check }) => {
  const target = path.join(VENDOR, name);
  const stamp = path.join(target, '.version');
  if (fs.existsSync(path.join(VENDOR, check)) && fs.readFileSync(stamp, 'utf8').trim() === version) {
    console.log(`${name} ${version}: already present`);
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
  const zip = path.join(VENDOR, `${name}.zip`);
  console.log(`${name} ${version}: downloading ${url}`);
  await download(url, zip);
  const staging = path.join(VENDOR, `${name}.tmp`);
  fs.rmSync(staging, { recursive: true, force: true });
  unzip(zip, staging);
  // Grafana's zip wraps everything in one top-level folder; Loki's is a single exe.
  const entries = fs.readdirSync(staging);
  const root = entries.length === 1 && fs.statSync(path.join(staging, entries[0])).isDirectory() ? path.join(staging, entries[0]) : staging;
  fs.renameSync(root, target);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
  if (!fs.existsSync(path.join(VENDOR, check))) throw new Error(`${name}: ${check} missing after unpacking`);
  if (name === 'grafana') pruneGrafana(target);
  fs.writeFileSync(stamp, version);
  console.log(`${name} ${version}: ready`);
};

(async () => {
  fs.mkdirSync(VENDOR, { recursive: true });
  for (const binary of BINARIES) await fetchBinary(binary);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
