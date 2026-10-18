// Tests for: messages to working agents, round off, step budget, tidy-up after a task,
// token counter, New chat during a task, organising the canvas, Brave as browser engine,
// software installs and the reset of agents. Loaded by run.js (offline, no Electron).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { Workspace } = require('../main/workspace');
const { Activity } = require('../main/activity');
const { KeyStore } = require('../main/keys');
const { Trading } = require('../main/trading');
const { McpServer } = require('../main/mcp');

const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from('ENC:' + Buffer.from(s).toString('base64')),
  decryptString: b => Buffer.from(b.toString().slice(4), 'base64').toString(),
};

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-feat-'));
  const ws = new Workspace(root);
  ws.init();
  const activity = new Activity(root);
  const keys = new KeyStore(ws.dirs.secrets, fakeSafe);
  const trading = new Trading({ ws, keys, activity });
  return { root, ws, activity, keys, trading };
}

// Browsers that "load" instantly, so browser_open works without Electron.
function fakeBrowsers(ws) {
  return { wcByItem: new Map(), waitForAttach: async () => {}, waitForLoad: async () => {}, wc: id => ({ getURL: () => ws.getItem(id)?.url || 'about:blank' }) };
}

function makeMcp(ws, keys, trading, activity, extra = {}) {
  return new McpServer({ ws, keys, trading, activity, browsers: fakeBrowsers(ws), cursor: null, isPaused: () => false, getToken: () => 't', touch() {}, focusItem() {}, fileChanged() {}, ...extra });
}

// An OpenAI-style model server; decide(body, n) returns { text } or { tool, args }.
async function modelServer(decide) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', async () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      const out = await decide(body, bodies.length);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = d => res.write(`data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`);
      if (out.tool) send({ tool_calls: [{ index: 0, id: `c${bodies.length}`, function: { name: out.tool, arguments: JSON.stringify(out.args || {}) } }] });
      else send({ content: out.text });
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 7 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, bodies, url: `http://127.0.0.1:${server.address().port}/v1` };
}
const lastUser = body => [...body.messages].reverse().find(m => m.role === 'user')?.content || '';
const allText = body => body.messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');

test('agents: no step limit, and an agent that finds nothing new is nudged to try another way, never stopped', async () => {
  const { ws, keys, trading, activity } = setup();
  const { LocalAgent, STALL_AT } = require('../main/localagent');
  const mcp = makeMcp(ws, keys, trading, activity);
  // Every search in the empty library returns the same nothing; the model itself ends after three stalls.
  const m = await modelServer((body, n) => (m.bodies.length <= STALL_AT * 3 ? { tool: 'library_search', args: { query: `q${n}` } } : { text: 'Final answer.' }));
  const agent = new LocalAgent({ ws, mcp, isPaused: () => false, safeStorage: fakeSafe });
  agent.setConfig({ runner: 'custom', baseUrl: m.url, model: 'm' });
  await agent.send('research forever');
  const at = re => m.bodies.findIndex(b => b.messages.some(x => re.test(x.content || '')));
  assert.equal(at(/Your last steps found nothing new/), STALL_AT, 'first stall: a progress check');
  assert.ok(m.bodies.filter(b => /found nothing new/.test(lastUser(b))).length >= 2, 'every stall: another nudge');
  assert.ok(m.bodies.every(b => b.tools), 'tools are never taken away');
  assert.ok(!m.bodies.some(b => b.messages.some(x => /round off|No more tools/.test(x.content || ''))), 'never told to round off');
  assert.equal(agent.log.filter(e => e.type === 'assistant').at(-1).text, 'Final answer.');
  assert.ok(agent.log.some(e => e.type === 'notice' && /asked to try another way/.test(e.text)));
  m.server.close();
});

test('agents: while their steps keep producing something they work on, and only check in now and then', async () => {
  const { ws, keys, trading, activity } = setup();
  const { LocalAgent, FIRST_CHECK_IN, novelty } = require('../main/localagent');
  const mcp = makeMcp(ws, keys, trading, activity);
  // Each step writes a new note: real progress, so no stall; it ends when the check-in asks.
  const m = await modelServer((body, n) => (/Check-in after/.test(lastUser(body)) ? { text: 'Wrote all notes.' } : { tool: 'note_create', args: { title: `Note ${n}`, content: `Finding number ${n} about the market.` } }));
  const agent = new LocalAgent({ ws, mcp, isPaused: () => false, safeStorage: fakeSafe });
  agent.setConfig({ runner: 'custom', baseUrl: m.url, model: 'm' });
  await agent.send('write many notes');
  assert.equal(m.bodies.length, FIRST_CHECK_IN + 1, `worked past any fixed budget, checked in at ${FIRST_CHECK_IN}`);
  assert.ok(m.bodies.every(b => b.tools), 'never forced to stop');
  assert.ok(!m.bodies.some(b => /found nothing new/.test(allText(b))));
  assert.equal(agent.log.filter(e => e.type === 'assistant').at(-1).text, 'Wrote all notes.');
  // what counts as new: sentences not seen before in this task; element lists are ignored
  const seen = new Set();
  const page = '{"text": "Brave Shields blocks trackers on every page you open.\\nIt also blocks ads by default for all users.", "elements": ["[1] link \\"Home page of the site\\" -> https://x.test/"]}';
  assert.equal(novelty(page, seen), 1);
  assert.equal(novelty(page, seen), 0, 'the same page again tells nothing new');
  m.server.close();
});

test('agents: a message sent while they work is read before the next step', async () => {
  const { ws, keys, trading, activity } = setup();
  const { LocalAgent } = require('../main/localagent');
  const mcp = makeMcp(ws, keys, trading, activity);
  let release;
  const gate = new Promise(r => { release = r; });
  const m = await modelServer(async (body, n) => {
    if (/tell me your findings/.test(allText(body))) return { text: 'Findings: three APIs.' };
    if (n === 2) await gate; // hold the second step until the message is in
    return { tool: 'library_search', args: { query: `q${n}` } };
  });
  const agent = new LocalAgent({ ws, mcp, isPaused: () => false, safeStorage: fakeSafe });
  agent.setConfig({ runner: 'custom', baseUrl: m.url, model: 'm' });
  const run = agent.send('look around');
  while (m.bodies.length < 2) await new Promise(r => setTimeout(r, 10));
  await agent.send('tell me your findings'); // busy: delivered, not refused
  assert.equal(agent.inbox.length, 1);
  assert.ok(agent.log.some(e => e.type === 'user' && e.during), 'shown in the chat at once');
  release();
  await run;
  assert.match(lastUser(m.bodies.at(-1)), /\[Message from the user while you work\]\ntell me your findings/);
  assert.equal(agent.log.filter(e => e.type === 'assistant').at(-1).text, 'Findings: three APIs.');
  m.server.close();
});

test('team: round off reaches busy helpers, team_message reaches them mid-task', async () => {
  const { ws, keys, trading, activity } = setup();
  const { Team } = require('../main/team');
  const mcp = makeMcp(ws, keys, trading, activity);
  const m = await modelServer(body => (/round off/i.test(lastUser(body)) ? { text: 'Wrapped up: done.' } : (/STATUS\?/.test(lastUser(body)) ? { text: 'Status: fine.' } : { tool: 'library_search', args: { query: String(Math.random()) } })));
  const team = new Team({ ws, mcp, isPaused: () => false, safeStorage: fakeSafe });
  team.get('assistant').setConfig({ runner: 'custom', baseUrl: m.url, model: 'm', canLead: true });
  mcp.ctx.team = team;
  const by = { id: 'assistant', label: 'Assistant' };
  const h = team.spawnHelper({ by, name: 'Scout', task: 'scan' });
  const helper = team.get(h.id);
  while (m.bodies.length < 2) await new Promise(r => setTimeout(r, 10));
  const sent = team.message({ text: 'STATUS?', by });
  assert.equal(sent.sent[0].delivered, 'during its task');
  while (helper.busy) await new Promise(r => setTimeout(r, 10));
  assert.equal(helper.log.filter(e => e.type === 'assistant').at(-1).text, 'Status: fine.');
  // round off: only busy agents are asked
  team.assign(h.id, 'scan again', by);
  while (m.bodies.length < 6) await new Promise(r => setTimeout(r, 10));
  const r = team.wrapUp({ by });
  assert.deepEqual(r.asked.map(a => a.name), ['Scout']);
  while (helper.busy) await new Promise(r2 => setTimeout(r2, 10));
  assert.equal(team.result(h.id).answer, 'Wrapped up: done.');
  assert.ok(helper.log.some(e => e.type === 'notice' && /Assistant asked Scout to round off/.test(e.text)));
  // the token counter saw every call
  const t = team.tokenSummary();
  assert.ok(t.total >= m.bodies.length * 100, 'prompt tokens from the server');
  assert.ok(t.byAgent.some(a => a.name === 'Scout'));
  assert.equal(team.resetTokens().total, 0);
  m.server.close();
});

test('agents: after a task they close windows they opened and no longer need', async () => {
  const { ws, keys, trading, activity } = setup();
  const { LocalAgent } = require('../main/localagent');
  const mcp = makeMcp(ws, keys, trading, activity);
  const m = await modelServer((body, n) => {
    const u = lastUser(body);
    if (/Tidy up the canvas/.test(u) && body.messages.at(-1).role === 'user') return { tool: 'item_close', args: { id: u.match(/id=(\S+) "a\.test"/)[1] } };
    if (/Tidy up the canvas/.test(u)) return { text: 'Closed a.test, kept b.test.' };
    if (n === 1) return { tool: 'browser_open', args: { url: 'https://a.test/', title: 'a.test' } };
    if (n === 2) return { tool: 'browser_open', args: { url: 'https://b.test/', title: 'b.test' } };
    return { text: 'Done: compared both sites.' };
  });
  const agent = new LocalAgent({ ws, mcp, isPaused: () => false, safeStorage: fakeSafe });
  agent.setConfig({ runner: 'custom', baseUrl: m.url, model: 'm' });
  await agent.send('compare two sites');
  const titles = ws.listItems().filter(i => i.type === 'browser').map(i => i.title);
  assert.deepEqual(titles, ['b.test'], 'the one it closed is gone, the one it kept stays');
  assert.equal(agent.log.filter(e => e.type === 'assistant').at(-1).text, 'Done: compared both sites.', 'the real answer stays the answer');
  assert.match(agent.log.at(-1).text, /Tidied up: closed 1 window it no longer needed, kept 1 open/);
  // switched off: no clean-up round
  ws.settings.agentTidy = false;
  const before = m.bodies.length;
  await agent.send('again');
  assert.ok(m.bodies.length - before <= 3);
  assert.ok(!m.bodies.slice(before).some(b => /Tidy up the canvas/.test(lastUser(b))));
  m.server.close();
});

test('New chat during a task leaves the new chat empty', async () => {
  const { ws, keys, trading, activity } = setup();
  const { LocalAgent } = require('../main/localagent');
  const mcp = makeMcp(ws, keys, trading, activity);
  const m = await modelServer(async () => { await new Promise(r => setTimeout(r, 150)); return { tool: 'library_search', args: { query: String(Math.random()) } }; });
  const agent = new LocalAgent({ ws, mcp, isPaused: () => false, safeStorage: fakeSafe });
  agent.setConfig({ runner: 'custom', baseUrl: m.url, model: 'm' });
  const run = agent.send('work');
  await new Promise(r => setTimeout(r, 400));
  agent.reset();
  await run;
  await new Promise(r => setTimeout(r, 300));
  assert.equal(agent.busy, false);
  assert.deepEqual(agent.log, [], 'nothing from the old task lands in the new chat');
  assert.deepEqual(agent.messages, []);
  m.server.close();
});

test('organise: browsers, notes and files each get a labelled block; frames are reused', () => {
  const { ws } = setup();
  const b1 = ws.addItem({ type: 'browser', url: 'https://a.test', x: 900, y: 50 });
  const n1 = ws.addItem({ type: 'note', title: 'One', x: 0, y: 0 });
  ws.addItem({ type: 'browser', url: 'https://b.test', x: -400, y: 700 });
  ws.addItem({ type: 'note', title: 'Two', x: 2000, y: 2000 });
  fs.writeFileSync(ws.safePath('x.txt'), 'x');
  ws.addItem({ type: 'file', path: 'x.txt', x: 500, y: 500 });
  const r = ws.organize();
  assert.deepEqual(r.groups.map(g => [g.group, g.count]), [['Browsers', 2], ['Notes', 2], ['Files and folders', 1]]);
  const frames = ws.listItems().filter(i => i.type === 'frame');
  assert.equal(frames.length, 3);
  const inside = (it, f) => it.x >= f.x && it.y >= f.y && it.x + it.w <= f.x + f.w && it.y + it.h <= f.y + f.h;
  const fb = frames.find(f => f.auto === 'browser'), fn = frames.find(f => f.auto === 'note');
  for (const it of ws.listItems().filter(i => i.type === 'browser')) assert.ok(inside(it, fb), 'browsers inside their block');
  for (const it of ws.listItems().filter(i => i.type === 'note')) assert.ok(inside(it, fn), 'notes inside theirs');
  assert.ok(fn.x >= fb.x + fb.w, 'blocks sit side by side');
  const loose = ws.listItems().filter(i => i.type !== 'frame');
  for (const a of loose) for (const b of loose) if (a !== b) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, 'nothing overlaps');
  ws.organize();
  assert.equal(ws.listItems().filter(i => i.type === 'frame').length, 3, 'the same frames are reused');
  ws.removeItem(n1.id); ws.removeItem(ws.listItems().find(i => i.type === 'note').id);
  ws.organize();
  assert.ok(!ws.listItems().some(i => i.auto === 'note'), 'an empty block loses its frame');
  assert.ok(ws.getItem(b1.id));
});

test('browsers: new windows use Brave when chosen; a profile keeps its browser engine', () => {
  const { ws } = setup();
  assert.equal(ws.addItem({ type: 'browser', url: 'https://old.test' }).engine, 'builtin', 'without Brave: built-in');
  let choice = 'brave';
  ws.browserEngine = () => choice;
  const b = ws.addItem({ type: 'browser', url: 'https://a.test' });
  assert.equal(b.engine, 'brave');
  choice = 'builtin';
  assert.equal(ws.addItem({ type: 'browser', url: 'https://a.test', profile: b.profile }).engine, 'brave', 'a second window on the same login uses the same engine');
  ws.removeItem(b.id);
  assert.equal(ws.state.closedBrowsers[0].engine, 'brave');
  assert.equal(ws.addItem({ type: 'browser', url: 'https://a.test', profile: b.profile }).engine, 'brave', 'reopening a closed profile too');
  assert.equal(ws.addItem({ type: 'browser', url: 'https://c.test', engine: 'brave' }).engine, 'brave', 'an explicit choice wins for a new profile');
});

test('software: a download is installed only when it matches the published checksum', async () => {
  const { root } = setup();
  const { Software, newer, CATALOG } = require('../main/software');
  // The asset name this computer downloads (Windows zip, or the Mac zip for this processor).
  const asset = ['brave-v1.97.56-win32-x64.zip', 'brave-v1.97.56-darwin-arm64.zip', 'brave-v1.97.56-darwin-x64.zip'].find(n => CATALOG[0].asset.test(n));
  const zip = Buffer.from('pretend this is brave.zip');
  let sum = crypto.createHash('sha256').update(zip).digest('hex');
  const release = [{ prerelease: true, name: 'Beta v1.98.1', assets: [] }, { prerelease: false, name: 'Nightly v1.99.1', assets: [{ name: 'brave-v1.99.1-win32-x64.zip', size: 1, browser_download_url: 'nightly' }] }, { prerelease: false, name: 'Release v1.97.56 (Chromium 155)', assets: [{ name: asset, size: zip.length, browser_download_url: 'zip' }, { name: `${asset}.sha256`, browser_download_url: 'sum' }] }];
  const fetchImpl = async url => {
    if (url.includes('api.github.com')) return { ok: true, json: async () => release };
    if (url === 'sum') return { ok: true, text: async () => `${sum}  brave-v1.97.56-win32-x64.zip` };
    return { ok: true, body: (async function* gen() { yield zip; })() };
  };
  // A fake unpack that lays out the program the way the real download does on this platform.
  const unpack = async (_zip, target) => {
    if (process.platform !== 'darwin') return fs.writeFileSync(path.join(target, 'brave.exe'), 'exe');
    const bin = path.join(target, 'Brave Browser.app', 'Contents', 'MacOS');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'Brave Browser'), 'exe');
  };
  const sw = new Software({ root, fetchImpl, unpack });
  let stopped = 0;
  sw.beforeChange.set('brave', async () => { stopped++; });
  await sw.install('brave');
  const st = sw.status().find(x => x.id === 'brave');
  assert.equal(st.installed.version, '1.97.56');
  assert.ok(fs.existsSync(sw.exePath('brave')));
  assert.equal(stopped, 1, 'running Brave windows are stopped before files change');
  sum = 'f'.repeat(64);
  await assert.rejects(sw.install('brave'), /does not match its published checksum/);
  assert.equal(sw.installed('brave').version, '1.97.56', 'the working install is kept');
  assert.ok(!fs.existsSync(path.join(root, 'software', 'brave.zip.part')), 'the bad download is thrown away');
  await sw.remove('brave');
  assert.equal(sw.exePath('brave'), null);
  assert.ok(newer('1.97.56', '1.96.120') && !newer('1.97.56', '1.97.56') && !newer('1.9.1', '1.10.0'));
});

test('Brave: canvas and agent input become DevTools input events', () => {
  const { fromElectron, fromUser } = require('../main/brave');
  assert.deepEqual(fromElectron({ type: 'mouseWheel', x: 5, y: 6, deltaY: -120 }), ['Input.dispatchMouseEvent', { type: 'mouseWheel', x: 5, y: 6, modifiers: 0, deltaX: -0, deltaY: 120 }], 'Electron scrolls down with a negative delta');
  const enter = fromElectron({ type: 'keyDown', keyCode: 'Return' })[1];
  assert.equal(enter.type, 'rawKeyDown'); assert.equal(enter.key, 'Enter'); assert.equal(enter.windowsVirtualKeyCode, 13);
  assert.equal(fromElectron({ type: 'keyDown', keyCode: 'a', modifiers: ['control'] })[1].modifiers, 2);
  assert.deepEqual(fromElectron({ type: 'char', keyCode: 'x' })[1].text, 'x');
  const drag = fromElectron({ type: 'mouseMove', x: 1, y: 2, modifiers: ['leftButtonDown'] })[1];
  assert.equal(drag.buttons, 1);
  assert.equal(fromUser({ kind: 'key', type: 'down', key: 'a', code: 'KeyA', keyCode: 65, modifiers: [] })[1].text, 'a');
  assert.equal(fromUser({ kind: 'key', type: 'down', key: 'a', code: 'KeyA', keyCode: 65, modifiers: ['control'] })[1].type, 'rawKeyDown', 'Ctrl+A is a shortcut, not text');
  assert.equal(fromUser({ kind: 'key', type: 'down', key: '@', code: 'Digit2', keyCode: 50, modifiers: ['control', 'alt'] })[1].text, '@', 'AltGr characters still type');
  assert.equal(fromUser({ kind: 'key', type: 'down', key: 'Enter', keyCode: 13, modifiers: [] })[1].text, '\r');
  assert.equal(fromUser({ kind: 'mouse', type: 'down', x: 10.6, y: 3.2, button: 'left', buttons: 1, clickCount: 2 })[1].clickCount, 2);
  assert.deepEqual(fromUser({ kind: 'text', text: 'hé' }), ['Input.insertText', { text: 'hé' }]);
  assert.equal(fromUser({ kind: 'nope' }), null);
});

test('Brave: a tab answers like a webContents (isolated scripts, history, blocked count)', async () => {
  const { BravePage } = require('../main/brave');
  const calls = [];
  let world = 0;
  const cdp = { send: async (method, params) => {
    calls.push(method);
    if (method === 'Page.createIsolatedWorld') return { executionContextId: ++world };
    if (method === 'Runtime.evaluate') return { result: { value: `ran in ${params.contextId || 'main'}` } };
    if (method === 'Page.getNavigationHistory') return { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }] };
    return {};
  } };
  const states = [];
  const engine = { emit: (ev, id, patch) => { if (ev === 'state') states.push(patch); } };
  const page = new BravePage({ engine, proc: { cdp }, itemId: 'b1', targetId: 'T', sessionId: 'S' });
  assert.equal(await page.executeJavaScriptInIsolatedWorld(1077, [{ code: '1' }]), 'ran in 1');
  assert.equal(await page.executeJavaScriptInIsolatedWorld(1077, [{ code: '2' }]), 'ran in 1', 'the same world while the page stays');
  page.onEvent('Page.frameNavigated', { frame: { id: 'T', url: 'https://next.test/' } });
  assert.equal(page.getURL(), 'https://next.test/');
  assert.equal(await page.executeJavaScriptInIsolatedWorld(1077, [{ code: '3' }]), 'ran in 2', 'a new page gets a new world');
  await page.refreshHistory();
  assert.ok(page.navigationHistory.canGoBack() && !page.navigationHistory.canGoForward());
  page.onEvent('Page.frameStartedLoading', { frameId: 'T' });
  assert.equal(page.isLoading(), true);
  page.onEvent('Network.loadingFailed', { errorText: 'net::ERR_BLOCKED_BY_CLIENT' });
  page.onEvent('Network.loadingFailed', { errorText: 'net::ERR_ABORTED' });
  assert.equal(page.blocked, 1, 'only Shields blocks count');
  let stopped = false;
  page.once('did-stop-loading', () => { stopped = true; });
  page.onEvent('Page.frameStoppedLoading', { frameId: 'T' });
  assert.ok(stopped && !page.isLoading());
  const seen = [];
  page.debugger.on('message', (_e, method) => seen.push(method));
  page.onEvent('Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' });
  assert.deepEqual(seen, ['Page.javascriptDialogOpening'], 'browserctl sees the same events as from Electron');
  assert.equal(states.at(-1).dialog.message, 'Sure?');
  page.markDestroyed();
  await assert.rejects(page.send('Page.reload'), /closed/);
});

test('Brave: sharp frames follow display scale and height, with CSS input coordinates', async () => {
  const { BravePage } = require('../main/brave');
  const calls = [];
  const cdp = { send: async (method, params) => { calls.push({ method, params }); return { windowId: 1 }; } };
  const page = new BravePage({ engine: { emit() {} }, proc: { cdp }, itemId: 'sharp', targetId: 'T', sessionId: 'S' });
  page.evaluate = async () => ({ w: 800, h: 600 });
  await page.resize(800, 600, 2);
  const metrics = calls.find(c => c.method === 'Emulation.setDeviceMetricsOverride').params;
  assert.equal(metrics.deviceScaleFactor, 2);
  assert.equal(metrics.width, 800);
  assert.equal(calls.filter(c => c.method === 'Browser.setWindowBounds').at(-1).params.bounds.width, 1616);
  await page.startCast({ maxWidth: 1600, maxHeight: 1200 });
  await page.startCast({ maxWidth: 1600, maxHeight: 1600 });
  assert.equal(calls.filter(c => c.method === 'Page.startScreencast').length, 2);
  assert.equal(calls.at(-1).params.format, 'png');
  assert.ok(calls.some(c => c.method === 'Page.stopScreencast'));
  page.onFrame({ data: '', metadata: { deviceWidth: 1600, deviceHeight: 1200 }, sessionId: 1 });
  assert.deepEqual(page.lastFrame.meta, { w: 800, h: 600 });
});

test('memory meter: Brave and the engine count with all their child processes', () => {
  const { treeTotals } = require('../main/ram');
  const rows = [
    { ProcessId: 10, ParentProcessId: 1, Name: 'brave.exe', WorkingSetSize: 100 },
    { ProcessId: 11, ParentProcessId: 10, Name: 'brave.exe', WorkingSetSize: 50 },
    { ProcessId: 12, ParentProcessId: 11, Name: 'brave.exe', WorkingSetSize: 25 },
    { ProcessId: 20, ParentProcessId: 1, Name: 'brave.exe', WorkingSetSize: 999 }, // the user's own Brave
    { ProcessId: 30, ParentProcessId: 1, Name: 'llama-server.exe', WorkingSetSize: 70 },
  ];
  assert.deepEqual(treeTotals(rows, [10, 30]), { brave: 175, 'llama-server': 70 });
});

test('reset space: every agent but the first goes, and outside agents are forgotten', () => {
  const { ws, keys, trading, activity } = setup();
  const { Team } = require('../main/team');
  const { Agents } = require('../main/agents');
  const mcp = makeMcp(ws, keys, trading, activity);
  const agents = new Agents(ws);
  const team = new Team({ ws, mcp, isPaused: () => false, safeStorage: fakeSafe, agents });
  team.get('assistant').setConfig({ runner: 'custom', baseUrl: 'http://x/v1', model: 'm', canLead: true, role: 'boss' });
  team.update('assistant', { name: 'CEO' });
  team.add({ name: 'Researcher' });
  team.spawnHelper({ by: { id: 'assistant', label: 'CEO' }, name: 'Helper' });
  agents.touch('Claude Code', 'browser_read');
  team.countTokens('CEO', { input: 10, output: 2 });
  team.resetAll();
  agents.resetAll();
  assert.deepEqual(team.list().map(a => [a.name, a.model, a.canLead]), [['Assistant', 'm', false]], 'one agent left, with its model');
  assert.equal(team.profile('assistant').role, '');
  assert.equal(team.members.size, 1);
  assert.equal(team.config.model, 'm', 'saved tasks read the first agent through the team');
  assert.deepEqual(agents.list().map(a => a.name), ['Assistant'], 'Claude Code and the old names are forgotten');
  assert.equal(team.tokenSummary().total, 0);
});
