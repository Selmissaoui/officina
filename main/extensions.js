'use strict';
const { ipcMain, BrowserWindow, dialog, app, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { Notifier } = require('./notify');
const { Tasks } = require('./tasks');
const { Risk } = require('./risk');
const { Handoffs, BrowserGuard, rulesFor } = require('./guardrails');
const { Replay } = require('./replay');
const { Signals } = require('./signals');
const { pack, unpack } = require('./backup');
const { newId } = require('./store');
function extensions(ctx) {
  const { ws, trading, browsers, assistant, activity, safeStorage, send, getWindow, isPaused, stop, keeper } = ctx;
  const notifier = new Notifier({ ws, activity, safeStorage, focusWindow: () => { const w = getWindow(); if (w.isMinimized()) w.restore(); w.focus(); } });
  const notify = (...args) => notifier.send(...args).catch(() => activity.log('system', 'notification.failed', 'Could not deliver notification'));
  trading.notify = notify;
  const risk = trading.risk = new Risk({ ws, trading, notify });
  const handoffs = new Handoffs({ send, notify, focus: id => send('focus:item', id) });
  browsers.guard = new BrowserGuard({ ws, browsers, handoffs, isPaused });
  // A bot check pauses the agent and puts that browser in front of the user.
  browsers.onBotCheck = (id, message) => handoffs.ask({ id, message });
  const tasks = new Tasks({ ws, assistant, notify, isPaused });
  tasks.on('changed', () => send('tasks:changed'));
  const replay = new Replay({ ws, browsers });
  const signals = new Signals({ ws, tasks, stop, snapshot: async () => ({ paused: isPaused(), image: getWindow().isMinimized() ? null : (await getWindow().webContents.capturePage()).resize({ width: 1100 }).toDataURL() }) });
  if (ws.settings.signals?.enabled) signals.configure(ws.settings.signals).catch(e => activity.log('system', 'signals.failed', e.message));
  const sessionState = new Map(); let monitoring = false;
  const health = setInterval(async () => {
    if (monitoring) return; monitoring = true;
    try { for (const [id] of browsers.wcByItem) {
      try {
        const login = await browsers.wc(id).executeJavaScript("!!document.querySelector('input[type=password]')");
        const old = sessionState.get(id); sessionState.set(id, login ? 'Login may be required' : 'No login form detected');
        if (login && old !== 'Login may be required') notify('session', 'Browser may need a login', ws.getItem(id)?.title || id);
      } catch { sessionState.set(id, 'Unavailable'); }
    } } finally { monitoring = false; }
  }, 30000); health.unref();
  const listSpaces = () => ({ spaces: ws.state.spaces || [{ id: 'default', name: 'Main' }], active: ws.state.activeSpace || 'default' });
  const handlers = {
    'strategy:backtest': a => require('./strategies').backtest(a),
    'browser:logs': a => ({logs:browsers.logs.get(a.id)||[],dialog:browsers.dialogs.get(a.id)||null}),
    'browser:dialog': a => browsers.debug(a.id,'Page.handleJavaScriptDialog',{accept:!!a.accept}),
    'tasks:list': () => tasks.list(), 'tasks:save': a => tasks.upsert(a), 'tasks:remove': a => tasks.remove(a.id), 'tasks:run': a => tasks.runNow(a.id),
    'notify:get': () => notifier.publicConfig(), 'notify:save': a => notifier.setConfig(a), 'notify:test': () => notifier.test(),
    'handoff:list': () => handoffs.list(), 'handoff:answer': a => handoffs.answer(a.id, a.accepted),
    'memory:get': () => ws.readNote('agent-memory'), 'memory:save': a => { ws.writeNote('agent-memory', String(a.text).slice(0,16000), 'user', 'Agent memory'); return true; },
    'risk:positions': () => risk.positionsWithPrices(), 'risk:closeAll': () => risk.closeAll(), 'risk:cancelPending': () => risk.cancelPending(),
    'rules:get': () => ws.state.items.filter(i => i.type === 'browser').map(i => ({ id: i.id, title: i.title, url: i.url, ...rulesFor(ws, i.id), health: sessionState.get(i.id) || 'Not checked yet' })),
    'rules:save': a => {
      const item = ws.requireItem(a.id, 'browser');
      if (!['act','read','none'].includes(a.mode)) throw new Error('Invalid access mode');
      const sites = String(a.sites || '').split(/[\s,]+/).filter(Boolean).map(s => { const url = new URL(s.includes('://') ? s : 'https://' + s); return url.hostname.toLowerCase(); });
      ws.settings.browserRules ||= {}; ws.settings.browserRules[item.profile] = { mode: a.mode, confirm: !!a.confirm, sites };
      ws.saveSettings(); return true;
    },
    'spaces:list': listSpaces,
    'spaces:add': a => { const s = { id: newId('space'), name: String(a.name || 'Space').slice(0,80), viewport: { x:0,y:0,scale:1 } }; ws.state.spaces ||= listSpaces().spaces; ws.state.spaces.push(s); ws.saveNow(); return s; },
    'spaces:switch': a => {
      if (assistant.busy || tasks.running) throw new Error('Stop the assistant before changing spaces');
      const s = ws.state.spaces.find(s => s.id === a.id); if (!s) throw new Error('Space not found');
      ws.state.spaces.find(s => s.id === ws.state.activeSpace).viewport = ws.state.viewport;
      ws.state.activeSpace = s.id; ws.state.viewport = s.viewport; ws.saveNow(); getWindow().webContents.reload(); return true;
    },
    'replay:list': () => ({ entries: replay.list(), screenshots: !!ws.settings.replayScreenshots }),
    'replay:settings': a => { ws.settings.replayScreenshots = !!a.screenshots; ws.saveSettings(); return true; },
    'replay:export': async () => { const r = await dialog.showSaveDialog(getWindow(), { defaultPath: 'officina-audit.json' }); if (r.canceled) return false; fs.writeFileSync(r.filePath, JSON.stringify(replay.list(),null,2)); return true; },
    'backup:create': async a => {
      if (assistant.busy || tasks.running) throw new Error('Stop the assistant before backing up');
      const r = await dialog.showSaveDialog(getWindow(), { defaultPath: 'Officina.acbackup', filters: [{ name:'Encrypted backup', extensions:['acbackup'] }] }); if(r.canceled) return false;
      ws.saveNow(); ws.saveSettings(); await keeper.snapshot();
      for (const profile of ws.profiles()) { const ses = session.fromPartition('persist:ac-' + profile); await ses.cookies.flushStore(); ses.flushStorageData(); }
      const data = pack(ws.root, a.password); fs.writeFileSync(r.filePath, data); return true;
    },
    'backup:restore': async a => {
      if (assistant.busy || tasks.running) throw new Error('Stop the assistant before restoring');
      const r = await dialog.showOpenDialog(getWindow(), { properties:['openFile'], filters:[{name:'Encrypted backup', extensions:['acbackup']}] }); if(r.canceled) return false;
      const destination = path.join(path.dirname(ws.root), 'Officina-Restored-' + Date.now());
      unpack(fs.readFileSync(r.filePaths[0]), a.password, destination);
      stop(); app.relaunch({ args: process.argv.slice(1).filter(a => !a.startsWith('--workspace=')).concat('--workspace=' + destination) }); app.quit(); return true;
    },
    'signals:get': () => signals.status(), 'signals:save': a => signals.configure(a),
    'browser:comfort': async a => {
      const item = ws.requireItem(a.id, 'browser'), wc = browsers.wc(a.id);
      if(a.action === 'find') { if (a.text) wc.findInPage(String(a.text)); else wc.stopFindInPage('clearSelection'); }
      else if(a.action === 'zoom') { const zoom = Math.max(0.25,Math.min(3,Number(a.value) || 1)); wc.setZoomFactor(zoom); ws.updateItem(a.id,{zoom}); }
      else if(a.action === 'mute') { wc.setAudioMuted(!!a.value); ws.updateItem(a.id,{muted:!!a.value}); }
      else if(a.action === 'pdf') { const data = await wc.printToPDF({ printBackground:true }); return ws.writeFile(ws.uniqueRel('exports/page.pdf'),data,'user'); }
      else if(a.action === 'popout') { if (!wc.session) throw new Error('A Brave window cannot be popped out yet. Zoom to it on the canvas instead (double-click its header).'); const w = new BrowserWindow({ width:1000,height:740,title:item.title,autoHideMenuBar:true,webPreferences:{session:wc.session,nodeIntegration:false,contextIsolation:true,sandbox:true} }); w.webContents.setWindowOpenHandler(() => ({ action:'deny' })); w.loadURL(wc.getURL()); }
      return true;
    },
  };
  ipcMain.handle('features:command', async (event, name, args = {}) => {
    if (event.sender !== getWindow()?.webContents) throw new Error('Untrusted caller');
    if (!Object.hasOwn(handlers,name)) throw new Error('Unknown feature command');
    return handlers[name](args);
  });
  return { handoffs, notifier, audit: (...a) => replay.record(...a), dispose() { clearInterval(health); tasks.dispose(); risk.dispose(); handoffs.cancelAll(); signals.close(); }, reset() { tasks.data={tasks:[],runs:[]};tasks.queue=[];tasks.save(); risk.brackets=[];risk.save(); handoffs.cancelAll(); for(const file of ['replay.jsonl','signals-seen.json']) fs.rmSync(path.join(ws.root,file),{force:true}); ws.settings.browserRules={}; } };
}
module.exports = { extensions };
