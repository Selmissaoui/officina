'use strict';
// Ad, tracker and cookie-banner blocking for Officina's browsers, with the filter lists
// that Ghostery, uBlock Origin and Brave use (EasyList, EasyPrivacy, uBlock filters and
// the cookie-notice lists). Ads and consent pop-ups slow agents down and waste tokens.
// On by default; it can be switched off per browser, and kept off for chosen sites.
const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');
const { ElectronBlocker, BlockingContext } = require('@ghostery/adblocker-electron');

const PRELOAD = require.resolve('@ghostery/adblocker-electron-preload');
const REFRESH_DAYS = 7;

// The library registers its two IPC handlers each time blocking is switched on in a
// session. Electron allows one handler per channel and Officina has a session per
// browser, so a second browser would crash. Register them once and leave them.
let current = null; // the Adblock instance the shared handlers talk to
let handlersReady = false;
BlockingContext.prototype.enable = function enable() {
  if (this.blocker.config.loadCosmeticFilters) {
    this.preloadScriptId = this.session.registerPreloadScript({ type: 'frame', filePath: PRELOAD });
    if (!handlersReady) {
      handlersReady = true;
      ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (e, url, msg) => current?.cosmetics(e, url, msg));
      ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', e => current?.blocker?.onIsMutationObserverEnabled(e) ?? false);
    }
  }
  if (this.blocker.config.loadNetworkFilters) {
    this.session.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, this.onHeadersReceived);
    this.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, this.onBeforeRequest);
  }
};
BlockingContext.prototype.disable = function disable() {
  if (this.blocker.config.loadNetworkFilters) {
    this.session.webRequest.onHeadersReceived(null);
    this.session.webRequest.onBeforeRequest(null);
  }
  if (this.preloadScriptId !== undefined) {
    this.session.unregisterPreloadScript(this.preloadScriptId);
    this.preloadScriptId = undefined;
  }
};

const hostOf = url => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
const matches = (host, list) => !!host && list.some(s => host === s || host.endsWith(`.${s}`));

class Adblock {
  constructor({ ws, onCount = () => {} }) {
    this.ws = ws;
    this.onCount = onCount;
    this.cache = path.join(ws.root, 'adblock-engine.bin');
    this.blocker = null;
    this.error = '';
    this.counts = new Map();   // webContents id -> blocked requests on the current page
    this.sessions = new Map(); // session -> profile id, so a session can be switched later
    this.ready = null;
    current = this;
  }

  get settings() {
    const s = (this.ws.settings.adblock ||= {});
    s.enabled ??= true;
    s.off ||= [];   // browser profiles with blocking switched off
    s.allow ||= []; // sites (hostnames) where nothing is blocked
    return s;
  }

  // Loads the lists: from the cached engine when it is fresh, otherwise from the internet.
  load() {
    this.ready ||= (async () => {
      try {
        const st = fs.existsSync(this.cache) ? fs.statSync(this.cache) : null;
        if (st && Date.now() - st.mtimeMs > REFRESH_DAYS * 864e5) fs.rmSync(this.cache, { force: true });
        this.blocker = await ElectronBlocker.fromPrebuiltFull(fetch, { path: this.cache, read: fs.promises.readFile, write: fs.promises.writeFile });
        this.wrap(this.blocker);
        this.blocker.on('request-blocked', req => this.count(req.tabId));
        for (const [ses, profile] of this.sessions) this.apply(ses, profile);
      } catch (e) {
        this.error = `Ad blocking is not available: ${e.message}`;
      }
      return !!this.blocker;
    })();
    return this.ready;
  }

  // Pages on an allowed site get nothing blocked and no cosmetic filters.
  wrap(blocker) {
    const pageAllowed = details => matches(hostOf(details.webContents?.getURL?.() || details.referrer || ''), this.settings.allow);
    const before = blocker.onBeforeRequest, headers = blocker.onHeadersReceived;
    blocker.onBeforeRequest = (details, cb) => (pageAllowed(details) ? cb({}) : before(details, cb));
    blocker.onHeadersReceived = (details, cb) => (pageAllowed(details) ? cb({}) : headers(details, cb));
  }

  cosmetics(event, url, msg) {
    if (!this.blocker || matches(hostOf(url), this.settings.allow)) return undefined;
    return this.blocker.onInjectCosmeticFilters(event, url, msg);
  }

  count(wcId) {
    if (wcId == null) return;
    const n = (this.counts.get(wcId) || 0) + 1;
    this.counts.set(wcId, n);
    this.onCount(wcId, n);
  }

  resetCount(wcId) { this.counts.delete(wcId); this.onCount(wcId, 0); }

  // Called for every browser session; blocking follows the global switch and the browser's own.
  attach(ses, profile) {
    this.sessions.set(ses, profile);
    if (this.blocker) this.apply(ses, profile); else this.load();
  }

  apply(ses, profile) {
    const want = this.settings.enabled && !this.settings.off.includes(profile);
    const on = this.blocker.isBlockingEnabled(ses);
    if (want && !on) this.blocker.enableBlockingInSession(ses);
    if (!want && on) this.blocker.disableBlockingInSession(ses);
  }

  applyAll() { if (this.blocker) for (const [ses, profile] of this.sessions) this.apply(ses, profile); }

  isOn(profile) { return !!this.blocker && this.settings.enabled && !this.settings.off.includes(profile); }

  setBrowser(profile, on) {
    const s = this.settings;
    s.off = s.off.filter(p => p !== profile);
    if (!on) s.off.push(profile);
    this.ws.saveSettings();
    this.applyAll();
  }

  configure({ enabled, allow }) {
    const s = this.settings;
    if (typeof enabled === 'boolean') s.enabled = enabled;
    if (Array.isArray(allow)) s.allow = [...new Set(allow.map(h => String(h).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean))];
    this.ws.saveSettings();
    this.applyAll();
    return this.status();
  }

  status() {
    const s = this.settings;
    return { enabled: s.enabled, allow: s.allow, off: s.off, ready: !!this.blocker, error: this.error };
  }
}

module.exports = { Adblock, matches, hostOf };
