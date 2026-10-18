'use strict';
const { app, BrowserWindow, ipcMain, session, protocol, net, dialog, shell, safeStorage, Menu, clipboard, webContents, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const APP_ROOT = path.join(__dirname, '..');
// A build made to share (npm run release) is locked: no DevTools and no debugging ports,
// so the app's own code is not one keypress away. Development builds stay open.
const LOCKED = app.isPackaged && !!(() => { try { return require(path.join(APP_ROOT, 'package.json')).officinaLocked; } catch { return false; } })();
if (LOCKED && process.argv.some(a => /^--(remote-debugging-(port|pipe)|inspect(-brk)?|js-flags)/.test(a))) app.exit(1);

// ---------- container: all Chromium + app data under one folder ----------
function resolveDataDir() {
  const arg = process.argv.find(a => a.startsWith('--workspace='));
  if (arg) return path.resolve(arg.slice('--workspace='.length));
  if (process.env.AGENT_CANVAS_WORKSPACE) return path.resolve(process.env.AGENT_CANVAS_WORKSPACE);
  if (process.env.PORTABLE_EXECUTABLE_DIR) return withRename(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'Officina-Data'));
  // On a Mac the app bundle is read-only (and may run from a quarantine copy): the space
  // lives in one folder under Application Support instead.
  if (app.isPackaged && process.platform === 'darwin') return path.join(app.getPath('appData'), 'Officina', 'Officina-Data');
  if (app.isPackaged) return withRename(path.join(path.dirname(process.execPath), 'Officina-Data'));
  return path.join(APP_ROOT, 'workspace-dev');
}
// The app used to be called Agent Canvas: carry its data folder over once.
function withRename(dir) {
  const old = path.join(path.dirname(dir), 'AgentCanvas-Data');
  try { if (!fs.existsSync(dir) && fs.existsSync(old)) fs.renameSync(old, dir); } catch { /* in use: start fresh beside it */ }
  return dir;
}
const DATA = resolveDataDir();
fs.mkdirSync(path.join(DATA, 'chromium'), { recursive: true });
app.setPath('userData', path.join(DATA, 'chromium'));
app.setPath('sessionData', path.join(DATA, 'chromium'));
app.setPath('crashDumps', path.join(DATA, 'chromium', 'crashes'));
app.setAppLogsPath(path.join(DATA, 'logs'));

// Browsers present as plain Chromium/Chrome (no "Electron/x" or app token in the UA).
function cleanUA(ua) {
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = new Set([app.getName(), app.getName().replace(/\s+/g, ''), 'officina', 'Officina', 'Officina']);
  let out = ua.replace(/\s?Electron\/\S+/g, '');
  for (const n of names) out = out.replace(new RegExp(`\\s?${esc(n)}\\/\\S+`, 'gi'), '');
  return out;
}
app.userAgentFallback = cleanUA(app.userAgentFallback);

protocol.registerSchemesAsPrivileged([
  { scheme: 'ac', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const { Workspace } = require('./workspace');
const { Activity, localDay } = require('./activity');
const { KeyStore } = require('./keys');
const { Trading } = require('./trading');
const { BrowserControl } = require('./browserctl');
const { McpServer } = require('./mcp');
const { SessionKeeper, partitionFor } = require('./sessions');
const { AiCursor } = require('./cursor');
const { Team } = require('./team');
const { Engine } = require('./engine');
const { Adblock } = require('./adblock');
const { Agents } = require('./agents');
const { agentStore } = require('./cursor');
const { Software } = require('./software');
const { BraveEngine } = require('./brave');
const { newId } = require('./store');
const { RamMeter } = require('./ram');
const { Connectors } = require('./connectors');
const { Peek } = require('./peek');

let win = null;
let peek, ws, activity, keys, trading, browsers, mcp, keeper, cursor, assistant, agents, engine, adblock, software, brave, ram, connectors;
let extra;
let paused = false;
let lastAgentCall = null;
let mcpError = null;

if (!app.requestSingleInstanceLock({ dataDir: DATA })) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(boot).catch(err => {
    dialog.showErrorBox('Officina failed to start', String(err?.stack || err));
    app.exit(1);
  });
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function settingsDefaults() {
  const s = ws.settings;
  let changed = false;
  if (!s.mcpToken) { s.mcpToken = crypto.randomBytes(24).toString('hex'); changed = true; }
  if (!s.mcpPort) { s.mcpPort = 4780; changed = true; }
  if (s.mcpEnabled === undefined) { s.mcpEnabled = true; changed = true; }
  if (changed) ws.saveSettings();
}

function mcpStatus() {
  return {
    running: !!mcp?.server, port: mcp?.port || ws.settings.mcpPort, token: ws.settings.mcpToken, enabled: ws.settings.mcpEnabled,
    url: `http://127.0.0.1:${mcp?.port || ws.settings.mcpPort}/mcp`, error: mcpError, lastCall: lastAgentCall,
  };
}

async function startMcp() {
  mcpError = null;
  if (!ws.settings.mcpEnabled) return;
  try {
    await mcp.start(ws.settings.mcpPort);
  } catch (e) {
    mcpError = e.code === 'EADDRINUSE' ? `Port ${ws.settings.mcpPort} is in use. Pick another port in the Agent panel.` : e.message;
  }
  send('mcp:status', mcpStatus());
}

function setupSession(ses) {
  ses.setUserAgent(cleanUA(ses.getUserAgent()));
  const profile = (ses.getStoragePath() || '').match(/Partitions[\\/]ac-([a-z0-9_-]+)$/i)?.[1];
  if (profile) adblock?.attach(ses, profile);
  ses.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'notifications'].includes(permission));
  });
  // Downloads land inside the container, never in the user's Downloads folder.
  ses.on('will-download', (_e, item) => {
    const name = item.getFilename().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'download';
    const rel = ws.uniqueRel(`downloads/${name}`);
    const abs = ws.safePath(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    item.setSavePath(abs);
    activity.log('browser', 'download.started', `${name} from ${item.getURL()}`);
    item.once('done', (_ev, state) => {
      if (state === 'completed') {
        ws.recordFile(rel, 'browser', { source: item.getURL() });
        activity.log('browser', 'download.completed', rel);
      } else {
        activity.log('browser', 'download.failed', `${name}: ${state}`);
      }
    });
  });
}

function itemIdForWc(wcId) {
  for (const [itemId, id] of browsers.wcByItem) if (id === wcId) return itemId;
  return null;
}

function openInCanvasFromGuest(guest, url) {
  const srcId = itemIdForWc(guest.id);
  const src = srcId && ws.getItem(srcId);
  ws.addItem({ type: 'browser', url, title: (() => { try { return new URL(url).hostname; } catch { return 'Browser'; } })(), profile: src?.profile, hint: src ? { x: src.x + src.w + 40, y: src.y } : undefined, w: src?.w, h: src?.h }, 'user');
}

function guestContextMenu(guest, params) {
  const t = [];
  if (params.linkURL) {
    t.push({ label: 'Open link in new canvas browser', click: () => openInCanvasFromGuest(guest, params.linkURL) });
    t.push({ label: 'Copy link', click: () => clipboard.writeText(params.linkURL) });
    t.push({ type: 'separator' });
  }
  if (params.isEditable) {
    t.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
  } else if (params.selectionText) {
    t.push({ role: 'copy' });
  }
  if (params.mediaType === 'image' && params.srcURL) t.push({ label: 'Save image to workspace', click: () => guest.downloadURL(params.srcURL) });
  if (t.length) t.push({ type: 'separator' });
  t.push(
    { label: 'Back', enabled: guest.navigationHistory.canGoBack(), click: () => guest.navigationHistory.goBack() },
    { label: 'Forward', enabled: guest.navigationHistory.canGoForward(), click: () => guest.navigationHistory.goForward() },
    { label: 'Reload', click: () => guest.reload() },
    { type: 'separator' },
  );
  const itemId = itemIdForWc(guest.id);
  const item = itemId && ws.getItem(itemId);
  if (item) {
    const act = action => () => send('item:action', itemId, action);
    t.push(
      { label: 'Duplicate window', click: act('duplicate') },
      { label: 'Zoom to this window', click: act('zoom') },
      { label: 'Size', submenu: [
        { label: 'Small', click: act('size:small') }, { label: 'Medium', click: act('size:medium') },
        { label: 'Large', click: act('size:large') }, { label: 'Fill the screen', click: act('size:fill') },
      ] },
      { label: item.locked ? 'Unlock position' : 'Lock position', click: act('lock') },
      { label: 'Copy page address', click: () => clipboard.writeText(guest.getURL()) },
      { type: 'separator' },
      { label: 'Close window', click: act('close') },
    );
    if (ws.settings.ui?.mode === 'technical' && !LOCKED) t.push({ type: 'separator' }, { label: 'Inspect element', click: () => guest.inspectElement(params.x, params.y) });
  }
  Menu.buildFromTemplate(t).popup();
}

app.on('session-created', ses => setupSession(ses));

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() === 'webview') {
    contents.on('did-navigate', () => adblock?.resetCount(contents.id));
    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (!/^https?:/i.test(url)) return { action: 'deny' };
      // Links opened "in a new tab" become a new browser window on the canvas
      // (same profile). Real popups (OAuth / sign-in windows) need window.opener,
      // so they open as a small native window sharing the same session.
      if (disposition === 'foreground-tab' || disposition === 'background-tab') {
        openInCanvasFromGuest(contents, url);
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, backgroundColor: '#ffffff', webPreferences: { session: contents.session, nodeIntegration: false, contextIsolation: true, sandbox: true } },
      };
    });
    contents.on('context-menu', (_ev, params) => guestContextMenu(contents, params));
    contents.on('will-navigate', (ev, url) => { if (!/^(https?:|about:blank)/i.test(url)) ev.preventDefault(); });
  }
});

function createWindow() {
  // --officina-window=1920x1080 opens the window at an exact size (for screenshots and videos) instead of maximised.
  const fixed = (process.argv.find(a => a.startsWith('--officina-window=')) || '').slice(18).match(/^(\d{3,4})x(\d{3,4})$/);
  win = new BrowserWindow({
    width: fixed ? Number(fixed[1]) : 1500, height: fixed ? Number(fixed[2]) : 920, useContentSize: !!fixed, minWidth: 900, minHeight: 600, show: false,
    backgroundColor: '#0f1115', title: 'Officina', autoHideMenuBar: true,
    icon: path.join(APP_ROOT, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webviewTag: true, plugins: true, spellcheck: false, backgroundThrottling: false, devTools: !LOCKED,
    },
  });
  // macOS needs an application menu for Cmd+C/V/X/A/Z and Cmd+Q; Windows has none.
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]) : null);
  win.webContents.on('will-attach-webview', (ev, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.backgroundThrottling = false; // keep pages (and their keep-alive timers) running when off-screen
    webPreferences.spellcheck = true;
    if (!/^persist:ac-[a-z0-9_-]+$/i.test(params.partition || '')) ev.preventDefault();
    if (params.src && !/^(https?:|about:blank)/i.test(params.src)) ev.preventDefault();
  });
  win.webContents.on('will-navigate', ev => ev.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) ws.addItem({ type: 'browser', url, title: new URL(url).hostname }, 'user');
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (!LOCKED && input.type === 'keyDown' && (input.key === 'F12' || ((input.control || input.meta) && (input.shift || input.alt) && input.key.toLowerCase() === 'i'))) win.webContents.toggleDevTools();
  });
  win.once('ready-to-show', () => { if (!fixed) win.maximize(); win.show(); });
  win.loadURL('ac://app/renderer/index.html');
  win.on('closed', () => { win = null; });
}

function registerProtocol() {
  const appRoots = [path.join(APP_ROOT, 'renderer'), path.join(APP_ROOT, 'node_modules', 'marked'), path.join(APP_ROOT, 'node_modules', 'dompurify')];
  protocol.handle('ac', req => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    let abs;
    if (u.host === 'app') {
      abs = path.resolve(APP_ROOT, rel);
      if (!appRoots.some(r => abs === r || abs.startsWith(r + path.sep))) return new Response('Not found', { status: 404 });
    } else if (u.host === 'ws') {
      try { abs = ws.safePath(rel); } catch { return new Response('Forbidden', { status: 403 }); }
    } else {
      return new Response('Not found', { status: 404 });
    }
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(abs).toString()).catch(() => new Response('Not found', { status: 404 }));
  });
}

// ---------- Brave: the default browser of the space ----------
// Brave runs from Officina-Data/software with its own profiles in Officina-Data/brave.
// New browser windows use it once it is installed (Settings can switch back to the
// built-in browser). Existing windows keep the engine they were made with, because a
// login lives in that engine's profile.
const pendingAdopt = new Map(); // item id -> Brave tab a page opened by itself (popup)
const braveSaves = new Map();   // item id -> timer for saving url/title

function braveWanted() {
  return (ws.settings.browserEngine || 'brave') === 'brave';
}

function openBrave(item) {
  if (!brave || brave.page(item.id) || !software.exePath('brave')) return;
  const adopt = pendingAdopt.get(item.id) || null;
  pendingAdopt.delete(item.id);
  brave.open(item.id, { profile: item.profile, url: item.url, width: item.w - 2, height: item.h - 40, adopt })
    .then(page => { browsers.attach(item.id, page.id); send('brave:state', item.id, { ...page.state(), ...brave.tabList(item.id), installed: true }); })
    .catch(e => { activity.log('browser', 'brave.failed', e.message); send('brave:state', item.id, { live: false, error: e.message }); });
}

function openAllBrave() {
  for (const it of ws.listItems()) if (it.type === 'browser' && it.engine === 'brave') openBrave(it);
}

function setupBrave() {
  software = new Software({ root: DATA });
  brave = new BraveEngine({ root: DATA, exePath: () => software.exePath('brave'), nativeImage, downloadsDir: path.join(DATA, 'brave', '_downloads') });
  browsers.external = brave;
  ws.browserEngine = () => (braveWanted() && software.exePath('brave') ? 'brave' : 'builtin');
  software.beforeChange.set('brave', () => brave.stopAll());
  software.on('status', list => send('software:status', list));

  brave.on('frame', (id, data, meta) => send('brave:frame', id, data, meta));
  brave.on('state', (id, patch) => {
    send('brave:state', id, patch);
    if (patch.url === undefined && patch.title === undefined) return;
    clearTimeout(braveSaves.get(id));
    braveSaves.set(id, setTimeout(() => {
      braveSaves.delete(id);
      const page = brave.page(id), it = ws.getItem(id);
      if (!page || !it) return;
      const p = {};
      if (/^https?:/i.test(page.url) && page.url !== it.url) p.url = page.url;
      if (page.title && !it.renamed && page.title !== it.title) p.title = page.title.slice(0, 120);
      if (Object.keys(p).length) ws.updateItem(id, p, 'browser');
    }, 600));
  });
  // A page opened a tab or popup of its own: it is now the shown tab of the same window, so
  // browserctl (and with it every agent) acts in the new tab without having to look for it.
  brave.on('tab', (id, page) => {
    browsers.attach(id, page.id);
    send('brave:state', id, { ...page.state(), ...brave.tabList(id), installed: true });
  });
  brave.on('tab-failed', (id, msg) => activity.log('browser', 'brave.tab.failed', msg));
  brave.on('signin', ({ profile, active }) => {
    const items = ws.listItems().filter(it => it.type === 'browser' && it.engine === 'brave' && it.profile === profile);
    for (const it of items) { send('brave:state', it.id, { signin: active }); if (!active) openBrave(it); }
    activity.log('user', active ? 'browser.signin.started' : 'browser.signin.done', profile);
  });
  brave.on('closed-by-page', id => { if (ws.getItem(id)) ws.removeItem(id, 'browser'); });
  brave.on('download', d => {
    if (d.state === 'started') return activity.log('browser', 'download.started', `${d.name} from ${d.url}`);
    if (d.state !== 'completed') { fs.rmSync(d.file, { force: true }); return activity.log('browser', 'download.failed', `${d.name}: ${d.state}`); }
    try {
      const name = d.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'download';
      const rel = ws.uniqueRel(`downloads/${name}`);
      const abs = ws.safePath(rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.renameSync(d.file, abs);
      ws.recordFile(rel, 'browser', { source: d.url });
      activity.log('browser', 'download.completed', rel);
    } catch (e) { activity.log('browser', 'download.failed', `${d.name}: ${e.message}`); }
  });
  // Headless Brave cannot show a file picker, so Officina shows its own and passes the choice on.
  brave.on('file-chooser', async (id, info) => {
    const page = brave.page(id);
    if (!page || !win) return;
    const r = await dialog.showOpenDialog(win, { title: 'Choose a file to upload', properties: info.mode === 'selectMultiple' ? ['openFile', 'multiSelections'] : ['openFile'] });
    if (!r.canceled && r.filePaths.length) page.send('DOM.setFileInputFiles', { files: r.filePaths, backendNodeId: info.backendNodeId }).catch(() => {});
  });

  ram = new RamMeter({ app, extraPids: () => [...brave.pids(), ...engine.pids()] });
  ram.start();

  // Brave is the standard browser: install it once by itself when it is missing.
  if (braveWanted() && !software.exePath('brave') && !ws.settings.braveAutoInstallTried) {
    ws.settings.braveAutoInstallTried = new Date().toISOString();
    ws.saveSettings();
    software.install('brave').then(() => { activity.log('system', 'software.installed', 'Brave'); openAllBrave(); }).catch(e => activity.log('system', 'software.failed', e.message));
  }
}

// The STOP button, from the toolbar, a phone (signals) or a linked chat.
function setPaused(value) {
  paused = !!value;
  trading.setHalted(paused);
  if (paused) { cursor.hide(); assistant.stop(); extra?.handoffs.cancelAll(); }
  activity.log('user', paused ? 'agent.stopped' : 'agent.resumed', '');
  send('paused', paused);
  return paused;
}

// Earlier versions sent notifications to one Telegram chat; that bot and chat become a linked connector.
function migrateTelegramNotifications() {
  const n = ws.settings.notify;
  const c = (ws.settings.connectors ||= {});
  if (!n?.botTokenEnc || n.botTokenEnc.startsWith('plain:') || c.telegram?.tokenEnc) return;
  c.telegram = { enabled: !!n.telegram, notify: true, agentId: '', tokenEnc: n.botTokenEnc, links: n.chatId ? [{ chatId: String(n.chatId), name: 'Notifications chat', linkedAt: new Date().toISOString() }] : [] };
  n.telegram = false;
  ws.saveSettings();
}

async function boot() {
  ws = new Workspace(DATA);
  ws.init();
  settingsDefaults();
  activity = new Activity(DATA);
  keys = new KeyStore(ws.dirs.secrets, safeStorage);
  trading = new Trading({ ws, keys, activity });
  browsers = new BrowserControl();
  cursor = new AiCursor({ ws, send });
  agents = new Agents(ws);
  cursor.colorFor = name => agents.colorFor(name);
  agents.on('changed', list => send('agents:changed', list));
  browsers.setCursor(cursor);
  keeper = new SessionKeeper(ws.dirs.secrets, safeStorage, () => ws.profiles());

  registerProtocol();
  const restored = await keeper.restore().catch(() => 0);
  if (restored) activity.log('system', 'sessions.restored', `${restored} session cookies restored`);
  keeper.start();

  ws.on('item:upsert', (item, actor) => {
    const a = actor === 'agent' ? agentStore.getStore() : null;
    send('item:upsert', item, actor, a ? { name: a.label, color: agents.colorFor(a.label) } : null);
    if (item.type === 'browser' && item.engine === 'brave') openBrave(item);
  });
  ws.on('item:remove', (id, actor) => { browsers.detach(id); brave?.close(id); send('item:remove', id, actor); if (actor !== 'agent') activity.log(actor, 'item.close', id); });
  ws.on('note:changed', (id, content, actor) => { if (actor === 'agent') send('note:changed', id, content); });
  ws.on('library:changed', () => send('library:changed'));
  activity.on('entry', e => send('activity', e));
  trading.on('changed', () => send('trading:changed', trading.state()));

  mcp = new McpServer({
    ws, keys, trading, browsers, activity, cursor, version: app.getVersion(),
    // Draws numbered element boxes onto a screenshot (done in the UI with a canvas).
    annotate: async (img, boxes) => {
      const out = await win.webContents.executeJavaScript(`window.__acAnnotate(${JSON.stringify(img.toDataURL())}, ${JSON.stringify(boxes || [])})`);
      return nativeImage.createFromDataURL(out);
    },
    isPaused: () => paused,
    getToken: () => ws.settings.mcpToken,
    touch: id => { const a = agentStore.getStore(); send('agent:touch', id, a ? { name: a.label, color: agents.colorFor(a.label) } : null); },
    agents,
    focusItem: id => send('focus:item', id),
    fileChanged: rel => send('file:changed', rel),
    canvasScreenshot: async () => {
      if (win.isMinimized()) throw new Error('The Officina window is minimised, so there is nothing on screen to capture.');
      const img = await Promise.race([win.webContents.capturePage(), new Promise(r => setTimeout(() => r(null), 5000))]);
      if (!img || img.isEmpty()) throw new Error('Could not capture the canvas.');
      return img;
    },
    onCall: () => { lastAgentCall = new Date().toISOString(); send('agent:active', lastAgentCall); },
  });

  engine = new Engine({ root: ws.root });
  // Ads and cookie banners blocked in every browser (counts shown per browser window).
  const countTimers = new Map();
  adblock = new Adblock({ ws, onCount: (wcId, n) => {
    if (countTimers.has(wcId)) return;
    countTimers.set(wcId, setTimeout(() => { countTimers.delete(wcId); const id = itemIdForWc(wcId); if (id) send('adblock:count', id, adblock.counts.get(wcId) || 0); }, n ? 400 : 0));
  } });
  adblock.load();
  for (const profile of ws.profiles()) adblock.attach(session.fromPartition(`persist:ac-${profile}`), profile);
  engine.on('status', s => send('engine:status', s));
  setupBrave();
  // The built-in agents. "assistant" is the team: it still answers busy/send/stop/reset for older code.
  assistant = new Team({ ws, mcp, isPaused: () => paused, safeStorage, engine, agents });
  assistant.on('event', e => send('chat:event', e));
  assistant.on('changed', list => send('team:changed', list));
  assistant.on('tokens', t => send('tokens', t));

  extra = require('./extensions').extensions({ ws, trading, browsers, assistant, activity, safeStorage, send, getWindow: () => win, isPaused: () => paused, keeper, stop: () => { paused = true; trading.setHalted(true); assistant.stop(); cursor.hide(); extra?.handoffs.cancelAll(); send('paused', true); } });
  mcp.ctx.handoffs = extra.handoffs;
  mcp.ctx.audit = extra.audit;
  mcp.ctx.team = assistant; // team_* tools: leaders (local or over the local API) hand out work
  // Telegram and Discord: talk to the agents from a phone; notifications go there too.
  peek = new Peek({ ws, agents, browsers, getWindow: () => win, send });
  connectors = new Connectors({ ws, safeStorage, team: assistant, activity, handoffs: extra.handoffs, setPaused, isPaused: () => paused, peek });
  migrateTelegramNotifications();
  connectors.on('status', s => send('connectors:status', s));
  mcp.ctx.connectors = connectors;
  extra.notifier.connectors = connectors;
  connectors.startAll();
  registerIpc();
  createWindow();
  await startMcp();
  openAllBrave();
}

let quitting = false;
app.on('before-quit', e => {
  if (quitting || !keeper) return;
  e.preventDefault();
  quitting = true;
  extra?.dispose();
  connectors?.stopAll();
  trading?.dispose();
  engine?.stop();
  brave?.stopAll().catch(() => {});
  ram?.stop();
  try { ws.saveNow(); } catch { /* ignore */ }
  Promise.race([keeper.snapshot(), new Promise(r => setTimeout(r, 3000))]).finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());

// ---------- IPC ----------
function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => fn(...args));

  h('init', () => ({
    items: ws.listItems(), viewport: ws.state.viewport, dataDir: DATA, version: app.getVersion(),
    disclaimerAccepted: !!ws.settings.disclaimerAcceptedAt, mcp: mcpStatus(), paused, ui: ws.settings.ui || {},
    trading: trading.state(), keys: keys.list(), keysEncrypted: keys.encrypted, activity: activity.list(200),
  }));

  h('item:add', partial => ws.addItem(partial, 'user'));
  h('item:update', (id, patch) => ws.updateItem(id, patch, 'user'));
  h('item:remove', id => ws.removeItem(id, 'user'));
  h('viewport:set', v => {
    ws.state.viewport = { x: v.x, y: v.y, scale: v.scale };
    ws.state.viewSize = { w: v.viewW, h: v.viewH };
    ws.saveSoon();
  });
  ipcMain.on('browser:attached', (_e, itemId, wcId) => browsers.attach(itemId, wcId));
  ipcMain.on('browser:detached', (_e, itemId) => browsers.detach(itemId));

  h('note:read', id => ws.readNote(id));
  h('note:write', (id, content) => ws.writeNote(id, content, 'user'));

  h('files:import', (paths, show = true) => {
    const imported = ws.importPaths(paths.filter(p => typeof p === 'string' && fs.existsSync(p)), 'user');
    activity.log('user', 'files.import', imported.map(i => i.path).join(', '));
    return imported;
  });
  h('files:importDialog', async kind => {
    const r = await dialog.showOpenDialog(win, { title: kind === 'folder' ? 'Import a folder (it is copied into the workspace)' : 'Import files (they are copied into the workspace)', properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'] });
    if (r.canceled) return [];
    const imported = ws.importPaths(r.filePaths, 'user');
    activity.log('user', kind === 'folder' ? 'folder.import' : 'files.import', imported.map(i => i.path).join(', '));
    return imported;
  });
  h('file:export', async rel => {
    const r = await dialog.showSaveDialog(win, { title: 'Export a copy out of the workspace', defaultPath: path.basename(rel) });
    if (r.canceled || !r.filePath) return false;
    fs.copyFileSync(ws.safePath(rel), r.filePath);
    activity.log('user', 'file.export', `${rel} -> ${r.filePath}`);
    return true;
  });
  h('file:readText', rel => {
    const buf = ws.readFile(rel);
    return buf.length > 2 * 1024 * 1024 ? buf.subarray(0, 2 * 1024 * 1024).toString('utf8') + '\n…(truncated)' : buf.toString('utf8');
  });
  h('file:writeText', (rel, content) => ws.writeFile(rel, content, 'user'));
  h('dir:list', rel => ws.listDir(rel || ''));
  h('library', q => ws.library(q || {}));

  h('keys:list', () => keys.list());
  h('keys:save', input => {
    const e = keys.upsert(input);
    trading.invalidate(e.id);
    activity.log('user', 'key.saved', `${e.label} (${e.kind}${e.exchange ? ' ' + e.exchange : ''})`);
    send('keys:changed', keys.list());
    send('trading:changed', trading.state());
    return keys.list().find(k => k.id === e.id);
  });
  h('keys:delete', id => {
    keys.remove(id);
    trading.invalidate(id);
    if (trading.mandate.accounts.includes(id)) trading.setMandate({ accounts: trading.mandate.accounts.filter(a => a !== id) });
    send('keys:changed', keys.list());
    send('trading:changed', trading.state());
    return true;
  });
  h('keys:test', async id => {
    try {
      const bal = await trading.balance(id);
      return { ok: true, message: `Connected. ${Object.keys(bal).length} non-zero balances.` };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });
  h('exchanges:list', () => Trading.exchangeList());

  h('trading:state', () => trading.state());
  h('trading:setMandate', patch => trading.setMandate(patch, 'user'));
  h('trading:order', async o => {
    try { return { ok: true, result: await trading.placeOrder({ ...o, actor: 'user' }) }; } catch (e) { return { ok: false, message: e.message }; }
  });
  h('trading:cancel', async o => {
    try { return { ok: true, result: await trading.cancelOrder({ ...o, actor: 'user' }) }; } catch (e) { return { ok: false, message: e.message }; }
  });
  h('trading:balance', async id => { try { return { ok: true, result: await trading.balance(id) }; } catch (e) { return { ok: false, message: e.message }; } });
  h('trading:openOrders', async id => { try { return { ok: true, result: await trading.openOrders(id) }; } catch (e) { return { ok: false, message: e.message }; } });
  h('trading:ticker', async (id, symbol) => { try { return { ok: true, result: await trading.ticker(id, symbol) }; } catch (e) { return { ok: false, message: e.message }; } });
  h('trading:paperReset', amount => { trading.paper.reset(Number(amount) || 10000); activity.log('user', 'paper.reset', `USDT ${amount}`); send('trading:changed', trading.state()); return true; });

  h('settings:acceptDisclaimer', () => {
    ws.settings.disclaimerAcceptedAt = new Date().toISOString();
    ws.saveSettings();
    activity.log('user', 'disclaimer.accepted', '');
    return true;
  });
  h('mcp:status', () => mcpStatus());
  h('mcp:regenerateToken', () => { ws.settings.mcpToken = crypto.randomBytes(24).toString('hex'); ws.saveSettings(); return mcpStatus(); });
  h('mcp:configure', async ({ port, enabled }) => {
    if (port !== undefined) {
      const p = Number(port);
      if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('Port must be 1024-65535');
      ws.settings.mcpPort = p;
    }
    if (enabled !== undefined) ws.settings.mcpEnabled = !!enabled;
    ws.saveSettings();
    await mcp.stop();
    await startMcp();
    return mcpStatus();
  });

  h('agent:setPaused', setPaused);
  h('activity:list', () => activity.list(300));

  // Agents: everyone working in the canvas, with per-agent pause and trading permission.
  h('agents:list', () => agents.list());
  h('agents:update', (name, patch) => agents.update(name, patch));
  h('agents:forget', name => agents.forget(name));
  // The local API (MCP): every tool an agent can call, for the API reference.
  h('mcp:tools', () => mcp.listTools().map(t => ({ name: t.name, description: t.description, readOnly: !!t.annotations?.readOnlyHint, params: Object.keys(t.inputSchema?.properties || {}) })));

  // Built-in assistant on a local model runner.
  // Built-in agents: calls that act on one agent take its id first (null = the first agent).
  h('llm:state', id => assistant.get(id).state());
  h('llm:detect', () => assistant.detect());
  h('llm:models', async (runner, baseUrl, apiKey) => { try { return { ok: true, models: await assistant.listModels(runner, baseUrl, apiKey) }; } catch (e) { return { ok: false, message: e.message }; } });
  h('llm:modelInfo', (runner, baseUrl, model) => assistant.modelInfo(runner, baseUrl, model));
  h('llm:setConfig', (id, patch) => assistant.get(id).setConfig(patch));
  h('llm:send', (id, text) => { const a = assistant.get(id); a.send(text).catch(e => send('chat:event', { type: 'error', text: e.message, agent: a.id })); return true; });
  h('llm:stop', id => { if (id) assistant.get(id).stop(); else assistant.stop(); return true; });
  h('llm:reset', id => { assistant.get(id).reset(); return true; });
  h('team:list', () => assistant.list());
  h('team:add', opts => assistant.add(opts || {}));
  h('team:duplicate', id => assistant.duplicate(id));
  h('team:update', (id, patch) => assistant.update(id, patch));
  h('team:remove', id => assistant.remove(id));
  h('team:sendMany', tasks => assistant.sendMany(tasks));
  h('engine:status', async () => { await engine.listDevices().catch(() => []); return engine.status(); });
  h('engine:install', async variant => { try { return { ok: true, status: await engine.install(variant) }; } catch (e) { return { ok: false, message: e.message }; } });
  h('engine:stop', async () => { await engine.stop(); return engine.status(); });
  h('adblock:status', async () => { await adblock.load(); return adblock.status(); });
  h('adblock:configure', patch => adblock.configure(patch || {}));
  h('adblock:setBrowser', (profile, on) => { adblock.setBrowser(String(profile), !!on); return adblock.isOn(String(profile)); });
  h('adblock:allowSite', (host, allow) => { const list = adblock.settings.allow.filter(x => x !== host); if (allow) list.push(host); return adblock.configure({ allow: list }); });

  h('settings:setUi', patch => {
    ws.settings.ui = { ...(ws.settings.ui || {}), ...patch };
    ws.saveSettings();
    return ws.settings.ui;
  });
  h('stats', () => {
    const agent = pred => activity.count(k => k.startsWith('agent:') && pred(k.slice(6)));
    return {
      ...ws.stats(localDay),
      pagesRead: agent(a => a === 'browser_read' || a === 'browser_find' || a === 'browser_screenshot'),
      agentActions: agent(a => !a.endsWith('failed')),
      tradesBlocked: activity.count(k => k === 'agent:trade.rejected'),
    };
  });
  h('file:duplicate', rel => ws.duplicateFile(rel, 'user'));
  // Fires a real paste in the UI, so the renderer's paste handler receives text and images.
  h('clipboard:paste', () => { win.webContents.paste(); return true; });
  h('file:savePasted', (name, bytes) => {
    const ext = (/.(png|jpe?g|gif|webp|bmp)$/i.exec(name || '') || ['.png'])[0].toLowerCase();
    const rel = ws.uniqueRel(`pasted/image-${new Date().toISOString().replace(/[:.]/g, '-')}${ext}`);
    ws.writeFile(rel, Buffer.from(bytes), 'user');
    return rel;
  });
  h('browser:clearData', async profile => {
    const ses = session.fromPartition(partitionFor(profile));
    await ses.clearStorageData();
    await ses.clearCache();
    await keeper.snapshot().catch(() => {});
    if (ws.listItems().some(i => i.type === 'browser' && i.profile === profile && i.engine === 'brave')) {
      await brave.clearProfile(profile);
      for (const it of ws.listItems()) if (it.type === 'browser' && it.profile === profile && it.engine === 'brave') openBrave(it);
    }
    activity.log('user', 'browser.logout', profile);
    return true;
  });
  // Clears all content and logins; keeps appearance, MCP connection settings and the disclaimer.
  h('workspace:reset', async confirmWord => {
    if (confirmWord !== 'RESET') throw new Error('Confirmation word missing');
    // Agents first: a running agent must not write into the space while it is wiped.
    assistant.stop();
    for (let i = 0; i < 40 && assistant.busy; i++) await new Promise(r => setTimeout(r, 100));
    for (const profile of ws.profiles()) {
      const ses = session.fromPartition(partitionFor(profile));
      await ses.clearStorageData().catch(() => {});
      await ses.clearCache().catch(() => {});
    }
    for (const id of [...browsers.wcByItem.keys()]) browsers.detach(id);
    await brave.wipe().catch(e => activity.log('system', 'brave.wipe.failed', e.message));
    keeper.stop();
    extra?.reset();
    ws.reset();
    keys.clear();
    // Every agent but the first goes (helpers and agents you added); the first keeps its
    // model so the assistant works right away. Colours, counts and outside agents are forgotten.
    assistant.resetAll();
    agents.resetAll();
    for (const s of connectors.status()) for (const l of s.links) connectors.unlink(s.id, l.chatId); // linked chats are like logins
    trading.paper.reset(10000);
    trading.instances.clear();
    delete ws.settings.mandate;
    ws.saveSettings();
    activity.clear();
    paused = false;
    trading.setHalted(false);
    await keeper.snapshot().catch(() => {});
    keeper.start();
    activity.log('user', 'workspace.reset', 'Everything was cleared');
    win.webContents.reload();
    return true;
  });
  // ---------- Brave windows: picture out, the user's mouse and keys in ----------
  h('brave:hello', id => {
    const page = brave.page(id);
    return { installed: !!software.exePath('brave'), installing: software.installing.get('brave') || null, state: page ? page.state() : null, frame: page?.lastFrame || null };
  });
  const lastCursor = new Map();
  const handleBraveInput = async (page, id, ev) => {
    const mods = ev.modifiers || [];
    if (ev.kind === 'paste') { const t = clipboard.readText(); if (t) await page.userInput({ kind: 'text', text: t }); return; }
    // Headless Brave keeps its own clipboard: copy and cut also go to the computer's clipboard.
    if (ev.kind === 'key' && ev.type === 'down' && (mods.includes('control') || mods.includes('meta')) && !mods.includes('alt') && /^[cx]$/i.test(ev.key)) { const t = await page.selection(); if (t) clipboard.writeText(t); }
    await page.userInput(ev);
    if (ev.kind === 'mouse' && ev.type === 'move' && Date.now() - (lastCursor.get(id)?.at || 0) > 150) {
      const entry = { at: Date.now(), cursor: lastCursor.get(id)?.cursor };
      lastCursor.set(id, entry);
      const c = await page.cursorAt(ev.x, ev.y);
      if (c !== entry.cursor) { entry.cursor = c; send('brave:state', id, { cursor: c }); }
    }
  };
  ipcMain.on('brave:input', (_e, id, ev) => {
    const page = brave.page(id);
    if (!page || page.destroyed || !ev || typeof ev !== 'object') return;
    page.inputChain = (page.inputChain || Promise.resolve()).then(() => handleBraveInput(page, id, ev)).catch(() => {});
  });
  h('brave:view', async (id, v = {}) => {
    const page = brave.page(id);
    if (!page || page.destroyed) return false;
    await page.view(v);
    return true;
  });
  h('brave:nav', (id, what) => {
    const page = brave.page(id);
    if (!page || page.destroyed) throw new Error('Brave is not running for this window. Click Reload.');
    if (what === 'back') page.navigationHistory.goBack();
    else if (what === 'forward') page.navigationHistory.goForward();
    else if (what === 'reload') page.reload();
    else {
      if (!/^https?:/i.test(String(what))) throw new Error('Only web addresses (http or https) can be opened');
      page.loadURL(String(what)).catch(() => {});
    }
    return true;
  });
  h('brave:dialog', (id, accept, text) => brave.page(id)?.answerDialog(accept, text) ?? false);
  h('brave:signin', (id, done) => { const it = ws.getItem(id); if (!it) return false; return done ? brave.finishSignIn(it.profile) : brave.signIn(it.profile, brave.page(id)?.url || it.url); });
  h('brave:tab', (id, action, index) => (action === 'close' ? brave.closeTab(id, index) : brave.switchTab(id, index)));
  h('peek:target', name => peek.target(name));
  h('peek:frame', id => peek.frame(id));
  h('peek:recorded', (id, bytes, mime, error) => peek.done(id, bytes, mime, error));
  h('brave:reopen', id => { const it = ws.getItem(id); if (it?.engine === 'brave') openBrave(it); return true; });

  // ---------- software for the space ----------
  h('software:status', () => {
    software.checkLatest('brave').catch(() => {});
    return { list: software.status(), browserEngine: ws.settings.browserEngine || 'brave' };
  });
  h('software:install', async id => {
    try { await software.install(id); if (id === 'brave') openAllBrave(); return { ok: true, list: software.status() }; } catch (e) { return { ok: false, message: e.message }; }
  });
  h('software:remove', async id => { await software.remove(id); return software.status(); });
  h('browser:setEngine', choice => { ws.settings.browserEngine = choice === 'builtin' ? 'builtin' : 'brave'; ws.saveSettings(); return ws.settings.browserEngine; });
  h('browser:openIn', (id, choice) => {
    const it = ws.requireItem(id, 'browser');
    return ws.addItem({ type: 'browser', engine: choice === 'brave' ? 'brave' : 'builtin', url: it.url, title: it.title, renamed: it.renamed, hint: { x: it.x + it.w + 40, y: it.y }, w: it.w, h: it.h }, 'user');
  });

  // ---------- meters, organising, agents talking to agents ----------
  h('stats:ram', () => ram.read());
  h('tokens:get', () => assistant.tokenSummary());
  h('tokens:reset', () => assistant.resetTokens());
  h('canvas:organize', () => ws.organize('user'));
  h('team:broadcast', (ids, text) => assistant.broadcast(ids, text));
  h('team:wrapUp', ids => assistant.wrapUp({ ids }));

  // ---------- connectors: Telegram and Discord ----------
  h('agents:prefs', () => ({ tidy: ws.settings.agentTidy !== false }));
  h('agents:setPrefs', patch => { if (patch?.tidy !== undefined) ws.settings.agentTidy = !!patch.tidy; ws.saveSettings(); return { tidy: ws.settings.agentTidy !== false }; });
  h('connectors:status', () => connectors.status());
  h('connectors:configure', (id, patch) => connectors.configure(id, patch || {}));
  h('connectors:pair', id => { connectors.newPairCode(id); return connectors.status(); });
  h('connectors:unlink', (id, chatId) => connectors.unlink(id, chatId));
  h('connectors:linkAgent', (id, chatId, agentId) => connectors.setLinkAgent(id, chatId, agentId));
  h('connectors:test', async () => ({ sent: await connectors.notify('Officina', 'Test message: this chat receives notifications and can talk to your agents.') }));

  h('shell:openDataFolder', () => shell.openPath(DATA));
  h('shell:openModelsFolder', () => { const dir = path.join(DATA, 'models'); fs.mkdirSync(dir, { recursive: true }); return shell.openPath(dir); });
  h('clipboard:write', t => clipboard.writeText(String(t)));
}

module.exports = { cleanUA };
