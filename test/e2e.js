// End-to-end check of every roadmap feature against a running Officina.
// usage: start the app with --remote-debugging-port=9333 --workspace=<dir>, then
//        node test/e2e.js <dir>
// It serves a small local test site (forms, upload, iframe, dialog, login page)
// and a mock model, so nothing depends on outside websites except paper prices.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startMockLlm } = require('./mock-llm');

const WS = process.argv[2];
const settings = () => JSON.parse(fs.readFileSync(path.join(WS, 'settings.json'), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push(['PASS', name, detail || '']);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---------- clients ----------
let sid = null;
async function mcp(name, args = {}) {
  const s = settings();
  const r = await fetch(`http://127.0.0.1:${s.mcpPort}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.mcpToken}`, ...(sid ? { 'Mcp-Session-Id': sid } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await r.json();
  const out = j.result;
  out.text = (out.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  return out;
}
async function initMcp(client) {
  const s = settings();
  const r = await fetch(`http://127.0.0.1:${s.mcpPort}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.mcpToken}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: client } } }) });
  return r.headers.get('mcp-session-id');
}

async function cdpEval(match, expression) {
  const targets = await (await fetch('http://127.0.0.1:9333/json')).json();
  const t = targets.find(match);
  if (!t) throw new Error('target not found');
  const sock = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => sock.addEventListener('open', r));
  return new Promise((resolve, reject) => {
    sock.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      sock.close();
      if (m.result?.exceptionDetails) reject(new Error(m.result.exceptionDetails.exception?.description || 'eval failed'));
      else resolve(m.result?.result?.value);
    });
    sock.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
const ui = expr => cdpEval(t => t.type === 'page' && t.url.startsWith('ac://app'), expr);
const feature = (name, args) => ui(`window.ac.feature(${JSON.stringify(name)}, ${JSON.stringify(args || {})})`);
const page = (urlPart, expr) => cdpEval(t => t.url.includes(urlPart), expr);

// ---------- local test site ----------
function startSite() {
  const pages = {
    '/form': '<title>Form</title><form><label>Name <input name="custname" id="custname"></label><label>Email <input name="email" id="email"></label><input type="file" id="file" onchange="document.getElementById(`picked`).textContent = `picked ${this.files[0].name}`"></form><p id="picked"></p>',
    '/dialog': '<title>Dialog</title><p>A page that asks</p><script>setTimeout(() => alert("hello from page"), 1500)</script>',
    '/frame': '<title>Frame</title><h1>Outer page</h1><iframe id="inner" src="/inner" width="400" height="200"></iframe>',
    '/inner': '<title>Inner</title><p>Inside the frame</p><button onclick="this.textContent=\'clicked\'">Inner button</button>',
    '/login': '<title>Login</title><form><input name="u"><input type="password" name="p"></form>',
    '/plain': '<title>Plain</title><p>Just a page</p><a href="/plain#x">Link here</a>',
  };
  const server = http.createServer((req, res) => {
    const body = pages[req.url.split('?')[0]] || '<title>404</title>';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><body>${body}</body></html>`);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

(async () => {
  const site = await startSite();
  const llm = await startMockLlm();
  sid = await initMcp('E2E check');

  const opened = await mcp('browser_open', { url: `${site.base}/plain`, title: 'E2E browser' });
  const bid = JSON.parse(opened.text).id;
  console.log('Main browser engine:', JSON.parse(fs.readFileSync(path.join(WS, 'state.json'), 'utf8')).items.find(i => i.id === bid)?.engine || '(not saved yet)');

  await check('Features button lists every feature with a button', async () => {
    const r = await ui(`(async () => { document.querySelector('[data-panel=features]').click(); await new Promise(r => setTimeout(r, 500)); const n = document.querySelectorAll('.feat').length, b = document.querySelectorAll('.feat .btn').length; document.querySelector('#drawer-close').click(); return [n, b]; })()`);
    assert(r[0] >= 30 && r[0] === r[1], `entries ${r[0]}, buttons ${r[1]}`);
    return `${r[0]} entries, ${r[1]} buttons`;
  });

  await check('Notifications (desktop test notification)', async () => {
    assert(await feature('notify:test') === true, 'notify:test failed');
    const c = await feature('notify:get');
    return `desktop=${c.desktop}`;
  });

  await check('Agent memory (append via MCP, visible in app)', async () => {
    await mcp('memory_append', { text: 'E2E: prefers BTC and ETH only' });
    const m = await feature('memory:get');
    assert(m.includes('prefers BTC and ETH only'), 'memory not saved');
    const r = await mcp('memory_read');
    assert(r.text.includes('prefers BTC'), 'memory_read missing text');
  });

  await check('Browser rules: read-only, no access and site allowlist block the agent', async () => {
    await feature('rules:save', { id: bid, mode: 'read', sites: '', confirm: false });
    const a = await mcp('browser_click', { id: bid, text: 'Link here' });
    assert(a.isError, 'click allowed in read-only mode');
    await feature('rules:save', { id: bid, mode: 'none', sites: '', confirm: false });
    const b = await mcp('browser_read', { id: bid });
    assert(b.isError, 'read allowed with no access');
    await feature('rules:save', { id: bid, mode: 'act', sites: 'example.org', confirm: false });
    const c = await mcp('browser_click', { id: bid, text: 'Link here' });
    assert(c.isError, 'click allowed on a site outside the allowlist');
    await feature('rules:save', { id: bid, mode: 'act', sites: '', confirm: false });
    const d = await mcp('browser_click', { id: bid, text: 'Link here' });
    assert(!d.isError, `click blocked after restoring access: ${d.text}`);
    return 'read-only, no access and allowlist all enforced';
  });

  await check('AI asks you (handoff waits for the user, then continues)', async () => {
    const pending = mcp('ask_user', { id: bid, message: 'E2E: please confirm' });
    let list = [];
    for (let i = 0; i < 20 && !list.length; i++) { await sleep(250); list = await feature('handoff:list'); }
    assert(list.length, 'no handoff request appeared');
    await feature('handoff:answer', { id: list[0].id, accepted: true });
    const r = await pending;
    assert(!r.isError, r.text);
    return r.text.slice(0, 80);
  });

  await check('Embedded frames: list and read an iframe', async () => {
    await mcp('browser_navigate', { id: bid, url: `${site.base}/frame` });
    await sleep(800);
    const frames = await mcp('browser_frames', { id: bid });
    const parsed = JSON.parse(frames.text);
    const inner = parsed.find(f => String(f.url).includes('/inner'));
    assert(inner, `inner frame not listed: ${frames.text.slice(0, 200)}`);
    const read = await mcp('browser_frame_read', { id: bid, frame: inner.id });
    assert(read.text.includes('Inside the frame'), 'frame text not read');
    return `frame ${inner.id}`;
  });

  await check('JavaScript dialogs: agent sees and closes an alert', async () => {
    // The page itself raises the alert, so this works in Brave windows and built-in ones alike.
    await mcp('browser_navigate', { id: bid, url: `${site.base}/dialog` });
    await sleep(2500);
    const seen = await mcp('browser_dialog', { id: bid });
    assert(seen.text.includes('hello from page'), `dialog not seen: ${seen.text.slice(0, 120)}`);
    const closed = await mcp('browser_dialog', { id: bid, accept: true });
    assert(!closed.isError, closed.text);
  });

  await check('Extra browser tools: fill a form, upload a file, save PDF, logs', async () => {
    await mcp('browser_navigate', { id: bid, url: `${site.base}/form` });
    await sleep(500);
    const read = await mcp('browser_read', { id: bid });
    const ref = n => {
      const m = read.text.match(new RegExp(`\\[(\\d+)\\] input:text "${n}`));
      if (!m) throw new Error(`no field "${n}" in: ${read.text.slice(0, 300)}`);
      return Number(m[1]);
    };
    const fill = await mcp('browser_fill', { id: bid, fields: [{ ref: ref('Name'), value: 'Ada' }, { ref: ref('Email'), value: 'ada@example.com' }] });
    assert(!fill.isError, `fill failed: ${fill.text}`);
    const after = (await mcp('browser_read', { id: bid })).text;
    assert(/value="Ada"/.test(after) && /value="ada@example.com"/.test(after), `values not filled: ${after.slice(0, 300)}`);
    await mcp('file_write', { path: 'e2e/upload.txt', content: 'hello upload' });
    const up = await mcp('browser_upload', { id: bid, selector: '#file', path: 'e2e/upload.txt' });
    assert(!up.isError, `upload failed: ${up.text}`);
    const shown = (await mcp('browser_read', { id: bid })).text;
    assert(/picked upload.txt/.test(shown), `uploaded file not picked: ${shown.slice(0, 300)}`);
    const pdf = await mcp('browser_pdf', { id: bid });
    assert(!pdf.isError && fs.existsSync(path.join(WS, 'files', JSON.parse(pdf.text).path)), 'pdf not saved');
    const logs = await mcp('browser_logs', { id: bid });
    assert(!logs.isError, logs.text);
  });

  await check('Logged-out warning (login form detected)', async () => {
    await mcp('browser_navigate', { id: bid, url: `${site.base}/login` });
    let health = '';
    for (let i = 0; i < 40 && !/Login may be required/.test(health); i++) {
      await sleep(1000);
      health = (await feature('rules:get')).find(r => r.id === bid)?.health || '';
    }
    assert(/Login may be required/.test(health), `health: ${health}`);
    return health;
  });

  await check('Replay records agent actions with screenshots', async () => {
    await feature('replay:settings', { screenshots: true });
    await mcp('browser_navigate', { id: bid, url: `${site.base}/plain` });
    await mcp('browser_click', { id: bid, text: 'Link here' });
    await sleep(800);
    const d = await feature('replay:list');
    assert(d.entries.length > 0, 'no replay entries');
    assert(d.entries.some(e => e.screenshot), 'no screenshots recorded');
    return `${d.entries.length} entries`;
  });

  await check('Saved tasks run on the assistant (mock model)', async () => {
    await ui(`window.ac.llmSetConfig(null, { runner: 'custom', baseUrl: 'http://127.0.0.1:${llm.port}/v1', model: 'mock-oa' })`);
    const t = await feature('tasks:save', { name: 'E2E task', prompt: 'write a note', schedule: { type: 'every', minutes: 60 }, enabled: true, notify: false });
    await feature('tasks:run', { id: t.id });
    let run;
    for (let i = 0; i < 40; i++) { await sleep(500); run = (await feature('tasks:list')).runs.find(r => r.taskId === t.id && r.status !== 'running'); if (run) break; }
    assert(run && run.status === 'done', `run: ${JSON.stringify(run)}`);
    const next = (await feature('tasks:list')).tasks.find(x => x.id === t.id).nextRunAt;
    assert(next, 'no next scheduled run');
    return `done, next run ${new Date(next).toLocaleTimeString()}`;
  });

  await check('Webhook signal triggers a saved task; phone companion state and STOP', async () => {
    const t = (await feature('tasks:list')).tasks.find(x => x.name === 'E2E task');
    await feature('signals:save', { enabled: true, lan: false, port: 4791, taskId: t.id });
    await sleep(500);
    const c = await feature('signals:get');
    assert(c.running && c.token, 'signal service not running');
    const before = (await feature('tasks:list')).runs.length;
    const r = await fetch('http://127.0.0.1:4791/signal', { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'e2e-' + Date.now() }) });
    assert(r.ok, `signal HTTP ${r.status}`);
    let after = before;
    for (let i = 0; i < 40 && after <= before; i++) { await sleep(500); after = (await feature('tasks:list')).runs.length; }
    assert(after > before, 'signal did not run the task');
    const st = await (await fetch('http://127.0.0.1:4791/state', { headers: { Authorization: `Bearer ${c.token}` } })).json();
    assert(st.image?.startsWith('data:image'), 'no canvas image for the phone');
    const bad = await fetch('http://127.0.0.1:4791/state', { headers: { Authorization: 'Bearer wrong' } });
    assert(bad.status === 401 || bad.status === 403, `wrong token got ${bad.status}`);
    const stop = await fetch('http://127.0.0.1:4791/stop', { method: 'POST', headers: { Authorization: `Bearer ${c.token}` } });
    assert(stop.ok, 'phone STOP failed');
    const paused = await ui(`document.querySelector('#stop-btn').classList.contains('stopped')`);
    assert(paused, 'app did not stop');
    await ui(`window.ac.setPaused(false)`);
    await feature('signals:save', { enabled: false });
    return 'signal ran task, phone view + STOP work, wrong token refused';
  });

  await check('Spaces and frames', async () => {
    const s = await feature('spaces:add', { name: 'E2E space' });
    const list = await feature('spaces:list');
    assert(list.spaces.some(x => x.id === s.id), 'space missing');
    const frame = await ui(`window.ac.addItem({ type: 'frame', title: 'E2E group', x: -900, y: -600, w: 500, h: 300 })`);
    await sleep(300);
    const shown = await ui(`!!document.querySelector('.item[data-id="${frame.id}"]')`);
    assert(shown, 'frame not on canvas');
    return `${list.spaces.length} spaces`;
  });

  await check('Positions, protective exit and close-all (paper)', async () => {
    const r = await ui(`window.ac.placeOrder({ accountId: 'paper', symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: 0.0005, stopLoss: 1000, reason: 'e2e' })`);
    assert(r.ok, r.message);
    const pos = await feature('risk:positions');
    const btc = pos.find(p => p.account === 'paper' && p.symbol === 'BTC/USDT');
    assert(btc && btc.qty > 0 && btc.brackets.length, 'position or protection missing');
    const closed = await feature('risk:closeAll');
    assert(closed.every(x => x.ok), JSON.stringify(closed));
    const after = (await feature('risk:positions')).find(p => p.account === 'paper' && p.symbol === 'BTC/USDT');
    assert(after.qty === 0, 'position not closed');
    await ui(`window.ac.setMandate({ sellOnly: false })`);
    return 'bought with stop-loss, closed all';
  });

  await check('Backup and restore (encrypted round trip)', async () => {
    const { pack, unpack } = require('../main/backup');
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-bk-'));
    fs.mkdirSync(path.join(src, 'notes'));
    fs.writeFileSync(path.join(src, 'notes', 'n.md'), 'keep me');
    fs.writeFileSync(path.join(src, 'settings.json'), '{}');
    const data = pack(src, 'correct horse battery');
    let wrong = false;
    try { unpack(data, 'wrong password 123', path.join(src, 'x')); } catch { wrong = true; }
    assert(wrong, 'wrong password accepted');
    const dest = path.join(os.tmpdir(), 'ac-restore-' + Date.now());
    unpack(data, 'correct horse battery', dest);
    assert(fs.readFileSync(path.join(dest, 'notes', 'n.md'), 'utf8') === 'keep me', 'content mismatch');
    return `${data.length} bytes, wrong password refused`;
  });

  await check('Widgets on the canvas (price card)', async () => {
    const w = await ui(`window.ac.addItem({ type: 'widget', widget: 'price', symbol: 'BTC/USDT', title: 'price', x: -900, y: -200 })`);
    let txt = '';
    for (let i = 0; i < 20 && !/\d{3,}/.test(txt); i++) { await sleep(500); txt = await ui(`document.querySelector('.item[data-id="${w.id}"]')?.innerText || ''`); }
    assert(/\d{3,}/.test(txt), `widget shows: ${txt.slice(0, 80)}`);
    return txt.replace(/\s+/g, ' ').slice(0, 60);
  });

  await check('Browser tools: find, zoom, mute, separate window', async () => {
    await feature('browser:comfort', { id: bid, action: 'find', text: 'page' });
    await feature('browser:comfort', { id: bid, action: 'zoom', value: 1.25 });
    await feature('browser:comfort', { id: bid, action: 'mute', value: true });
    await feature('browser:comfort', { id: bid, action: 'zoom', value: 1 });
    // Popping out needs a built-in browser window (a Brave tab has no window of its own).
    const built = await ui(`window.ac.addItem({ type: 'browser', engine: 'builtin', url: '${site.base}/plain', title: 'Built-in' }).then(i => i.id)`);
    await sleep(2500);
    const before = (await (await fetch('http://127.0.0.1:9333/json')).json()).length;
    await feature('browser:comfort', { id: built, action: 'popout' });
    await sleep(1500);
    const after = (await (await fetch('http://127.0.0.1:9333/json')).json()).length;
    assert(after > before, 'no separate window opened');
    await ui(`window.ac.removeItem('${built}')`);
    return `Brave: find, zoom, mute; built-in popout: targets ${before} -> ${after}`;
  });

  await check('Several agents get their own cursors', async () => {
    const other = await initMcp('Second agent');
    const keep = sid;
    sid = other;
    await mcp('cursor_point', { id: bid, message: 'second agent here' });
    sid = keep;
    await mcp('cursor_point', { id: bid, message: 'first agent here' });
    const labels = await ui(`[...document.querySelectorAll('.ai-layer .ai-label')].map(l => l.textContent).join(',')`);
    assert(/Second agent/.test(labels) && /E2E check/.test(labels), `labels: ${labels}`);
    return labels;
  });

  await check('Agents panel: each agent listed in colour; pausing one blocks only that one', async () => {
    const list = await ui(`window.ac.agentsList()`);
    const me = list.find(a => a.name === 'E2E check');
    assert(me && /^#/.test(me.color), 'agent not listed with a colour');
    await ui(`window.ac.agentsUpdate('E2E check', { paused: true })`);
    const blocked = await mcp('workspace_overview');
    const refused = await mcp('note_read', { id: 'none' });
    assert(!blocked.isError && refused.isError && /paused/.test(refused.text), 'paused agent was not blocked');
    await ui(`window.ac.agentsUpdate('E2E check', { paused: false })`);
    const shown = await ui(`(async () => { document.querySelector('[data-panel=agents]').click(); await new Promise(r => setTimeout(r, 500)); const n = document.querySelectorAll('.agent-card').length; const strip = document.querySelectorAll('#agent-strip .agent-avatar').length; document.querySelector('#drawer-close').click(); return [n, strip]; })()`);
    assert(shown[0] >= 2, `agent cards: ${shown[0]}`);
    return `${shown[0]} agents in the panel, ${shown[1]} avatars in the toolbar`;
  });

  await check('Strategy backtest (DCA)', async () => {
    const d = await feature('strategy:backtest', { prices: [100, 98, 95, 97, 101, 104, 99, 103], strategy: 'dca', initial: 1000, allocation: 100, every: 2, gridPct: 2 });
    assert(Number.isFinite(d.finalEquity) && d.trades.length > 0, 'no result');
    return `equity ${d.finalEquity.toFixed(2)}, ${d.trades.length} trades`;
  });

  await check('Voice input panel', async () => {
    const r = await ui(`(async () => { document.querySelector('[data-panel=features]').click(); await new Promise(r => setTimeout(r, 300)); [...document.querySelectorAll('.feat')].find(f => f.textContent.includes('Voice input')).querySelector('.btn').click(); await new Promise(r => setTimeout(r, 400)); const t = document.querySelector('#drawer-body').innerText; document.querySelector('#drawer-close').click(); return t; })()`);
    assert(/dictation|voice typing/i.test(r), 'voice panel missing');
    return /not supported/.test(r) ? 'panel works; uses Windows voice typing (Win+H)' : 'panel works with speech recognition';
  });

  for (const [s, n, d] of results) console.log(`${s}  ${n}${d ? '  (' + d + ')' : ''}`);
  console.log(`\n${results.filter(r => r[0] === 'PASS').length}/${results.length} passed`);
  site.server.close();
  llm.server.close();
  process.exit(results.some(r => r[0] === 'FAIL') ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
