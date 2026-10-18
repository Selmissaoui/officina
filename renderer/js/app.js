import { Canvas } from './canvas.js';
import { PANELS } from './panels.js';
import { h, clear, toast, modal } from './ui.js';
import { openMenu, closeMenu } from './menu.js';
import { createActions } from './actions.js';
import { prefs, loadPrefs, setPrefs, applyPrefs, onPrefsChange, t, isSimple, isGame } from './prefs.js';
import { createProgressWatcher } from './game.js';
import { createCursorManager } from './cursor.js';
import { avatar } from './agents.js';
import { listenForPeek } from './peek.js';

const $ = id => document.getElementById(id);

const state = { keys: [], trading: null, mcp: null, activity: [], paused: false, keysEncrypted: true, playerName: 'Climber' };
let canvas;
let panel = null; // { name, api }
let chat = null; // { api } while the chat dock is open
let watcher = null;
let aiCursor = null;

const ctx = {
  state,
  get canvas() { return canvas; },
  dataDir: '',
  selected: null,
  openPanel,
  openMemory: () => openPanel('memory', {force:true}),
  addFrame: () => window.ac.addItem({type:'frame', title:'Group', ...canvas.center()}),
  openFile,
  showDisclaimer,
  newBrowser,
  importDialog,
  zoomReset,
  select(id) {
    if (ctx.selected === id) return;
    canvas.views.get(ctx.selected)?.select(false);
    ctx.selected = id;
    canvas.views.get(id)?.select(true);
  },
  adblockOn: profile => !!state.adblock?.ready && state.adblock.enabled && !state.adblock.off.includes(profile),
  adblockAllowed: host => !!host && (state.adblock?.allow || []).some(s => host === s || host.endsWith(`.${s}`)),
  async setBrowserAdblock(profile, on) { await window.ac.adblockSetBrowser(profile, on); setAdblockState(await window.ac.adblockStatus()); },
  async allowAdsOn(host, allow) { setAdblockState(await window.ac.adblockAllowSite(host, allow)); },
  setAdblockState: s => setAdblockState(s),
  keysForProfile: profile => state.keys.filter(k => (k.linkedBrowsers || []).includes(profile)),
  sharedProfileCount: profile => [...canvas.views.values()].filter(v => v.item.type === 'browser' && v.item.profile === profile).length,
  allProfiles() {
    const open = [...canvas.views.values()].filter(v => v.item.type === 'browser').map(v => ({ profile: v.item.profile, label: v.item.title || v.item.url }));
    const seen = new Set();
    const uniq = open.filter(o => !seen.has(o.profile) && seen.add(o.profile));
    const closed = (state.closedBrowsers || []).filter(b => !seen.has(b.profile)).map(b => ({ profile: b.profile, label: b.title, closed: true }));
    return [...uniq, ...closed];
  },
  profileLabel(profile) {
    const v = [...canvas.views.values()].find(x => x.item.type === 'browser' && x.item.profile === profile);
    return v ? v.item.title : `${profile} (closed)`;
  },
  playerName: () => state.playerName,
  setPlayerName(name) { state.playerName = name; window.ac.setUi({ playerName: name }); refreshPanel('status'); },
};
ctx.actions = createActions(ctx);

async function boot() {
  const init = await window.ac.init();
  ctx.dataDir = init.dataDir;
  Object.assign(state, { keys: init.keys, trading: init.trading, mcp: init.mcp, activity: init.activity, paused: init.paused, keysEncrypted: init.keysEncrypted, playerName: init.ui?.playerName || 'Climber' });
  loadPrefs(init.ui);
  setChatSide(init.ui?.chatSide === 'left' ? 'left' : 'right');

  canvas = new Canvas({
    viewport: $('viewport'), world: $('world'),
    onChange: v => { $('zoom-label').textContent = `${Math.round(v.scale * 100)}%`; },
    onBackground: {
      click: () => { ctx.select(null); closeMenu(); },
      dblclick: pt => ctx.actions.newNoteAt(pt),
      menu: (x, y, pt) => openMenu(x, y, ctx.actions.backgroundMenu(pt)),
    },
  });
  canvas.set(init.viewport || { x: 0, y: 0, scale: 1 }, { persist: false });
  for (const item of init.items) canvas.upsert(item, ctx);
  updateEmpty();
  renderChrome();
  $('sb-version').textContent = `v${init.version}`;
  macLabels(document);
  wireEvents();
  startStatusBar();
  // A request (bot check, login, approval) waits for the person, so put it in front of them.
  const seenRequests = new Set();
  window.ac.on('handoff:changed', entries => {
    const fresh = entries.filter(e => !seenRequests.has(e.id));
    entries.forEach(e => seenRequests.add(e.id));
    if (!fresh.length) return;
    openPanel('handoff', { force: true });
    toast(fresh[fresh.length - 1].message, 'warn', 12000);
  });
  window.ac.feature('handoff:list').then(entries => {if(entries.length)openPanel('handoff',{force:true});});
  wireToolbar();
  wireDrop();
  aiCursor = createCursorManager(canvas);
  onPrefsChange(onPrefs);
  watcher = createProgressWatcher();
  if (!init.disclaimerAccepted) showDisclaimer(true, !init.ui?.mode);
  refreshClosedBrowsers();
}

// Re-render everything whose wording or layout depends on mode/theme.
function onPrefs() {
  renderChrome();
  aiCursor?.applyPrefs();
  if (chat) { $('chat-title').textContent = t('chat'); chat.api.refresh?.(); }
  if (panel) {
    $('drawer-title').textContent = t(PANELS[panel.name].word);
    if (panel.name === 'status' && !isGame()) closePanel();
    else panel.api.refresh?.();
  }
  for (const v of canvas.views.values()) if (v.item.type === 'note') v.update(v.item);
}

async function refreshClosedBrowsers() {
  const lib = await window.ac.library({ kind: 'browser' });
  state.closedBrowsers = lib.filter(e => !e.itemId).map(e => ({ profile: e.profile, title: e.name.replace(/ \(closed\)$/, '') }));
}

function updateEmpty() {
  $('empty-hint').hidden = canvas.views.size > 0;
}

function setAdblockState(s) {
  state.adblock = s;
  for (const v of canvas.views.values()) v.refreshAd?.();
}

function renderChrome() {
  const m = state.trading.mandate;
  const chip = $('trade-chip');
  chip.textContent = !m.enabled ? 'Off' : state.paused ? 'Paused' : (isSimple() ? 'On' : 'Auto');
  chip.className = `chip rail-chip ${m.enabled && !state.paused ? 'on' : ''}`;
  $('mcp-dot').className = `dot ${state.mcp.running ? 'ok' : 'bad'}`;
  $('mcp-dot').title = state.mcp.running ? (isSimple() ? 'Ready for your AI assistant' : `MCP running on ${state.mcp.url}`) : (state.mcp.error || 'Connection is off');
  $('paused-banner').hidden = !state.paused;
  $('stop-btn').classList.toggle('stopped', state.paused);
  $('stop-btn').firstElementChild.dataset.word = state.paused ? 'stopped' : 'stop';
  $('stop-btn').title = state.paused ? 'Click to let it continue' : 'Pause every agent action and auto-trading';
  document.body.classList.toggle('is-paused', state.paused);
  $('cursor-btn').classList.toggle('on', prefs.cursor.show);
  $('cursor-btn').title = prefs.cursor.show ? 'AI cursor is visible. Click for options.' : 'AI cursor is hidden. Click for options.';
  applyWords();
}

// On a Mac the shortcuts use Cmd: show them that way.
const IS_MAC = /Mac/.test(navigator.platform);
function macLabels(root) {
  if (!IS_MAC) return;
  for (const el of root.querySelectorAll('[title]')) if (el.title.includes('Ctrl')) el.title = el.title.replace(/Ctrl\+/g, '⌘').replace(/Ctrl /g, '⌘');
  for (const k of root.querySelectorAll('kbd')) k.textContent = k.textContent.replace(/Ctrl\+?\s?/g, '⌘');
}

function applyWords() {
  for (const el of document.querySelectorAll('[data-word]')) el.textContent = t(el.dataset.word);
}

function openPanel(name, opts = {}) {
  const def = PANELS[name];
  if (!def) return;
  if (name === 'chat') return toggleChat(opts);
  if (panel?.name === name && !opts.profile && !opts.create && !opts.force && !opts.query) return closePanel();
  panel?.api?.dispose?.();
  closeMenu();
  $('drawer').hidden = false;
  $('drawer-title').textContent = t(def.word);
  const body = clear($('drawer-body'));
  body.className = `panel-${name}`;
  panel = { name, api: def.render(body, ctx, opts) || {} };
  macLabels(body);
  drawerButtons().forEach(b => b.classList.toggle('on', b.dataset.panel === name));
  if (name === 'activity') $('activity-dot').classList.remove('on');
}

// Drawer buttons light up for the drawer; the chat button follows the chat dock.
const drawerButtons = () => document.querySelectorAll('.panel-btn:not([data-panel="chat"])');
const chatButton = () => document.querySelector('.panel-btn[data-panel="chat"]');

function toggleChat(opts = {}) {
  if (chat && !opts.force) return closeChat();
  if (chat && opts.agentName) chat.api.select?.(opts.agentName);
  closeMenu();
  if (!chat) {
    $('chat-dock').hidden = false;
    $('chat-title').textContent = t('chat');
    chat = { api: PANELS.chat.render(clear($('chat-body')), ctx, opts) || {} };
  }
  chatButton()?.classList.add('on');
  $('chat-dot').classList.remove('on');
  setTimeout(() => $('chat-body').querySelector('.chat-input')?.focus(), 50);
}

function closeChat() {
  chat?.api?.dispose?.();
  chat = null;
  $('chat-dock').hidden = true;
  chatButton()?.classList.remove('on');
}

function setChatSide(side) {
  $('stage').dataset.chatSide = side;
  $('chat-side').textContent = side === 'left' ? '⇥' : '⇤';
  $('chat-side').title = `Move the chat to the ${side === 'left' ? 'right' : 'left'} side`;
}

function closePanel() {
  panel?.api?.dispose?.();
  panel = null;
  $('drawer').hidden = true;
  drawerButtons().forEach(b => b.classList.remove('on'));
}

function refreshPanel(name) {
  if (panel?.name === name) panel.api.refresh?.();
}

async function openFile(rel, near) {
  const existing = [...canvas.views.values()].find(v => v.item.type === 'file' && v.item.path === rel);
  if (existing) return canvas.focus(existing.item.id);
  const hint = near ? { x: near.x + near.w + 40, y: near.y } : undefined;
  const item = await window.ac.addItem({ type: 'file', path: rel, title: rel.split('/').pop(), hint });
  setTimeout(() => canvas.focus(item.id), 60);
}

function zoomReset() {
  const c = canvas.center();
  const r = $('viewport').getBoundingClientRect();
  canvas.animateTo({ scale: 1, x: r.width / 2 - c.x, y: r.height / 2 - c.y });
}

function wireEvents() {
  window.ac.on('item:upsert', (item, actor, agent) => {
    const isNew = !canvas.views.has(item.id);
    // Windows the AI moves glide to their new spot instead of jumping.
    if (!isNew && actor === 'agent') {
      const el = canvas.views.get(item.id).el;
      el.classList.add('agent-move');
      clearTimeout(el._moveT);
      el._moveT = setTimeout(() => el.classList.remove('agent-move'), 600);
    }
    const view = canvas.upsert(item, ctx);
    if (isNew && item.id === ctx.selected) view.select(true);
    updateEmpty();
    if (isNew && actor === 'agent') view.agentTouch?.(agent);
    if (isNew) watcher?.check();
    if (item.type === 'browser') refreshPanel('library');
  });
  window.ac.on('item:remove', id => { if (ctx.selected === id) ctx.selected = null; canvas.remove(id); updateEmpty(); refreshClosedBrowsers(); refreshPanel('library'); });
  window.ac.on('item:action', (id, action) => ctx.actions.run(id, action));
  window.ac.on('cursor', e => aiCursor?.handle(e));
  const drawAgents = list => {
    state.agents = list;
    const strip = $('agent-strip');
    clear(strip);
    const shown = list.filter(a => a.status === 'working').slice(0, 6);
    strip.append(...shown.map(a => avatar(a, 'sm')));
    const working = list.filter(a => a.status === 'working').length;
    $('agent-count').hidden = !working;
    $('agent-count').textContent = String(working);
    renderStatusBar();
    // Agent colours show in the activity list: rebuild it only when a colour changed.
    const colours = list.map(a => `${a.name}=${a.color}`).join('|');
    if (colours !== state.agentColours) { state.agentColours = colours; refreshPanel('activity'); }
  };
  window.ac.agentsList().then(drawAgents);
  window.ac.on('agents:changed', drawAgents);
  window.ac.on('adblock:count', (id, n) => canvas.views.get(id)?.setAdCount?.(n));
  window.ac.on('brave:frame', (id, data, meta) => canvas.views.get(id)?.braveFrame?.(data, meta));
  listenForPeek();
  window.ac.on('brave:state', (id, patch) => canvas.views.get(id)?.braveState?.(patch));
  window.ac.on('software:status', list => { state.software = list; for (const v of canvas.views.values()) v.softwareChanged?.(list); renderStatusBar(); });
  window.ac.on('tokens', renderTokens);
  window.ac.tokens().then(renderTokens);
  startRamMeter();
  window.ac.adblockStatus().then(setAdblockState);
  setInterval(() => window.ac.agentsList().then(drawAgents), 15000);
  window.ac.on('chat:event', e => {
    if (chat) chat.api.event?.(e);
    else if (e.type === 'assistant' || e.type === 'error') $('chat-dot').classList.add('on');
  });
  window.ac.on('note:changed', (id, content) => canvas.views.get(id)?.noteChanged?.(content));
  window.ac.on('file:changed', rel => { for (const v of canvas.views.values()) v.fileChanged?.(rel); });
  window.ac.on('agent:touch', (id, agent) => canvas.views.get(id)?.agentTouch?.(agent));
  window.ac.on('agent:active', at => { state.mcp.lastCall = at; });
  window.ac.on('focus:item', id => canvas.focus(id));
  window.ac.on('library:changed', () => { refreshPanel('library'); refreshPanel('status'); watcher?.check(); });
  window.ac.on('activity', e => {
    state.activity.push(e);
    if (state.activity.length > 600) state.activity.splice(0, 200);
    if (panel?.name === 'activity') panel.api.add?.(e);
    else if (e.actor === 'agent') $('activity-dot').classList.add('on');
    refreshPanel('status');
    watcher?.check();
  });
  window.ac.on('trading:changed', tr => { state.trading = tr; renderChrome(); refreshPanel('trading'); });
  window.ac.on('keys:changed', keys => {
    state.keys = keys;
    for (const v of canvas.views.values()) v.refreshKeys?.();
    refreshPanel('keys');
  });
  window.ac.on('paused', p => { state.paused = p; renderChrome(); });
  window.ac.on('mcp:status', s => { state.mcp = s; renderChrome(); refreshPanel('agent'); renderStatusBar(); });
  window.addEventListener('resize', () => canvas.persist());
}

// ---------- status bar: what is running, at a glance ----------
function startStatusBar() {
  window.ac.engineStatus().then(s => { state.engine = s; renderStatusBar(); }).catch(() => {});
  window.ac.on('engine:status', s => { state.engine = s; renderStatusBar(); });
  window.ac.softwareStatus().then(s => { state.software = s.list; renderStatusBar(); }).catch(() => {});
  window.ac.connectorsStatus().then(s => { state.connectors = s; renderStatusBar(); });
  window.ac.on('connectors:status', s => { state.connectors = s; renderStatusBar(); });
}

function setStatus(id, cls, text, title) {
  const el = $(id);
  if (!el) return;
  el.querySelector('.dot').className = `dot ${cls}`;
  el.querySelector('.sb-text').textContent = text;
  if (title) el.title = title;
}

function renderStatusBar() {
  const m = state.mcp;
  if (m) setStatus('sb-api', m.running ? 'ok' : 'bad', m.running ? `Local API :${m.port}` : 'Local API off', m.running ? `AI apps connect to ${m.url}. Click for setup.` : (m.error || 'The local API is switched off.'));
  const e = state.engine;
  if (e) {
    const run = e.running || [];
    setStatus('sb-engine', e.loading ? 'busy' : run.length ? 'ok' : '', e.installing ? 'Installing engine…' : e.loading ? 'Loading model…' : run.length ? run.map(r => r.name).join(', ') : e.installed ? 'No model loaded' : 'Engine not installed',
      run.length ? `Built-in engine${e.gpu ? ` on ${e.gpu.name}` : ''}: ${run.map(r => `${r.name} (${Math.round(r.ctx / 1024)}K × ${r.slots})`).join(', ')}` : 'The built-in engine loads a model when an agent starts.');
  }
  const b = (state.software || []).find(x => x.id === 'brave');
  if (b) setStatus('sb-brave', b.installing ? 'busy' : b.installed ? 'ok' : 'warn', b.installing ? 'Installing Brave…' : b.installed ? `Brave ${b.installed.version}${b.update ? ' (update ready)' : ''}` : 'Brave not installed', 'The browser of this space. Click for Software settings.');
  const c = state.connectors;
  if (c) {
    const links = c.reduce((n, x) => n + (x.enabled ? x.links.length : 0), 0);
    const err = c.find(x => x.enabled && x.state === 'error');
    const online = c.filter(x => x.enabled && x.state === 'online');
    setStatus('sb-connectors', err ? 'bad' : online.length && links ? 'ok' : online.length ? 'warn' : '', err ? `${err.name}: problem` : online.length ? `${online.map(x => x.name).join(' + ')}: ${links} chat${links === 1 ? '' : 's'}` : 'No chats linked', err ? err.error : 'Talk to your agents from Telegram or Discord.');
    $('conn-dot').className = `dot ${err ? 'bad' : online.length && links ? 'ok' : ''}`;
  }
  const working = (state.agents || []).filter(a => a.status === 'working').length;
  document.body.classList.toggle('agents-working', working > 0);
}

// ---------- toolbar meters ----------
const fmtTokens = n => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K` : String(n || 0));
const gb = b => `${(b / 1073741824).toFixed(1)} GB`;

function renderTokens(t) {
  if (!t) return;
  state.tokens = t;
  $('tokens-n').textContent = fmtTokens(t.total);
  $('tokens').title = `Tokens used by the built-in agents since ${new Date(t.since).toLocaleDateString()}: ${t.total.toLocaleString()} (${t.in.toLocaleString()} read, ${t.out.toLocaleString()} written, ${t.steps.toLocaleString()} model calls). Click for details.`;
}

function tokensMenu() {
  const t = state.tokens;
  if (!t) return;
  const r = $('tokens').getBoundingClientRect();
  openMenu(r.left, r.bottom + 6, [
    { heading: `${fmtTokens(t.total)} tokens since ${new Date(t.since).toLocaleDateString()}` },
    { label: `Read by the models: ${fmtTokens(t.in)}`, disabled: true },
    { label: `Written by the models: ${fmtTokens(t.out)}`, disabled: true },
    ...(t.byAgent.length ? ['-', ...t.byAgent.slice(0, 10).map(a => ({ label: `${a.name}: ${fmtTokens(a.total)}`, disabled: true }))] : []),
    '-',
    { label: 'Start counting from zero', action: async () => renderTokens(await window.ac.tokensReset()) },
  ]);
}

function startRamMeter() {
  const tick = async () => {
    const m = await window.ac.ramStats().catch(() => null);
    if (!m) return;
    const pct = Math.round((m.used / m.total) * 100);
    const own = Math.round((m.officina / m.total) * 100);
    $('ram-fill').style.width = `${pct}%`;
    $('ram-own').style.width = `${Math.min(own, pct)}%`;
    $('ram').classList.toggle('warn', pct >= 80);
    $('ram').classList.toggle('bad', pct >= 92);
    $('ram-n').textContent = `${pct}%`;
    $('ram').title = `Memory: ${gb(m.used)} of ${gb(m.total)} in use (${pct}%).\nOfficina:${gb(m.officina)} (app ${gb(m.app)}${m.brave ? `, Brave ${gb(m.brave)}` : ''}${m.engine ? `, AI engine ${gb(m.engine)}` : ''}).`;
  };
  tick();
  setInterval(tick, 3000);
}

async function organize() {
  const r = await window.ac.organize();
  if (!r.moved) return toast('The canvas is empty', 'info');
  setTimeout(() => canvas.fitAll(), 120);
  toast(`Organised: ${r.groups.map(g => g.label).join(', ')}`, 'ok');
}

async function addAtCenter(type, extra = {}) {
  const c = canvas.center();
  const size = { browser: [900, 640], note: [340, 300] }[type] || [500, 420];
  const item = await window.ac.addItem({ type, hint: { x: Math.round(c.x - size[0] / 2), y: Math.round(c.y - size[1] / 2) }, ...extra });
  ctx.select(item.id);
  setTimeout(() => canvas.focus(item.id), 60);
  return item;
}

async function newBrowser(hint) {
  const url = h('input', { class: 'input', value: 'https://', spellcheck: 'false' });
  const title = h('input', { class: 'input', placeholder: 'Optional, e.g. “X” or “Exchange”' });
  const sites = ['x.com', 'tradingview.com', 'binance.com', 'bybit.com', 'coinmarketcap.com', 'duckduckgo.com'];
  const go = await modal({
    title: 'New browser',
    body: h('div', { class: 'form' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Address'), url),
      h('div', { class: 'quick' }, sites.map(s => h('button', { class: 'chip-btn', type: 'button', onclick: () => { url.value = `https://${s}`; url.focus(); } }, s))),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), title),
      h('p', { class: 'hint' }, 'Each browser keeps its own login. Sign in once and it stays signed in, separate from your normal browser.')),
    actions: [{ label: 'Cancel', value: false }, { label: 'Open', kind: 'primary', value: true }],
  });
  if (!go) return;
  let u = url.value.trim();
  if (!u || u === 'https://') u = 'https://duckduckgo.com';
  if (!/^[a-z]+:/i.test(u)) u = `https://${u}`;
  let host;
  try { host = new URL(u).hostname.replace(/^www\./, ''); } catch { return toast('That address doesn’t look right', 'warn'); }
  if (hint) {
    const it = await window.ac.addItem({ type: 'browser', url: u, title: title.value.trim() || host, hint });
    ctx.select(it.id);
  } else {
    await addAtCenter('browser', { url: u, title: title.value.trim() || host });
  }
}

async function importDialog(kind, hint) {
  openImported(await window.ac.importDialog(kind), hint);
}

function setCursorPrefs(patch) {
  setPrefs({ cursor: { ...prefs.cursor, ...patch } });
}

function cursorMenu() {
  const c = prefs.cursor;
  const r = $('cursor-btn').getBoundingClientRect();
  openMenu(r.left, r.bottom + 6, [
    { heading: isSimple() ? 'Watch the AI' : 'AI cursor' },
    { label: 'Show the AI cursor', shortcut: 'Ctrl+Shift+C', checked: c.show, action: () => setCursorPrefs({ show: !c.show }) },
    { label: 'Follow the AI around the canvas', checked: c.follow, action: () => setCursorPrefs({ follow: !c.follow }) },
    { label: 'Show what it is doing', checked: c.captions, action: () => setCursorPrefs({ captions: !c.captions }) },
    '-',
    { label: 'Speed', submenu: [['slow', 'Slow, easy to follow'], ['normal', 'Normal'], ['fast', 'Fast']].map(([v, l]) => ({ label: l, checked: c.speed === v, action: () => setCursorPrefs({ speed: v }) })) },
  ]);
}

function wireToolbar() {
  ctx.organize = organize;
  $('search-btn').onclick = () => openPanel('library', { force: true });
  $('sb-api').onclick = () => openPanel('agent', { force: true });
  $('sb-engine').onclick = () => openPanel('chat', { force: true });
  $('sb-brave').onclick = () => openPanel('settings', { force: true, tab: 'browsers' });
  $('sb-connectors').onclick = () => openPanel('connectors', { force: true });
  $('cursor-btn').onclick = cursorMenu;
  $('add-browser').onclick = () => newBrowser();
  $('add-note').onclick = () => addAtCenter('note', { title: 'Note' });
  $('add-file').onclick = () => importDialog('files');
  $('add-folder').onclick = () => importDialog('folder');
  $('zoom-in').onclick = () => canvas.zoomCenter(1.2);
  $('zoom-out').onclick = () => canvas.zoomCenter(1 / 1.2);
  $('zoom-label').onclick = zoomReset;
  $('zoom-fit').onclick = () => canvas.fitAll();
  $('organize').onclick = organize;
  $('tokens').onclick = tokensMenu;
  document.querySelectorAll('.panel-btn').forEach(b => { b.onclick = () => openPanel(b.dataset.panel); });
  $('drawer-close').onclick = closePanel;
  $('chat-close').onclick = closeChat;
  $('chat-side').onclick = () => {
    const side = $('stage').dataset.chatSide === 'left' ? 'right' : 'left';
    setChatSide(side);
    window.ac.setUi({ chatSide: side });
  };
  const togglePause = async () => {
    state.paused = await window.ac.setPaused(!state.paused);
    renderChrome();
    toast(state.paused ? t('pausedBanner') : (isSimple() ? 'The AI can continue' : 'Agent resumed'), state.paused ? 'warn' : 'ok');
  };
  $('stop-btn').onclick = togglePause;
  $('resume-btn').onclick = togglePause;

  // Ctrl+V on the canvas: links become browsers, text becomes a note, images become files.
  document.addEventListener('paste', e => {
    if (e.target.closest?.('input, textarea, [contenteditable]') || document.querySelector('.modal-wrap')) return;
    e.preventDefault();
    ctx.actions.pasteData(e.clipboardData);
  });

  window.addEventListener('keydown', e => {
    if (e.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('.modal-wrap')) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'b') { e.preventDefault(); newBrowser(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'n') { e.preventDefault(); $('add-note').click(); }
    else if ((e.ctrlKey || e.metaKey) && k === '0') { e.preventDefault(); canvas.fitAll(); }
    else if ((e.ctrlKey || e.metaKey) && k === '1') { e.preventDefault(); zoomReset(); }
    else if ((e.ctrlKey || e.metaKey) && (k === '=' || k === '+')) { e.preventDefault(); canvas.zoomCenter(1.2); }
    else if ((e.ctrlKey || e.metaKey) && k === '-') { e.preventDefault(); canvas.zoomCenter(1 / 1.2); }
    else if ((e.ctrlKey || e.metaKey) && k === 'k') { e.preventDefault(); openPanel('library', { force: true }); }
    else if ((e.ctrlKey || e.metaKey) && k === 'j') { e.preventDefault(); openPanel('chat', { force: true }); }
    else if ((e.ctrlKey || e.metaKey) && k === ',') { e.preventDefault(); openPanel('settings', { force: true }); }
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 'c') { e.preventDefault(); setCursorPrefs({ show: !prefs.cursor.show }); toast(prefs.cursor.show ? 'AI cursor visible' : 'AI cursor hidden. The AI now works without the animation.', 'info'); }
    else if (e.key === 'Escape') { if (ctx.selected) ctx.select(null); else closePanel(); }
    else if (ctx.actions.handleKey(e)) e.preventDefault();
  });
}

async function openImported(imported, at) {
  if (!imported?.length) return;
  let i = 0;
  for (const it of imported) {
    const base = at || canvas.center();
    const hint = { x: Math.round(base.x - (at ? 0 : 200) + i * 40), y: Math.round(base.y - (at ? 0 : 180) + i * 40) };
    await window.ac.addItem(it.dir ? { type: 'folder', path: it.path, hint } : { type: 'file', path: it.path, title: it.path.split('/').pop(), hint });
    i++;
  }
  toast(`Copied ${imported.length} item${imported.length === 1 ? '' : 's'} into the workspace`, 'ok');
}

function wireDrop() {
  const vp = $('viewport');
  const overlay = $('drop-overlay');
  let depth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());
  vp.addEventListener('dragenter', e => { if (!hasFiles(e)) return; depth++; overlay.hidden = false; });
  vp.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
  vp.addEventListener('drop', async e => {
    e.preventDefault();
    depth = 0; overlay.hidden = true;
    const paths = [...e.dataTransfer.files].map(f => window.ac.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    const imported = await window.ac.importFiles(paths);
    openImported(imported, canvas.toWorld(e.clientX, e.clientY));
  });
}

function showDisclaimer(firstRun, askMode = false) {
  const agree = h('input', { type: 'checkbox' });
  let mode = prefs.mode;
  const modePick = askMode ? h('div', { class: 'first-mode' },
    h('p', { class: 'field-label' }, 'How would you like to start?'),
    h('div', { class: 'seg' }, [['simple', 'Simple', 'Plain language'], ['technical', 'Technical', 'Show every detail']].map(([v, l, d]) =>
      h('button', { class: `seg-btn tall ${mode === v ? 'on' : ''}`, type: 'button', onclick: e => { mode = v; e.currentTarget.parentElement.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('on', b === e.currentTarget)); } }, h('strong', {}, l), h('span', {}, d)))),
    h('p', { class: 'hint' }, 'You can switch any time under Settings.')) : null;
  const body = h('div', { class: 'disclaimer' },
    h('p', {}, h('strong', {}, 'Websites you open here are not told that an AI is using the browser.'), ' The browsers present themselves as a normal Chrome browser.'),
    h('ul', {},
      h('li', {}, 'You are responsible for following the rules of every site you use through Officina, including their rules about automation.'),
      h('li', {}, 'Trading carries risk. Once you allow automatic trading, the AI places orders without asking each time, within the limits you set. You can lose money. Start with the practice account.'),
      h('li', {}, 'Everything stays inside the workspace folder next to the app. Nothing is shared with your normal browser.'),
      h('li', {}, 'The stop button in the top right pauses the AI and automatic trading instantly.')),
    modePick,
    firstRun ? h('label', { class: 'check strong' }, agree, ' I understand and take responsibility for how I use this.') : null);
  modal({
    title: firstRun ? 'Welcome to Officina' : 'Disclaimer', body, dismissable: !firstRun,
    actions: firstRun
      ? [{ label: 'Set up my first agent', kind: 'primary', onClick: () => { if (!agree.checked) { toast('Tick the box to continue', 'warn'); return false; } window.ac.acceptDisclaimer(); if (askMode) setPrefs({ mode }); openPanel('chat', { force: true }); return true; } }]
      : [{ label: 'Close', kind: 'primary', value: true }],
  });
}

boot().catch(err => {
  document.body.append(h('pre', { class: 'fatal' }, `Officina failed to load:\n${err.stack || err}`));
});

export { applyPrefs };
