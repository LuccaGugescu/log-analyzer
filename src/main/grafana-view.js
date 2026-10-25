'use strict';

const { WebContentsView, shell } = require('electron');

// Shows Grafana inside the app window as a native view laid over the
// renderer's dashboard area. A top-level view (not an iframe) keeps Grafana's
// login cookies and frame protections working without loosening its config.
class GrafanaView {
  constructor({ window, url, onState }) {
    this.window = window;
    this.url = url;
    this.onState = onState;
    this.view = null;
    this.visible = false;
  }

  ensureView() {
    if (this.view) return this.view;
    const { origin } = new URL(this.url);
    this.view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const contents = this.view.webContents;

    // Stay on Grafana; anything else (docs, external links) opens in the browser.
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http')) shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (new URL(url).origin === origin) return;
      event.preventDefault();
      shell.openExternal(url);
    });

    // A failed load still ends in did-finish-load (Chromium's error page), so
    // the outcome is decided once loading stops, not on finish.
    let failure = null;
    contents.on('did-start-loading', () => (failure = null));
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      // -3 = ERR_ABORTED: a newer load (e.g. Reload) replaced this one.
      if (isMainFrame && code !== -3) failure = description || `error ${code}`;
    });
    contents.on('did-stop-loading', () => this.onState(failure ? { ok: false, error: failure } : { ok: true }));

    this.load();
    return this.view;
  }

  show(bounds) {
    const view = this.ensureView();
    view.setBounds(roundBounds(bounds));
    if (!this.visible) {
      this.window.contentView.addChildView(view);
      this.visible = true;
    }
  }

  hide() {
    if (!this.view || !this.visible) return;
    this.window.contentView.removeChildView(this.view);
    this.visible = false;
  }

  // A refused connection rejects loadURL; did-fail-load already reports it.
  load() {
    this.view.webContents.loadURL(`${this.url}/d/log-analyzer`).catch(() => {});
  }

  reload() {
    if (this.view) this.load();
  }

  // Runs on the window's "closed" event, when the window is already destroyed
  // and can no longer detach child views.
  destroy() {
    if (!this.view) return;
    if (!this.window.isDestroyed()) this.hide();
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
    this.visible = false;
  }
}

const roundBounds = ({ x, y, width, height }) => ({
  x: Math.round(x),
  y: Math.round(y),
  width: Math.max(0, Math.round(width)),
  height: Math.max(0, Math.round(height)),
});

module.exports = { GrafanaView };
