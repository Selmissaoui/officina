'use strict';
// Brave as the canvas browser. Each browser profile gets its own headless Brave process
// with its own data folder in Officina-Data/brave/<profile>, so nothing is shared with
// the user's own Brave. Officina talks to it over the DevTools protocol: a canvas window
// shows the tab as a live picture (screencast) and passes the user's mouse and keys on,
// and agents drive the same tab through BravePage, which offers the parts of Electron's
// webContents that browserctl uses. Brave Shields do the ad blocking, which is why sites
// that detect ad blockers stay quiet here.
//
// Honesty line (same as the built-in browsers): the user agent string loses the
// "Headless" word, like the built-in browsers lose "Electron", and the client hints keep
// Brave's own real values. Nothing else is disguised: navigator.webdriver stays as Brave
// sets it and there is no fingerprint spoofing.
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const platform = require('./platform');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const FRAME_GAP = 66;       // at most ~15 pictures a second per window
const IDLE_CLOSE = 20000;   // a Brave without windows closes after this long
// Brave asks before a site may use "Sign in with Google". Headless Brave cannot show that
// question and quietly says no, so every profile allows it (the user can still block a site).
function allowGoogleSignIn(dir) {
  const f = path.join(dir, 'Default', 'Preferences');
  let prefs = {};
  try { prefs = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* new profile */ }
  const d = ((prefs.profile ||= {}).default_content_setting_values ||= {});
  if (d.brave_google_sign_in !== undefined) return;
  d.brave_google_sign_in = 1;
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(prefs)); } catch { /* Brave asks as usual */ }
}
const safeName = s => String(s).replace(/[^a-z0-9_-]/gi, '_').slice(0, 60) || 'default';

// ---------- one DevTools connection ----------
// Over a private pipe (--remote-debugging-pipe), not a network port: no other program on
// the computer can connect to these Brave processes. Each message ends with a NUL byte.
class Cdp extends EventEmitter {
  constructor(writable, readable) {
    super();
    this.out = writable;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    let buf = '';
    readable.setEncoding('utf8');
    readable.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\0')) >= 0) {
        const msg = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.onMessage(msg);
      }
    });
    const end = () => this.shut();
    readable.on('end', end);
    readable.on('error', end);
    writable.on('error', end);
  }

  onMessage(text) {
    let j;
    try { j = JSON.parse(text); } catch { return; }
    if (j.id && this.pending.has(j.id)) {
      const p = this.pending.get(j.id);
      this.pending.delete(j.id);
      if (j.error) p.reject(new Error(j.error.message || 'DevTools error')); else p.resolve(j.result || {});
    } else if (j.method) this.emit('event', j.method, j.params || {}, j.sessionId || null);
  }

  shut() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('Brave closed'));
    this.pending.clear();
    this.emit('close');
  }

  send(method, params = {}, sessionId = null) {
    if (this.closed) return Promise.reject(new Error('Brave is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.out.write(`${JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })}\0`); } catch (e) { this.pending.delete(id); reject(e); }
    });
  }

  close() { try { this.out.end(); } catch { /* already closed */ } }
}

// ---------- input conversion ----------
const MOD = { alt: 1, control: 2, ctrl: 2, meta: 4, command: 4, cmd: 4, shift: 8 };
const modBits = list => (list || []).reduce((n, m) => n | (MOD[String(m).toLowerCase()] || 0), 0);
const BUTTONS = { left: 1, right: 2, middle: 4 };

// Electron's key names (what browserctl sends) to DOM key, code and Windows key code.
const NAMED = {
  Return: ['Enter', 'Enter', 13], Enter: ['Enter', 'Enter', 13], Tab: ['Tab', 'Tab', 9], Escape: ['Escape', 'Escape', 27], Backspace: ['Backspace', 'Backspace', 8],
  Delete: ['Delete', 'Delete', 46], Up: ['ArrowUp', 'ArrowUp', 38], Down: ['ArrowDown', 'ArrowDown', 40], Left: ['ArrowLeft', 'ArrowLeft', 37], Right: ['ArrowRight', 'ArrowRight', 39],
  PageUp: ['PageUp', 'PageUp', 33], PageDown: ['PageDown', 'PageDown', 34], Home: ['Home', 'Home', 36], End: ['End', 'End', 35], Space: [' ', 'Space', 32],
};
function keyInfo(name) {
  if (NAMED[name]) { const [key, code, vk] = NAMED[name]; return { key, code, vk }; }
  const c = String(name);
  if (c.length === 1) {
    const up = c.toUpperCase();
    if (/[A-Z]/.test(up)) return { key: c, code: `Key${up}`, vk: up.charCodeAt(0) };
    if (/[0-9]/.test(c)) return { key: c, code: `Digit${c}`, vk: c.charCodeAt(0) };
    return { key: c, code: '', vk: 0 };
  }
  const f = c.match(/^F(\d{1,2})$/);
  if (f) return { key: c, code: c, vk: 111 + Number(f[1]) };
  return { key: c, code: c, vk: 0 };
}

// webContents.sendInputEvent format -> DevTools Input.* calls.
function fromElectron(ev) {
  const modifiers = modBits(ev.modifiers);
  switch (ev.type) {
    case 'mouseMove': {
      const down = (ev.modifiers || []).includes('leftButtonDown');
      return ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: ev.x, y: ev.y, modifiers, button: down ? 'left' : 'none', buttons: down ? 1 : 0 }];
    }
    case 'mouseDown':
    case 'mouseUp':
      return ['Input.dispatchMouseEvent', { type: ev.type === 'mouseDown' ? 'mousePressed' : 'mouseReleased', x: ev.x, y: ev.y, modifiers, button: ev.button || 'left', buttons: ev.type === 'mouseDown' ? BUTTONS[ev.button || 'left'] : 0, clickCount: ev.clickCount || 1 }];
    case 'mouseWheel':
      // Electron counts up as positive; DevTools counts down as positive.
      return ['Input.dispatchMouseEvent', { type: 'mouseWheel', x: ev.x, y: ev.y, modifiers, deltaX: -(ev.deltaX || 0), deltaY: -(ev.deltaY || 0) }];
    case 'keyDown':
    case 'keyUp': {
      const k = keyInfo(ev.keyCode);
      return ['Input.dispatchKeyEvent', { type: ev.type === 'keyDown' ? 'rawKeyDown' : 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers }];
    }
    case 'char':
      return ['Input.dispatchKeyEvent', { type: 'char', text: ev.keyCode, unmodifiedText: ev.keyCode, modifiers }];
    default:
      return null;
  }
}

// What the canvas window sends for the user's own mouse and keys -> DevTools Input.* calls.
function fromUser(ev) {
  const modifiers = modBits(ev.modifiers);
  if (ev.kind === 'mouse') {
    const type = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' }[ev.type];
    if (!type) return null;
    return ['Input.dispatchMouseEvent', { type, x: Math.round(ev.x), y: Math.round(ev.y), modifiers, button: ev.type === 'move' ? (ev.buttons & 1 ? 'left' : ev.buttons & 2 ? 'right' : 'none') : (ev.button || 'left'), buttons: ev.buttons || 0, clickCount: ev.type === 'move' ? 0 : ev.clickCount || 1 }];
  }
  if (ev.kind === 'wheel') return ['Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(ev.x), y: Math.round(ev.y), modifiers, deltaX: ev.deltaX || 0, deltaY: ev.deltaY || 0 }];
  if (ev.kind === 'key') {
    const text = ev.type === 'down' ? (ev.key === 'Enter' ? '\r' : (ev.key.length === 1 && !(modifiers & 2 && !(modifiers & 1)) && !(modifiers & 4) ? ev.key : '')) : '';
    return ['Input.dispatchKeyEvent', {
      type: ev.type === 'up' ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown', key: ev.key, code: ev.code || '', windowsVirtualKeyCode: ev.keyCode || 0, nativeVirtualKeyCode: ev.keyCode || 0,
      modifiers, autoRepeat: !!ev.repeat, location: ev.location || 0, ...(text ? { text, unmodifiedText: text } : {}),
    }];
  }
  if (ev.kind === 'text') return ['Input.insertText', { text: String(ev.text || '') }];
  return null;
}

// ---------- one tab, shaped like the parts of webContents browserctl needs ----------
let nextPageId = 1;

class BravePage extends EventEmitter {
  constructor({ engine, proc, itemId, targetId, sessionId }) {
    super();
    Object.assign(this, { engine, proc, itemId, targetId, sessionId });
    this.id = -(nextPageId++); // never collides with a real webContents id
    this.url = 'about:blank';
    this.title = '';
    this.loading = false;
    this.destroyed = false;
    this.history = { index: 0, length: 1 };
    this.world = null;       // isolated world context for browserctl's scripts
    this.blocked = 0;        // requests Brave Shields stopped on this page
    this.dialogInfo = null;
    this.cast = null;        // { maxWidth, maxHeight } while the canvas shows this tab
    this.lastFrame = null;
    this.sizeDelta = null;   // window size minus page size (headless adds a fake frame)
    const self = this;
    // browserctl attaches to webContents.debugger: this answers the same calls.
    this.debugger = Object.assign(new EventEmitter(), {
      isAttached: () => !self.destroyed,
      attach() {},
      detach() {},
      sendCommand: (method, params = {}) => self.send(method, params),
    });
    this.navigationHistory = {
      canGoBack: () => this.history.index > 0,
      canGoForward: () => this.history.index < this.history.length - 1,
      goBack: () => this.goHistory(-1),
      goForward: () => this.goHistory(1),
    };
  }

  send(method, params = {}) {
    if (this.destroyed) return Promise.reject(new Error('This Brave window is closed.'));
    return this.proc.cdp.send(method, params, this.sessionId);
  }

  async init({ userAgent, metadata }) {
    // Without Brave's own client hints an override would blank them, so then leave it all as Brave sends it.
    if (userAgent && metadata) await this.send('Emulation.setUserAgentOverride', { userAgent, userAgentMetadata: metadata }).catch(() => {});
    await Promise.all([
      this.send('Page.enable'), this.send('Network.enable'), this.send('Runtime.enable'),
      this.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {}),
      this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {}),
    ]);
    await this.refreshHistory();
  }

  // ---------- events from Brave for this tab ----------
  onEvent(method, params) {
    this.debugger.emit('message', {}, method, params);
    switch (method) {
      case 'Page.frameStartedLoading':
        if (params.frameId === this.targetId) { this.loading = true; this.blocked = 0; this.changed({ loading: true, blocked: 0 }); }
        break;
      case 'Page.frameStoppedLoading':
        if (params.frameId === this.targetId) {
          this.loading = false;
          this.changed({ loading: false });
          this.emit('did-stop-loading');
          if (this.comfortsApplied) this.applyComforts();
          // Title changes do not always arrive as target updates in headless mode.
          this.proc.cdp.send('Target.getTargetInfo', { targetId: this.targetId }).then(r => this.onTargetInfo(r.targetInfo)).catch(() => {});
        }
        break;
      case 'Page.frameNavigated':
        if (!params.frame.parentId) { this.url = params.frame.url; this.world = null; this.refreshHistory(); this.changed({ url: this.url }); }
        break;
      case 'Page.navigatedWithinDocument':
        if (params.frameId === this.targetId) { this.url = params.url; this.refreshHistory(); this.changed({ url: this.url }); }
        break;
      case 'Runtime.executionContextsCleared':
        this.world = null;
        break;
      case 'Network.loadingFailed':
        if (/ERR_BLOCKED_BY_CLIENT/.test(params.errorText || '')) { this.blocked++; this.changed({ blocked: this.blocked }); }
        break;
      case 'Page.javascriptDialogOpening':
        // A page asking "leave this page?" never holds a navigation up.
        if (params.type === 'beforeunload') { this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); break; }
        this.dialogInfo = { type: params.type, message: String(params.message || '').slice(0, 2000), defaultPrompt: params.defaultPrompt || '' };
        this.changed({ dialog: this.dialogInfo });
        break;
      case 'Page.javascriptDialogClosed':
        this.dialogInfo = null;
        this.changed({ dialog: null });
        break;
      case 'Page.fileChooserOpened':
        this.engine.emit('file-chooser', this.itemId, params);
        break;
      case 'Page.screencastFrame':
        this.onFrame(params);
        break;
      default:
    }
  }

  onTargetInfo(info) {
    const patch = {};
    if (info.title !== undefined && info.title !== this.title) patch.title = this.title = info.title;
    if (info.url && info.url !== this.url) patch.url = this.url = info.url;
    if (Object.keys(patch).length) this.changed(patch);
  }

  shown() { return !this.engine.pages || this.engine.pages.get(this.itemId) === this; }

  // Only the tab a canvas window shows speaks for it; any tab's title or address updates the tab list.
  changed(patch) {
    if (patch.title !== undefined || patch.url !== undefined) this.engine.emitTabs?.(this.itemId);
    if (this.shown()) this.engine.emit('state', this.itemId, patch);
  }

  state() {
    return { url: this.url, title: this.title, loading: this.loading, blocked: this.blocked, canGoBack: this.navigationHistory.canGoBack(), canGoForward: this.navigationHistory.canGoForward(), dialog: this.dialogInfo, live: !this.destroyed };
  }

  async refreshHistory() {
    try {
      const h = await this.send('Page.getNavigationHistory');
      this.history = { index: h.currentIndex, length: h.entries.length, entries: h.entries };
      this.changed({ canGoBack: this.navigationHistory.canGoBack(), canGoForward: this.navigationHistory.canGoForward() });
    } catch { /* closed */ }
  }

  goHistory(step) {
    const e = this.history.entries?.[this.history.index + step];
    if (e) this.send('Page.navigateToHistoryEntry', { entryId: e.id }).catch(() => {});
  }

  // ---------- the webContents surface ----------
  isDestroyed() { return this.destroyed; }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  isLoading() { return this.loading; }

  loadURL(url) {
    this.loading = true;
    return this.send('Page.navigate', { url }).then(r => { if (r.errorText && r.errorText !== 'net::ERR_ABORTED') throw new Error(r.errorText); });
  }

  reload() { return this.send('Page.reload').catch(() => {}); }

  async evaluate(expression, contextId) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'Script failed');
    return r.result?.value;
  }

  executeJavaScript(code) { return this.evaluate(code); }

  // Scripts run in a world of their own, so the page cannot see or tamper with them.
  // The world is kept until the page changes, so element refs survive between calls.
  async executeJavaScriptInIsolatedWorld(_worldId, scripts) {
    const code = scripts.map(s => s.code).join('\n');
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.world) this.world = (await this.send('Page.createIsolatedWorld', { frameId: this.targetId, worldName: 'officina', grantUniveralAccess: false })).executionContextId;
      try { return await this.evaluate(code, this.world); } catch (e) {
        if (attempt === 0 && /context/i.test(e.message)) { this.world = null; continue; }
        throw e;
      }
    }
    return undefined;
  }

  sendInputEvent(ev) {
    const call = fromElectron(ev);
    if (call) this.send(...call).catch(() => {});
  }

  insertText(text) { return this.send('Input.insertText', { text: String(text) }); }

  // Editing commands, the same names webContents has (used for Cmd shortcuts on a Mac).
  editCommand(command) { return this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: '', commands: [command] }).then(() => this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '' })); }
  selectAll() { return this.editCommand('selectAll'); }
  copy() { return this.editCommand('copy'); }
  paste() { return this.editCommand('paste'); }
  cut() { return this.editCommand('cut'); }
  undo() { return this.editCommand('undo'); }

  async capturePage() {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    return this.engine.nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
  }

  async printToPDF(opts = {}) {
    const { data } = await this.send('Page.printToPDF', { printBackground: opts.printBackground !== false });
    return Buffer.from(data, 'base64');
  }

  // Zoom and mute are page settings here (headless Brave has no zoom or volume of its own):
  // they are applied again after every page load.
  setZoomFactor(z) { this.zoom = Number(z) || 1; return this.applyComforts(); }
  setAudioMuted(m) { this.muted = !!m; return this.applyComforts(); }
  applyComforts() {
    if (this.destroyed || ((this.zoom || 1) === 1 && !this.muted && !this.comfortsApplied)) return Promise.resolve();
    this.comfortsApplied = true;
    return this.executeJavaScriptInIsolatedWorld(0, [{ code: `(() => { document.documentElement.style.zoom = ${JSON.stringify(String(this.zoom || 1))};
      for (const m of document.querySelectorAll('audio,video')) m.muted = ${!!this.muted}; return true; })()` }]).catch(() => false);
  }
  findInPage(text) { return this.executeJavaScriptInIsolatedWorld(0, [{ code: `window.find(${JSON.stringify(String(text))}, false, false, true)` }]).catch(() => false); }
  stopFindInPage() { return this.executeJavaScriptInIsolatedWorld(0, [{ code: 'getSelection().removeAllRanges(); true' }]).catch(() => false); }

  // ---------- the live picture ----------
  // The canvas window reports its size and zoom often (every zoom step). Updates run one at
  // a time and only the newest waiting one counts. After a size or scale change the picture
  // restarts: a page that does not repaint by itself would otherwise keep showing a frame
  // made at the old scale inside the new, bigger window (page small in a corner).
  view(v) {
    this.wantView = this.lastView = v;
    if (!this.viewing) this.viewing = this.applyViews().finally(() => { this.viewing = null; });
    return this.viewing;
  }

  async applyViews() {
    while (this.wantView && !this.destroyed) {
      const v = this.wantView;
      this.wantView = null;
      const key = () => this.size && `${this.size.w}x${this.size.h}@${this.size.scale}`;
      const before = key();
      if (v.w > 0 && v.h > 0) await this.resize(v.w, v.h, v.scale).catch(() => {});
      if (!v.visible) { await this.stopCast(); continue; }
      if (before !== key() && this.cast) { await this.stopCast(); await sleep(150); }
      await this.startCast({ maxWidth: v.maxW || 1600, maxHeight: v.maxH || 1200 });
    }
  }

  async startCast({ maxWidth = 1600, maxHeight = 1200 } = {}) {
    const want = { maxWidth: Math.round(maxWidth), maxHeight: Math.round(maxHeight) };
    if (this.cast && this.cast.maxWidth === want.maxWidth && this.cast.maxHeight === want.maxHeight) return;
    if (this.cast) await this.stopCast();
    this.cast = want;
    await this.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, ...want }).catch(() => {});
  }

  async stopCast() {
    if (!this.cast) return;
    this.cast = null;
    await this.send('Page.stopScreencast').catch(() => {});
  }

  onFrame(params) {
    const meta = { w: this.size?.w || params.metadata.deviceWidth, h: this.size?.h || params.metadata.deviceHeight };
    this.lastFrame = { data: Buffer.from(params.data, 'base64'), meta };
    if (this.shown()) this.engine.emit('frame', this.itemId, this.lastFrame.data, meta);
    // Acknowledge a little later: Brave sends the next picture only after the ack.
    const wait = Math.max(0, FRAME_GAP - (Date.now() - (this.lastAck || 0)));
    setTimeout(() => { this.lastAck = Date.now(); this.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {}); }, wait);
  }

  // The page is exactly as big as the canvas window's content area.
  async resize(width, height, scale = 1) {
    width = Math.max(200, Math.round(width));
    height = Math.max(120, Math.round(height));
    scale = Math.max(1, Math.min(4, Number(scale) || 1));
    if (this.size && this.size.w === width && this.size.h === height && this.size.scale === scale) return;
    this.size = { w: width, h: height, scale };
    const { windowId } = await this.proc.cdp.send('Browser.getWindowForTarget', { targetId: this.targetId });
    const d = this.sizeDelta || { w: 16, h: 89 };
    await this.proc.cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: width + d.w, height: height + d.h } });
    if (!this.sizeDelta) {
      const got = await this.evaluate('({ w: innerWidth, h: innerHeight })').catch(() => null);
      if (got && got.w > 0) {
        this.sizeDelta = { w: width + d.w - got.w, h: height + d.h - got.h };
        if (got.w !== width || got.h !== height) await this.proc.cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: width + this.sizeDelta.w, height: height + this.sizeDelta.h } });
      }
    }
    // Screencast is capped by the host window's physical surface, even with DPR emulation.
    const chrome = this.sizeDelta || d;
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await this.proc.cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: Math.ceil(width * scale) + chrome.w, height: Math.ceil(height * scale) + chrome.h } });
  }

  // ---------- for the user in the canvas ----------
  userInput(ev) {
    // Headless Brave on a Mac has no menu bar to turn Cmd+A/C/X/Z into editing commands.
    if (process.platform === 'darwin' && ev.kind === 'key' && ev.type === 'down' && (ev.modifiers || []).includes('meta')) {
      const edit = { a: 'selectAll', c: 'copy', x: 'cut', z: (ev.modifiers || []).includes('shift') ? 'redo' : 'undo' }[String(ev.key).toLowerCase()];
      if (edit) return this.editCommand(edit).catch(() => {});
    }
    const call = fromUser(ev);
    if (call) return this.send(...call).catch(() => {});
    return null;
  }

  // The mouse pointer shape under the user's cursor (hand on links, I-beam in text).
  async cursorAt(x, y) {
    const code = `(() => { let e = document.elementFromPoint(${Number(x)}, ${Number(y)}); while (e && e.shadowRoot) { const i = e.shadowRoot.elementFromPoint(${Number(x)}, ${Number(y)}); if (!i || i === e) break; e = i; }
      if (!e) return 'default'; const c = getComputedStyle(e).cursor; if (c && c !== 'auto') return c;
      if (e.isContentEditable || (e.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/.test(e.type)) || e.tagName === 'TEXTAREA') return 'text';
      return e.closest('a[href],button,[role=button],label,summary,select') ? 'pointer' : 'default'; })()`;
    return this.executeJavaScriptInIsolatedWorld(0, [{ code }]).catch(() => 'default');
  }

  // Selected text, for Ctrl+C in the canvas (headless Brave has its own clipboard).
  selection() {
    return this.executeJavaScriptInIsolatedWorld(0, [{ code: `(() => { const a = document.activeElement; if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'password')) && a.selectionEnd > a.selectionStart) return a.value.slice(a.selectionStart, a.selectionEnd); return String(getSelection() || ''); })()` }]).catch(() => '');
  }

  answerDialog(accept, promptText = '') {
    return this.send('Page.handleJavaScriptDialog', { accept: !!accept, promptText: String(promptText) });
  }

  markDestroyed() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.changed({ live: false });
    this.emit('destroyed');
  }
}

// ---------- the engine: processes, tabs and routing ----------
class BraveEngine extends EventEmitter {
  constructor({ root, exePath, nativeImage, downloadsDir }) {
    super();
    this.root = path.join(root, 'brave');
    this.exePath = exePath;          // () => path to brave.exe or null
    this.nativeImage = nativeImage;
    this.downloadsDir = downloadsDir || path.join(this.root, '_downloads');
    this.procs = new Map();          // profile -> proc
    this.pages = new Map();          // itemId -> BravePage: the tab the canvas window shows
    this.tabs = new Map();           // itemId -> [BravePage]: every tab in that window
    this.incoming = new Map();       // itemId -> tabs its page opened that are still being attached
    this.opening = new Map();        // itemId -> Promise<BravePage>
    this.signing = new Map();        // profile -> { child, done } while a normal sign-in window is open
  }

  installed() { return !!this.exePath(); }

  profileDir(profile) { return path.join(this.root, safeName(profile)); }

  // ---------- processes ----------
  proc(profile) {
    // While the user signs in in a normal Brave window, the profile is theirs: wait for it.
    const s = this.signing.get(profile);
    if (s) return s.done.then(() => this.proc(profile));
    let p = this.procs.get(profile);
    if (p) { clearTimeout(p.idleTimer); return p.ready; }
    p = { profile, child: null, cdp: null, items: new Set(), targets: new Map(), keeper: null, ua: null, meta: null, downloads: new Map() };
    this.procs.set(profile, p);
    p.ready = this.launch(p).then(() => p).catch(e => { if (this.procs.get(profile) === p) this.procs.delete(profile); try { p.child?.kill(); } catch { /* gone */ } throw e; });
    return p.ready;
  }

  async launch(p) {
    const exe = this.exePath();
    if (!exe) throw new Error('Brave is not installed in this space. Install it under Settings, Software in this space.');
    const dir = this.profileDir(p.profile);
    fs.mkdirSync(dir, { recursive: true });
    this.killStale(dir);
    allowGoogleSignIn(dir);
    const args = [
      `--user-data-dir=${dir}`, '--headless=new', '--remote-debugging-pipe',
      '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen', '--window-size=1280,800',
      // macOS: keep Brave's cookie key in the profile instead of asking the Keychain (no password prompts).
      ...(platform.isMac ? ['--use-mock-keychain'] : []),
    ];
    p.child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
    let exited = null;
    p.child.once('error', () => { exited = 'error'; this.onExit(p); });
    if (p.child.pid) fs.writeFileSync(path.join(dir, 'officina.pid'), String(p.child.pid));
    p.child.once('exit', code => { exited = code ?? 'signal'; fs.rmSync(path.join(dir, 'officina.pid'), { force: true }); this.onExit(p); });
    p.cdp = new Cdp(p.child.stdio[3], p.child.stdio[4]);
    p.cdp.on('event', (method, params, sessionId) => this.route(p, method, params, sessionId));
    p.cdp.on('close', () => this.onExit(p));
    const version = await Promise.race([p.cdp.send('Browser.getVersion').catch(() => null), sleep(20000).then(() => null)]);
    if (!version) throw new Error(exited !== null ? `Brave stopped right after starting (exit ${exited}).` : 'Brave did not start in time.');
    version['User-Agent'] = version.userAgent;
    // The tab Brave opens by itself is never shown: it reports Brave's real client hints
    // and keeps the process alive while windows come and go.
    const { targetInfos } = await p.cdp.send('Target.getTargets');
    const first = targetInfos.find(t => t.type === 'page');
    if (first) {
      p.keeper = first.targetId;
      try {
        const { sessionId } = await p.cdp.send('Target.attachToTarget', { targetId: first.targetId, flatten: true });
        let v = {};
        // On a fresh profile the start page needs a moment before it has navigator.userAgentData.
        for (let i = 0; i < 20 && !v.brands; i++) {
          if (i) await sleep(150);
          const r = await p.cdp.send('Runtime.evaluate', { expression: `navigator.userAgentData ? navigator.userAgentData.getHighEntropyValues(['architecture','bitness','fullVersionList','model','platformVersion','wow64']).then(v => ({ ...v, brands: navigator.userAgentData.brands, platform: navigator.userAgentData.platform, mobile: navigator.userAgentData.mobile, ua: navigator.userAgent })) : ({ ua: navigator.userAgent })`, returnByValue: true, awaitPromise: true }, sessionId).catch(() => null);
          v = r?.result?.value || {};
        }
        p.ua = String(v.ua || version['User-Agent'] || '').replace(/HeadlessChrome\//, 'Chrome/');
        if (v.brands) p.meta = { brands: v.brands, fullVersionList: v.fullVersionList, platform: v.platform, platformVersion: v.platformVersion, architecture: v.architecture, model: v.model || '', mobile: !!v.mobile, bitness: v.bitness, wow64: !!v.wow64 };
        await p.cdp.send('Page.navigate', { url: 'about:blank' }, sessionId).catch(() => {});
        await p.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      } catch { /* the user agent stays as Brave reports it */ }
    }
    if (!p.ua) p.ua = String(version['User-Agent'] || '').replace(/HeadlessChrome\//, 'Chrome/');
    await p.cdp.send('Target.setDiscoverTargets', { discover: true });
    fs.mkdirSync(this.downloadsDir, { recursive: true });
    await p.cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: this.downloadsDir, eventsEnabled: true }).catch(() => {});
  }

  // A Brave left behind by a crash of Officina still holds the profile: stop it first.
  // Only a process whose pid we wrote AND whose command line names this profile folder.
  killStale(dir) {
    const pidFile = path.join(dir, 'officina.pid');
    let pid;
    try { pid = Number(fs.readFileSync(pidFile, 'utf8')); } catch { return; }
    if (!pid || [...this.procs.values()].some(p => p.child?.pid === pid)) return;
    try { if (platform.commandLine(pid).includes(dir)) process.kill(pid); } catch { /* not running */ }
    fs.rmSync(pidFile, { force: true });
  }

  onExit(p) {
    if (p.dead) return;
    p.dead = true;
    if (this.procs.get(p.profile) === p) this.procs.delete(p.profile);
    for (const itemId of p.items) {
      const page = this.pages.get(itemId);
      if (!page || page.proc !== p) continue;
      for (const t of this.tabs.get(itemId) || []) if (t !== page) t.markDestroyed();
      page.markDestroyed();
      this.pages.delete(itemId);
      this.tabs.delete(itemId);
    }
    try { p.child?.kill(); } catch { /* gone */ }
    p.cdp?.close();
    this.emit('procs');
  }

  tabOf(itemId, targetId) { return (this.tabs.get(itemId) || []).find(t => t.targetId === targetId) || null; }

  route(p, method, params, sessionId) {
    if (sessionId) {
      for (const itemId of p.items) {
        const tab = (this.tabs.get(itemId) || []).find(t => t.sessionId === sessionId);
        if (tab) { tab.onEvent(method, params); return; }
      }
      return;
    }
    if (method === 'Target.targetInfoChanged' || method === 'Target.targetCreated') {
      const info = params.targetInfo;
      if (info.type !== 'page' || info.targetId === p.keeper) return;
      const itemId = p.targets.get(info.targetId);
      if (itemId) this.tabOf(itemId, info.targetId)?.onTargetInfo(info);
      else if (method === 'Target.targetCreated') this.maybePopup(p, info);
    } else if (method === 'Target.targetDestroyed') {
      // A tab closed by its page (a login popup that is done): the window goes back to the
      // tab before it. Only the last tab closing closes the canvas window.
      const itemId = p.targets.get(params.targetId);
      const tab = itemId ? this.tabOf(itemId, params.targetId) : null;
      if (!tab || tab.closing) return;
      if ((this.tabs.get(itemId) || []).length > 1) this.dropTab(itemId, tab);
      else this.emit('closed-by-page', itemId);
    } else if (method === 'Browser.downloadWillBegin') {
      p.downloads.set(params.guid, { name: params.suggestedFilename || 'download', url: params.url });
      this.emit('download', { profile: p.profile, state: 'started', ...p.downloads.get(params.guid) });
    } else if (method === 'Browser.downloadProgress' && params.state !== 'inProgress') {
      const d = p.downloads.get(params.guid);
      p.downloads.delete(params.guid);
      if (d) this.emit('download', { profile: p.profile, state: params.state, file: path.join(this.downloadsDir, params.guid), ...d });
    }
  }

  // A page opened a new tab or window (target=_blank, window.open): it becomes a new tab in
  // the same canvas window and is shown at once, so whoever clicked (the user or an agent)
  // simply carries on in it. Tabs we create ourselves are known before this short wait ends.
  async maybePopup(p, info) {
    let itemId = info.openerId ? p.targets.get(info.openerId) : null;
    // No opener (rel=noopener): with one window in this profile it can only come from there.
    if (!itemId && p.items.size === 1) [itemId] = p.items;
    if (itemId) this.incoming.set(itemId, (this.incoming.get(itemId) || 0) + 1);
    try {
      await sleep(400);
      if (p.targets.has(info.targetId) || p.dead || !itemId || !this.pages.get(itemId)) return;
      await this.addTab(p, itemId, info.targetId).catch(e => this.emit('tab-failed', itemId, e.message));
    } finally {
      if (itemId) this.incoming.set(itemId, this.incoming.get(itemId) - 1);
    }
  }

  // Waits (briefly) until tabs a page just opened have arrived, so a click can report them.
  async tabSettled(itemId, ms = 3000) {
    const end = Date.now() + ms;
    while (this.incoming.get(itemId) > 0 && Date.now() < end) await sleep(50);
  }

  async addTab(p, itemId, targetId) {
    p.targets.set(targetId, itemId);
    const { sessionId } = await p.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new BravePage({ engine: this, proc: p, itemId, targetId, sessionId });
    this.tabs.get(itemId).push(page);
    await page.init({ userAgent: p.ua, metadata: p.meta });
    try { page.onTargetInfo((await p.cdp.send('Target.getTargetInfo', { targetId })).targetInfo); } catch { /* keep going */ }
    this.activate(itemId, page);
    return page;
  }

  // Show another tab of a canvas window: its picture, its address, and agents act in it.
  activate(itemId, page) {
    const prev = this.pages.get(itemId);
    if (!page || prev === page || page.destroyed) return;
    if (prev && !prev.destroyed) prev.stopCast().catch(() => {});
    this.pages.set(itemId, page);
    const v = prev?.lastView;
    if (v) page.view(v).catch(() => {});
    this.emit('tab', itemId, page);
    this.emitTabs(itemId);
  }

  dropTab(itemId, tab) {
    const list = this.tabs.get(itemId) || [];
    const i = list.indexOf(tab);
    if (i < 0) return;
    list.splice(i, 1);
    tab.proc.targets.delete(tab.targetId);
    if (this.pages.get(itemId) === tab) this.activate(itemId, list[Math.max(0, i - 1)] || list[0]);
    tab.markDestroyed();
    this.emitTabs(itemId);
  }

  async closeTab(itemId, index) {
    const list = this.tabs.get(itemId) || [];
    const tab = list[index ?? list.indexOf(this.pages.get(itemId))];
    if (!tab) throw new Error('There is no such tab.');
    if (list.length < 2) throw new Error('This is the only tab: close the window instead.');
    tab.closing = true;
    this.dropTab(itemId, tab);
    await tab.proc.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
  }

  switchTab(itemId, index) {
    const tab = (this.tabs.get(itemId) || [])[index];
    if (!tab) throw new Error('There is no such tab.');
    this.activate(itemId, tab);
  }

  tabList(itemId) {
    const list = this.tabs.get(itemId) || [];
    const active = this.pages.get(itemId);
    return { tabs: list.map(t => ({ title: t.title || t.url, url: t.url })), activeTab: list.indexOf(active) };
  }

  emitTabs(itemId) {
    if (this.tabs.has(itemId)) this.emit('state', itemId, this.tabList(itemId));
  }

  // ---------- canvas windows ----------
  open(itemId, opts) {
    if (this.pages.has(itemId) && !this.pages.get(itemId).destroyed) return Promise.resolve(this.pages.get(itemId));
    if (this.opening.has(itemId)) return this.opening.get(itemId);
    const job = this._open(itemId, opts).finally(() => this.opening.delete(itemId));
    this.opening.set(itemId, job);
    return job;
  }

  async _open(itemId, { profile, url, width = 900, height = 600, adopt = null }) {
    const p = await this.proc(profile);
    let targetId = adopt && p.targets.has(adopt) ? adopt : null;
    if (!targetId) ({ targetId } = await p.cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true, width: Math.round(width + 16), height: Math.round(height + 89) }));
    p.targets.set(targetId, itemId);
    const { sessionId } = await p.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new BravePage({ engine: this, proc: p, itemId, targetId, sessionId });
    p.items.add(itemId);
    this.pages.set(itemId, page);
    this.tabs.set(itemId, [page]);
    await page.init({ userAgent: p.ua, metadata: p.meta });
    await page.resize(width, height).catch(() => {});
    if (targetId === adopt) {
      // A popup is already loading its page: reload it once so the user agent fix applies.
      try { const info = (await p.cdp.send('Target.getTargetInfo', { targetId })).targetInfo; page.onTargetInfo(info); } catch { /* keep going */ }
    } else if (url) {
      page.loadURL(url).catch(() => {});
    }
    this.emit('procs');
    return page;
  }

  async close(itemId) {
    const page = this.pages.get(itemId);
    const list = this.tabs.get(itemId) || [];
    this.pages.delete(itemId);
    this.tabs.delete(itemId);
    if (!page) return;
    const p = page.proc;
    p.items.delete(itemId);
    for (const tab of list.includes(page) ? list : [page, ...list]) {
      tab.closing = true;
      p.targets.delete(tab.targetId);
      tab.markDestroyed();
      await p.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
    }
    if (!p.items.size) {
      clearTimeout(p.idleTimer);
      p.idleTimer = setTimeout(() => { if (!p.items.size && this.procs.get(p.profile) === p) this.stopProc(p); }, IDLE_CLOSE);
    }
  }

  async stopProc(p) {
    try { await Promise.race([p.cdp?.send('Browser.close'), sleep(2500)]); } catch { /* already gone */ }
    try { p.child?.kill(); } catch { /* gone */ }
    this.onExit(p);
  }

  async stopProfile(profile) {
    const p = this.procs.get(profile);
    if (p) await this.stopProc(await p.ready.catch(() => p));
  }

  // Google and Apple refuse to sign in on a browser that is driven over DevTools. Then the
  // user signs in in a normal Brave window on the same profile: no DevTools connection, no
  // headless, just Brave. The logins stay in the profile; when that window is closed the
  // canvas windows of this profile start again, signed in.
  async signIn(profile, url) {
    if (this.signing.has(profile)) return false;
    const exe = this.exePath();
    if (!exe) throw new Error('Brave is not installed in this space.');
    const items = [...this.pages.values()].filter(pg => pg.proc.profile === profile).map(pg => pg.itemId);
    const p = this.procs.get(profile);
    if (p) { await this.stopProc(await p.ready.catch(() => p)); await sleep(300); }
    const dir = this.profileDir(profile);
    allowGoogleSignIn(dir);
    const child = spawn(exe, [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen',
      ...(platform.isMac ? ['--use-mock-keychain'] : []), /^https?:/i.test(url || '') ? url : 'https://accounts.google.com/'], { stdio: 'ignore' });
    const done = new Promise(r => { child.once('exit', r); child.once('error', r); });
    this.signing.set(profile, { child, done });
    this.emit('signin', { profile, items, active: true });
    done.then(() => { this.signing.delete(profile); this.emit('signin', { profile, items, active: false }); });
    return true;
  }

  // "Done" in the canvas: close the sign-in window the polite way, so Brave saves its cookies.
  finishSignIn(profile) {
    const s = this.signing.get(profile);
    if (!s?.child.pid) return false;
    const stop = force => platform.isMac ? s.child.kill(force ? 'SIGKILL' : 'SIGTERM')
      : spawn('taskkill', ['/pid', String(s.child.pid), ...(force ? ['/t', '/f'] : [])], { stdio: 'ignore', windowsHide: true });
    stop(false);
    // Brave on Windows ignores a polite close from outside; by then the login has long been saved.
    setTimeout(() => { if (this.signing.get(profile) === s) stop(true); }, 4000);
    return true;
  }

  async stopAll() {
    for (const profile of this.signing.keys()) this.finishSignIn(profile);
    await Promise.all([...this.procs.values()].map(p => this.stopProc(p)));
  }

  // Signs a profile out everywhere: its Brave folder is removed (Shields lists come back by themselves).
  async clearProfile(profile) {
    const items = [...this.pages.values()].filter(pg => pg.proc.profile === profile).map(pg => pg.itemId);
    await this.stopProfile(profile);
    await sleep(300);
    fs.rmSync(this.profileDir(profile), { recursive: true, force: true });
    return items;
  }

  async wipe() {
    await this.stopAll();
    await sleep(400);
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  page(itemId) { return this.pages.get(itemId) || null; }

  pids() { return [...this.procs.values()].map(p => p.child?.pid).filter(Boolean); }
}

module.exports = { BraveEngine, BravePage, Cdp, fromElectron, fromUser, keyInfo, safeName };
