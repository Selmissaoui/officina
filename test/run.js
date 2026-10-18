// Offline unit tests for the main-process logic (no Electron, no network).
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-test-'));
  const ws = new Workspace(root);
  ws.init();
  const activity = new Activity(root);
  const keys = new KeyStore(ws.dirs.secrets, fakeSafe);
  const trading = new Trading({ ws, keys, activity });
  // Deterministic offline prices.
  const prices = { 'BTC/USDT': 50000, 'ETH/USDT': 2000, 'ETH/BTC': 0.04 };
  trading.paper.fetchTicker = async s => { if (!prices[s]) throw new Error('unknown ' + s); return { last: prices[s], bid: prices[s], ask: prices[s] }; };
  return { root, ws, activity, keys, trading, prices };
}

test('workspace keeps every file path inside the container', () => {
  const { ws } = setup();
  assert.throws(() => ws.safePath('../outside.txt'), /outside the workspace/);
  assert.throws(() => ws.safePath('a/../../x'), /outside the workspace/);
  assert.throws(() => ws.safePath('C:/Windows/win.ini'), /outside the workspace/);
  const rel = ws.writeFile('research/a.md', 'hi', 'agent');
  assert.equal(rel, 'research/a.md');
  assert.equal(ws.readFile('research/a.md').toString(), 'hi');
  assert.equal(ws.library({ createdBy: 'agent' }).filter(e => e.path === 'research/a.md').length, 1);
});

test('workspace blocks links and junctions for reads, writes and discovery', () => {
  const { ws, root, trading } = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'private');
    fs.symlinkSync(outside, path.join(ws.dirs.files, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => ws.readFile('linked/secret.txt'), /outside the workspace/);
    assert.throws(() => ws.writeFile('linked/new/note.txt', 'escaped'), /outside the workspace/);
    assert.throws(() => ws.listDir('linked'), /outside the workspace/);
    assert.throws(() => ws.walkFiles(path.join(ws.dirs.files, 'linked')), /outside the workspace/);
    assert.deepEqual(ws.listDir(), []);
    assert.deepEqual(ws.walkFiles(), []);
    assert.equal(ws.library({ q: 'private' }).length, 0);
    assert.equal(fs.existsSync(path.join(outside, 'new')), false);
    assert.equal(ws.writeFile('normal/nested.txt', 'ok'), 'normal/nested.txt');
  } finally {
    trading.dispose();
    clearTimeout(ws._saveTimer);
    fs.unlinkSync(path.join(ws.dirs.files, 'linked'));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('closing items keeps notes and browser profiles', () => {
  const { ws } = setup();
  const note = ws.addItem({ type: 'note', title: 'Idea', content: 'buy low' }, 'agent');
  const br = ws.addItem({ type: 'browser', url: 'https://x.com', title: 'X' });
  ws.removeItem(note.id);
  ws.removeItem(br.id);
  const lib = ws.library({});
  assert.ok(lib.find(e => e.kind === 'note' && e.id === note.id && e.snippet === 'buy low'));
  assert.ok(lib.find(e => e.kind === 'browser' && e.profile === br.profile && !e.itemId));
  assert.ok(ws.profiles().includes(br.profile));
  const reopened = ws.addItem({ type: 'browser', profile: br.profile, url: 'https://x.com' });
  assert.equal(reopened.profile, br.profile);
  assert.equal(ws.state.closedBrowsers.length, 0);
});

test('new items are placed without overlapping', () => {
  const { ws } = setup();
  const a = ws.addItem({ type: 'browser', url: 'https://a.com' });
  const b = ws.addItem({ type: 'browser', url: 'https://b.com' });
  const c = ws.addItem({ type: 'note', title: 'n', hint: { x: a.x, y: a.y } });
  const overlap = (p, q) => !(p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y);
  assert.ok(!overlap(a, b));
  assert.ok(!overlap(a, c) && !overlap(b, c));
});

test('key store never exposes secrets in list()', () => {
  const { keys } = setup();
  const e = keys.upsert({ kind: 'exchange', exchange: 'binance', label: 'B', apiKey: 'AAAA1234', secret: 'SSSS5678', linkedBrowsers: ['p1'] });
  const listed = JSON.stringify(keys.list());
  assert.ok(!listed.includes('AAAA1234') && !listed.includes('SSSS5678'));
  assert.ok(listed.includes('••••1234'));
  // blank secret on edit keeps the stored value
  keys.upsert({ id: e.id, secret: '' });
  assert.equal(keys.get(e.id).secret, 'SSSS5678');
  assert.equal(keys.linkedTo('p1')[0].id, e.id);
  // persisted encrypted
  const raw = fs.readFileSync(keys.file).toString();
  assert.ok(raw.startsWith('ENC:') && !raw.includes('SSSS5678'));
});

test('agent orders need the one-time approval, then run automatically within limits', async () => {
  const { trading } = setup();
  await assert.rejects(trading.placeOrder({ accountId: 'paper', symbol: 'BTC/USDT', side: 'buy', type: 'limit', amount: 0.001, price: 50000, actor: 'agent' }), /not approved/);
  assert.throws(() => trading.setMandate({ enabled: true }, 'agent'), /Only the user/);
  trading.setMandate({ enabled: true, maxOrderUsd: 100, maxDailyUsd: 150, maxOrdersPerDay: 3, accounts: ['paper'] }, 'user');

  const ok = await trading.placeOrder({ accountId: 'paper', symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: 0.001, actor: 'agent' });
  assert.equal(ok.status, 'filled');
  assert.equal(ok.notionalUsd, 50);

  await assert.rejects(trading.placeOrder({ accountId: 'paper', symbol: 'BTC/USDT', side: 'buy', amount: 0.003, actor: 'agent' }), /above the approved max/);
  await trading.placeOrder({ accountId: 'paper', symbol: 'ETH/USDT', side: 'buy', amount: 0.04, actor: 'agent' }); // $80, total $130
  await assert.rejects(trading.placeOrder({ accountId: 'paper', symbol: 'ETH/USDT', side: 'buy', amount: 0.02, actor: 'agent' }), /Daily limit/); // +$40 > $150

  // non-stable quote is valued in USD through the quote's own price
  trading.setMandate({ maxDailyUsd: 10000 }, 'user');
  const cross = await trading.placeOrder({ accountId: 'paper', symbol: 'ETH/BTC', side: 'sell', amount: 0.04, actor: 'agent' });
  assert.equal(Math.round(cross.notionalUsd), 80);

  // the user's own manual orders are not limited by the agent mandate
  const manual = await trading.placeOrder({ accountId: 'paper', symbol: 'BTC/USDT', side: 'buy', amount: 0.01, actor: 'user' });
  assert.equal(manual.status, 'filled');

  // order count limit (3 agent orders already went through)
  await assert.rejects(trading.placeOrder({ accountId: 'paper', symbol: 'ETH/USDT', side: 'buy', amount: 0.001, actor: 'agent' }), /order count/);
  trading.dispose();
});

test('symbol whitelist, account scope, expiry and STOP are enforced', async () => {
  const { trading, keys } = setup();
  const k = keys.upsert({ kind: 'exchange', exchange: 'binance', label: 'Live', apiKey: 'k', secret: 's' });
  trading.setMandate({ enabled: true, allowedSymbols: 'BTC/USDT', accounts: ['paper'] }, 'user');
  await assert.rejects(trading.placeOrder({ accountId: 'paper', symbol: 'ETH/USDT', side: 'buy', amount: 0.001, actor: 'agent' }), /not in the approved symbols/);
  await assert.rejects(trading.placeOrder({ accountId: k.id, symbol: 'BTC/USDT', side: 'buy', amount: 0.001, actor: 'agent' }), /not included/);
  trading.setHalted(true);
  await assert.rejects(trading.placeOrder({ accountId: 'paper', symbol: 'BTC/USDT', side: 'buy', amount: 0.001, actor: 'agent' }), /STOP/);
  trading.setHalted(false);
  trading.setMandate({ expiresAt: new Date(Date.now() - 1000).toISOString() }, 'user');
  await assert.rejects(trading.placeOrder({ accountId: 'paper', symbol: 'BTC/USDT', side: 'buy', amount: 0.001, actor: 'agent' }), /expired/);
  const log = trading.history(10);
  assert.ok(log.every(r => r.status === 'rejected'));
  trading.dispose();
});

test('paper limit orders reserve funds and fill when price crosses', async () => {
  const { trading, prices } = setup();
  trading.paper.reset(1000);
  await trading.paper.createOrder('BTC/USDT', 'limit', 'buy', 0.01, 40000); // $400 reserved
  let bal = await trading.paper.fetchBalance();
  assert.ok(Math.abs(bal.free.USDT - (1000 - 400.4)) < 1e-6);
  await assert.rejects(trading.paper.createOrder('BTC/USDT', 'limit', 'buy', 0.02, 40000), /Insufficient free/);
  prices['BTC/USDT'] = 39000;
  const fills = await trading.paper.matchOpenOrders();
  assert.equal(fills.length, 1);
  bal = await trading.paper.fetchBalance();
  assert.equal(bal.total.BTC, 0.01);
  trading.dispose();
});

test('MCP: initialize, tools/list, auth and paused handling', async () => {
  const { ws, keys, trading, activity } = setup();
  let paused = false;
  const mcp = new McpServer({ ws, keys, trading, activity, browsers: { wcByItem: new Map() }, isPaused: () => paused, getToken: () => 'secret-token', touch() {}, focusItem() {}, fileChanged() {} });
  const port = await mcp.start(0);
  const call = (body, token = 'secret-token', headers = {}) => fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });

  assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong')).status, 401);
  assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'secret-token', { Origin: 'https://evil.example' })).status, 403);

  const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.ok(init.headers.get('mcp-session-id'));
  assert.equal((await init.json()).result.protocolVersion, '2025-06-18');
  assert.equal((await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

  const list = await (await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  const names = list.result.tools.map(t => t.name);
  for (const n of ['browser_read', 'browser_click', 'note_create', 'file_write', 'library_search', 'trading_place_order', 'keys_list']) assert.ok(names.includes(n), n);

  const note = await (await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'note_create', arguments: { title: 'T', content: 'C' } } })).json();
  const noteId = JSON.parse(note.result.content[0].text).id;
  assert.equal(ws.readNote(noteId), 'C');

  const esc = await (await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'file_write', arguments: { path: '../../evil.txt', content: 'x' } } })).json();
  assert.equal(esc.result.isError, true);

  keys.upsert({ kind: 'exchange', exchange: 'binance', label: 'B', apiKey: 'k', secret: 'TOPSECRET' });
  const kl = await (await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'keys_list', arguments: {} } })).json();
  assert.ok(!kl.result.content[0].text.includes('TOPSECRET'));

  paused = true;
  const p = await (await call({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'note_create', arguments: { title: 'x', content: 'y' } } })).json();
  assert.equal(p.result.isError, true);
  assert.match(p.result.content[0].text, /STOP/);

  await mcp.stop();
  trading.dispose();
});

test('reset wipes content; stats count notes, files and trades', async () => {
  const { ws, trading, activity } = setup();
  const { localDay } = require('../main/activity');
  ws.addItem({ type: 'note', title: 'a', content: 'x' });
  ws.writeFile('r.md', 'y', 'agent');
  trading.setMandate({ enabled: true, accounts: ['paper'] }, 'user');
  await trading.placeOrder({ accountId: 'paper', symbol: 'BTC/USDT', side: 'buy', amount: 0.001, actor: 'agent' });
  activity.log('agent', 'browser_read', '{}');
  let s = ws.stats(localDay);
  assert.equal(s.notes, 1); assert.equal(s.notesToday, 1); assert.equal(s.files, 1); assert.equal(s.trades, 1);
  assert.equal(activity.count(k => k === 'agent:browser_read').today, 1);
  ws.reset();
  activity.clear();
  s = ws.stats(localDay);
  assert.equal(s.notes + s.files + s.trades, 0);
  assert.equal(ws.listItems().length, 0);
  assert.equal(fs.readdirSync(ws.dirs.notes).length, 0);
  assert.equal(activity.count(() => true).total, 0);
  trading.dispose();
});

test('AI cursor: animates when visible, costs no time when hidden, point always shows', () => {
  const { ws } = setup();
  const { AiCursor } = require('../main/cursor');
  const sent = [];
  const cur = new AiCursor({ ws, send: (ch, e) => sent.push(e) });
  const it = ws.addItem({ type: 'browser', url: 'https://a.com', x: 100, y: 200 });
  const w = cur.pageToWorld(it.id, 10, 20);
  assert.deepEqual(w, { x: 111, y: 259 }); // 1px border, 39px header
  assert.ok(cur.move(w, { caption: 'Click' }) > 0);
  assert.equal(sent.at(-1).kind, 'move');
  ws.settings.ui = { cursor: { show: false } };
  const before = sent.length;
  assert.equal(cur.move({ x: 500, y: 500 }), 0);
  assert.equal(cur.event('click'), 0);
  assert.equal(sent.length, before); // nothing animated
  cur.event('point', { message: 'look here' });
  assert.equal(sent.at(-1).kind, 'point');
  ws.settings.ui = { cursor: { show: true, speed: 'slow' } };
  const slow = cur.move({ x: 900, y: 900 });
  ws.settings.ui = { cursor: { show: true, speed: 'fast' } };
  const fast = cur.move({ x: 500, y: 500 });
  assert.ok(slow > fast);
});

test('built-in assistant runs tool loops on Ollama and OpenAI-compatible runners', async () => {
  const { ws, keys, trading, activity } = setup();
  const { LocalAgent, parseTextToolCalls, splitThinking } = require('../main/localagent');
  const { startMockLlm } = require('./mock-llm');
  const mock = await startMockLlm();
  const mcp = new McpServer({ ws, keys, trading, activity, browsers: { wcByItem: new Map() }, cursor: null, isPaused: () => false, getToken: () => 't', touch() {}, focusItem() {}, fileChanged() {} });
  const agent = new LocalAgent({ ws, mcp, isPaused: () => false, safeStorage: fakeSafe });
  const events = [];
  agent.on('event', e => events.push(e));

  // discovery
  agent.setConfig({ runner: 'ollama', baseUrl: `http://127.0.0.1:${mock.port}` });
  assert.deepEqual((await agent.listModels('ollama', `http://127.0.0.1:${mock.port}`)).map(m => m.id), ['mock:7b']);
  assert.equal((await agent.modelInfo('ollama', `http://127.0.0.1:${mock.port}`, 'notools:1b')).tools, false);

  // Ollama native loop: tool call -> note created -> final answer
  agent.setConfig({ model: 'mock:7b' });
  await agent.send('write a note');
  const ollamaNote = ws.listItems().find(i => i.type === 'note' && i.title === 'Mock idea');
  assert.ok(ollamaNote, 'note created via Ollama tool call');
  assert.equal(ws.readNote(ollamaNote.id), 'BTC long above 83k');
  assert.ok(events.find(e => e.type === 'thinking'));
  assert.equal(agent.log.at(-1).text, 'Done. I wrote the note.');
  const ollamaReq = mock.received.filter(r => r.url === '/api/chat');
  assert.equal(ollamaReq[0].body.messages[0].role, 'system');
  assert.ok(ollamaReq[0].body.tools.some(t => t.function.name === 'note_create'));
  assert.equal(ollamaReq[0].body.options.num_ctx, 16384);
  assert.equal(ollamaReq[1].body.messages.at(-1).role, 'tool');

  // OpenAI-compatible loop with structured tool calls (LM Studio, llama.cpp, vLLM, ...)
  agent.reset();
  agent.setConfig({ runner: 'lmstudio', baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'mock-oa' });
  await agent.send('another');
  assert.ok(ws.listItems().find(i => i.type === 'note' && i.title === 'OA idea'));
  const oaReq = mock.received.filter(r => r.url === '/v1/chat/completions');
  assert.equal(oaReq[1].body.messages.at(-1).tool_call_id, 'call_1');
  assert.equal(oaReq[1].body.messages.at(-2).tool_calls[0].function.name, 'note_create');
  assert.equal(agent.log.at(-1).text, 'All done.'); // <think> stripped

  // Models that write tool calls as text
  agent.reset();
  agent.setConfig({ model: 'mock-text' });
  await agent.send('text style');
  assert.ok(ws.listItems().find(i => i.type === 'note' && i.title === 'Text call'));

  // Friendly errors
  agent.reset();
  agent.setConfig({ runner: 'ollama', baseUrl: `http://127.0.0.1:${mock.port}`, model: 'missing:1b' });
  await agent.send('x');
  assert.match(agent.log.at(-1).text, /ollama pull missing:1b/);
  agent.setConfig({ baseUrl: 'http://127.0.0.1:1', model: 'mock:7b' });
  await agent.send('x');
  assert.match(agent.log.at(-1).text, /Is it running/);

  // parsing helpers
  assert.equal(parseTextToolCalls('```json\n{"name":"browser_read","arguments":{"id":"b1"}}\n```')[0].name, 'browser_read');
  assert.deepEqual(splitThinking('<think>a</think>hello'), { thinking: 'a', text: 'hello' });
  mock.server.close();
  trading.dispose();
});


test('futures need explicit permission and respect the leverage cap', async () => {
  const { trading } = setup();
  trading.setMandate({ enabled: true, accounts: ['paper'] }, 'user');
  await assert.rejects(trading.placeOrder({ accountId: 'paper', symbol: 'BTC/USDT:USDT', side: 'buy', amount: 0.001, leverage: 3, actor: 'agent' }), /practice account supports spot/);
  // On a non-paper account the mandate is checked before any exchange call.
  const fake = 'kx';
  trading.accountLabel = id => id;
  await assert.rejects(trading.placeOrder({ accountId: fake, symbol: 'BTC/USDT:USDT', side: 'buy', amount: 0.001, leverage: 3, actor: 'agent' }), /Futures are not allowed/);
  trading.setMandate({ allowFutures: true, maxLeverage: 2 }, 'user');
  await assert.rejects(trading.placeOrder({ accountId: fake, symbol: 'BTC/USDT:USDT', side: 'buy', amount: 0.001, leverage: 5, actor: 'agent' }), /above your limit of 2x/);
  assert.throws(() => trading.setMandate({ maxLeverage: 500 }, 'user'), /between 1 and 125/);
  assert.match(trading.describeMandate(), /futures allowed up to 2x/);
  const log = trading.history(10);
  assert.ok(log.filter(r => r.symbol === 'BTC/USDT:USDT').every(r => r.status === 'rejected'));
  trading.dispose();
});

test('each agent gets its own cursor position and label', () => {
  const { ws } = setup();
  const { AiCursor, agentStore } = require('../main/cursor');
  const sent = [];
  const cur = new AiCursor({ ws, send: (ch, e) => sent.push(e) });
  agentStore.run({ id: 's1', label: 'Research' }, () => cur.move({ x: 10, y: 10 }));
  agentStore.run({ id: 's2', label: 'Trader' }, () => cur.move({ x: 500, y: 500 }));
  agentStore.run({ id: 's1', label: 'Research' }, () => cur.move({ x: 20, y: 20 }));
  assert.deepEqual(sent[2].from, { x: 10, y: 10 }); // s1 continues from its own spot, not from s2's
  assert.equal(sent[1].agent.label, 'Trader');
  assert.equal(sent[2].agent.id, 's1');
});


test('protection works on a live spot account: fills are confirmed, limit buys arm on fill, exits sell', async () => {
  const { ws, keys, trading } = setup();
  const { Risk } = require('../main/risk');
  const notes = [];
  const risk = trading.risk = new Risk({ ws, trading, notify: (...a) => notes.push(a) });
  const k = keys.upsert({ kind: 'exchange', exchange: 'binance', label: 'Live', apiKey: 'k', secret: 's' });
  let price = 100;
  const orders = new Map();
  let n = 0;
  const fakeEx = {
    has: { fetchOrder: true },
    fetchTicker: async () => ({ last: price, bid: price, ask: price }),
    amountToPrecision: (s, a) => a,
    priceToPrecision: (s, p) => p,
    // Like many exchanges: the create call answers "open", the fill shows up on fetchOrder.
    createOrder: async (symbol, type, side, amount, px) => {
      const id = 'o' + (++n);
      orders.set(id, { id, symbol, type, side, amount, price: px, fillAt: type === 'market' ? 'now' : 'later' });
      return { id, status: 'open', filled: 0 };
    },
    fetchOrder: async id => {
      const o = orders.get(id);
      if (o.fillAt === 'now') return { id, status: 'closed', filled: o.amount, average: price };
      return { id, status: 'open', filled: 0 };
    },
  };
  trading.instances.set(k.id, { ex: fakeEx, updatedAt: keys.get(k.id).updatedAt });

  // Market buy with protection: confirmed fill, bracket armed with the real numbers.
  const r = await trading.placeOrder({ accountId: k.id, symbol: 'ETH/USDT', side: 'buy', type: 'market', amount: 2, stopLoss: 90, takeProfit: 130, actor: 'user' });
  assert.equal(r.status, 'filled');
  assert.equal(r.amount, 2);
  assert.equal(r.protection.waitingForFill, false);
  assert.equal(risk.positions().find(p => p.symbol === 'ETH/USDT').qty, 2);

  // Limit buy below the market: protection waits, then arms when the order fills.
  const lim = await trading.placeOrder({ accountId: k.id, symbol: 'SOL/USDT', side: 'buy', type: 'limit', amount: 5, price: 95, stopLoss: 80, actor: 'user' });
  assert.equal(lim.protection.waitingForFill, true);
  assert.ok(risk.brackets.find(b => b.symbol === 'SOL/USDT' && b.pending));
  orders.get(lim.orderId).fillAt = 'now';
  await risk.check();
  const armed = risk.brackets.find(b => b.symbol === 'SOL/USDT');
  assert.equal(armed.pending, false);
  assert.equal(armed.active, true);
  assert.equal(risk.positions().find(p => p.symbol === 'SOL/USDT').qty, 5);
  assert.ok(notes.some(x => x[1] === 'Protection armed'));

  // Price falls through both stops: the app sells, and the positions close.
  price = 79;
  await risk.check();
  assert.equal(risk.positions().find(p => p.symbol === 'ETH/USDT').qty, 0);
  assert.equal(risk.positions().find(p => p.symbol === 'SOL/USDT').qty, 0);
  assert.ok(notes.some(x => /stop-loss triggered/.test(x[1])));

  risk.dispose();
  trading.dispose();
});


test('exits are also placed on the exchange (survive the app closing), incl. futures with reduce-only', async () => {
  const { ws, keys, trading } = setup();
  const { Risk } = require('../main/risk');
  const risk = trading.risk = new Risk({ ws, trading, notify: () => {} });
  const k = keys.upsert({ kind: 'exchange', exchange: 'bybit', label: 'Live', apiKey: 'k', secret: 's' });
  let price = 100, n = 0;
  const orders = new Map(), canceled = [], stopCalls = [];
  const fakeEx = {
    has: { fetchOrder: true, createStopLossOrder: true, createTakeProfitOrder: true },
    fetchTicker: async () => ({ last: price, bid: price, ask: price }),
    amountToPrecision: (s, a) => a, priceToPrecision: (s, p) => p,
    setLeverage: async () => {},
    createOrder: async (symbol, type, side, amount) => { const id = 'o' + (++n); orders.set(id, { status: 'closed', filled: amount, average: price }); return { id, status: 'open', filled: 0 }; },
    createStopLossOrder: async (symbol, type, side, amount, p, trigger, params) => { const id = 's' + (++n); stopCalls.push({ symbol, trigger, params }); orders.set(id, { status: 'open', filled: 0 }); return { id }; },
    createTakeProfitOrder: async (symbol, type, side, amount, p, trigger, params) => { const id = 't' + (++n); stopCalls.push({ symbol, trigger, params }); orders.set(id, { status: 'open', filled: 0 }); return { id }; },
    fetchOrder: async id => ({ id, ...orders.get(id) }),
    cancelOrder: async id => { canceled.push(id); orders.set(id, { status: 'canceled', filled: 0 }); return { id }; },
  };
  trading.instances.set(k.id, { ex: fakeEx, updatedAt: keys.get(k.id).updatedAt });

  const r = await trading.placeOrder({ accountId: k.id, symbol: 'ETH/USDT', side: 'buy', amount: 1, stopLoss: 90, takeProfit: 120, actor: 'user' });
  assert.equal(r.protection.onExchange, true);
  const b = risk.brackets.find(x => x.symbol === 'ETH/USDT');
  assert.ok(b.native.stop && b.native.take);

  // The exchange's own stop fills (e.g. while the app was closed): recorded, the other exit cancelled.
  orders.set(b.native.stop, { status: 'closed', filled: 1, average: 89.5 });
  await risk.check();
  assert.equal(b.active, false);
  assert.ok(canceled.includes(b.native.take));
  assert.equal(risk.positions().find(p => p.symbol === 'ETH/USDT').qty, 0);

  // Futures long: allowed, exits are reduce-only.
  trading.setMandate({ allowFutures: true, maxLeverage: 3 }, 'user');
  const f = await trading.placeOrder({ accountId: k.id, symbol: 'BTC/USDT:USDT', side: 'buy', amount: 0.01, stopLoss: 90, leverage: 2, actor: 'user' });
  assert.equal(f.protection.onExchange, true);
  assert.deepEqual(stopCalls.at(-1).params, { reduceOnly: true });
  risk.dispose();
  trading.dispose();
});


test('agents: per-agent pause and trading permission, colours, status', async () => {
  const { ws, keys, trading, activity } = setup();
  const { Agents } = require('../main/agents');
  const { agentStore } = require('../main/cursor');
  const agents = new Agents(ws);
  const mcp = new McpServer({ ws, keys, trading, activity, agents, browsers: { wcByItem: new Map() }, isPaused: () => false, getToken: () => 't', touch() {}, focusItem() {}, fileChanged() {} });
  const as = (name, fn) => agentStore.run({ id: name, label: name }, fn);

  const ok = await as('Research', () => mcp.callTool('note_create', { title: 'r', content: 'x' }));
  assert.ok(!ok.isError);
  const list = agents.list();
  const r = list.find(a => a.name === 'Research');
  assert.equal(r.status, 'working');
  assert.equal(r.actions, 1);
  assert.ok(/^#[0-9a-f]{6}$/i.test(r.color));
  assert.notEqual(r.color, agents.colorFor('Trader'));
  assert.ok(list.find(a => a.name === 'Assistant' && a.builtIn));
  assert.equal(activity.list().at(-1).agent, 'Research');

  agents.update('Research', { paused: true });
  const paused = await as('Research', () => mcp.callTool('note_create', { title: 'r2', content: 'x' }));
  assert.ok(paused.isError && /paused/.test(paused.content[0].text));
  const other = await as('Trader', () => mcp.callTool('note_create', { title: 't', content: 'x' }));
  assert.ok(!other.isError, 'pausing one agent must not stop the others');

  agents.update('Trader', { canTrade: false });
  trading.setMandate({ enabled: true, accounts: ['paper'] }, 'user');
  const order = await as('Trader', () => mcp.callTool('trading_place_order', { account: 'paper', symbol: 'BTC/USDT', side: 'buy', amount: 0.001, reason: 'x' }));
  assert.ok(order.isError && /not allowed to trade/.test(order.content[0].text));
  assert.throws(() => agents.forget('Assistant'));
  agents.forget('Trader');
  assert.ok(!agents.list().some(a => a.name === 'Trader'));
  trading.dispose();
});


// ---------- review findings (Astra, 2026-10-11) ----------
function liveFake(trading, keys, exchange, prices) {
  const k = keys.upsert({ kind: 'exchange', exchange, label: 'Live', apiKey: 'k', secret: 's' });
  const orders = new Map(); let n = 0;
  const ex = {
    has: { fetchOrder: true },
    fetchTicker: async s => { if (!(s in prices)) throw new Error('no ' + s); return { last: prices[s], bid: prices[s], ask: prices[s] }; },
    amountToPrecision: (s, a) => a, priceToPrecision: (s, p) => p, setLeverage: async () => {},
    createOrder: async (symbol, type, side, amount, price) => { const id = 'o' + (++n); const o = { id, symbol, side, type, amount, price, status: type === 'market' ? 'closed' : 'open', filled: type === 'market' ? amount : 0, average: prices[symbol] }; orders.set(id, o); return { ...o }; },
    fetchOrder: async id => ({ ...orders.get(id) }),
    fetchOpenOrders: async () => [...orders.values()].filter(o => o.status === 'open').map(o => ({ ...o })),
    cancelOrder: async id => { orders.get(id).status = 'canceled'; return { id }; },
  };
  trading.instances.set(k.id, { ex, updatedAt: keys.get(k.id).updatedAt });
  return { k, orders, prices };
}
function withRisk(trading, ws) {
  const { Risk } = require('../main/risk');
  return (trading.risk = new Risk({ ws, trading, notify: () => {} }));
}

test('futures shorts respect sell-only, required stop-loss, and are tracked and closed', async () => {
  const { ws, keys, trading } = setup();
  const risk = withRisk(trading, ws);
  const f = liveFake(trading, keys, 'bybit', { 'BTC/USDT:USDT': 100 });
  const short = () => trading.placeOrder({ accountId: f.k.id, symbol: 'BTC/USDT:USDT', side: 'sell', amount: 1, leverage: 2, actor: 'agent', reason: 'x' });
  trading.setMandate({ enabled: true, accounts: [f.k.id], allowFutures: true, maxLeverage: 3, maxOrderUsd: 1000, maxDailyUsd: 10000, sellOnly: true }, 'user');
  await assert.rejects(short(), /not open shorts/);
  trading.setMandate({ sellOnly: false, requireStopLoss: true }, 'user');
  await assert.rejects(short(), /may not open shorts/);
  trading.setMandate({ requireStopLoss: false }, 'user');
  const r = await short();
  assert.equal(r.status, 'filled');
  assert.equal(risk.held(f.k.id, 'BTC/USDT:USDT'), -1); // tracked as a short
  f.prices['BTC/USDT:USDT'] = 110;
  const loss = await risk.todayPnl([f.k.id]);
  assert.equal(Math.round(loss), -10); // short loses when price rises
  const closed = await risk.closeAll();
  assert.ok(closed.some(x => x.action === 'covered short' && x.ok));
  assert.equal(risk.held(f.k.id, 'BTC/USDT:USDT'), 0);
  risk.dispose(); trading.dispose();
});

test('partial fills are tracked: cancelled after partial fill, and open orders filling later', async () => {
  const { ws, keys, trading } = setup();
  const risk = withRisk(trading, ws);
  const f = liveFake(trading, keys, 'binance', { 'ETH/USDT': 100 });
  const a = await trading.placeOrder({ accountId: f.k.id, symbol: 'ETH/USDT', side: 'buy', type: 'limit', amount: 2, price: 99, actor: 'user' });
  Object.assign(f.orders.get(a.orderId), { filled: 0.5, average: 99, status: 'canceled' });
  await risk.check();
  assert.equal(risk.held(f.k.id, 'ETH/USDT'), 0.5);
  const b = await trading.placeOrder({ accountId: f.k.id, symbol: 'ETH/USDT', side: 'buy', type: 'limit', amount: 1, price: 98, actor: 'user' });
  Object.assign(f.orders.get(b.orderId), { filled: 0.4, average: 98 });
  await risk.check();
  assert.equal(risk.held(f.k.id, 'ETH/USDT'), 0.9);
  Object.assign(f.orders.get(b.orderId), { filled: 1, average: 98, status: 'closed' });
  await risk.check();
  assert.equal(Math.round(risk.held(f.k.id, 'ETH/USDT') * 100) / 100, 1.5); // counted once, no double counting
  assert.equal(risk.watch.length, 0);
  risk.dispose(); trading.dispose();
});

test('daily loss limit converts other currencies to USD and fails safe when it cannot', async () => {
  const { ws, keys, trading } = setup();
  const risk = withRisk(trading, ws);
  const f = liveFake(trading, keys, 'kraken', { 'ETH/BTC': 0.04, 'BTC/USDT': 55000, 'SOL/XYZ': 10 });
  await trading.placeOrder({ accountId: f.k.id, symbol: 'ETH/BTC', side: 'buy', amount: 10, actor: 'user' });
  f.prices['ETH/BTC'] = 0.03;
  assert.equal(Math.round(await risk.todayPnl([f.k.id])), -5500);
  trading.setMandate({ enabled: true, accounts: [f.k.id], maxDailyLossUsd: 1000, maxOrderUsd: 1e9, maxDailyUsd: 1e9 }, 'user');
  await assert.rejects(risk.guard({ accountId: f.k.id, symbol: 'ETH/BTC', side: 'buy', amount: 1 }), /Daily loss limit reached/);
  // A currency without a USD price can't be checked: new positions are blocked, not waved through.
  f.prices['ETH/BTC'] = 0.04; // back to even
  trading._record({ account: f.k.id, accountLabel: 'Live', actor: 'user', side: 'buy', symbol: 'SOL/XYZ', amount: 1, price: 10, status: 'filled' });
  f.prices['SOL/XYZ'] = 9;
  await assert.rejects(risk.guard({ accountId: f.k.id, symbol: 'ETH/BTC', side: 'buy', amount: 1 }), /Can't convert .*SOL\/XYZ/);
  risk.dispose(); trading.dispose();
});

test('close all cancels pending buys first; cancel-pending keeps exit orders', async () => {
  const { ws, keys, trading } = setup();
  const risk = withRisk(trading, ws);
  const f = liveFake(trading, keys, 'binance', { 'SOL/USDT': 100 });
  await trading.placeOrder({ accountId: f.k.id, symbol: 'SOL/USDT', side: 'buy', amount: 1, actor: 'user' });
  const lim = await trading.placeOrder({ accountId: f.k.id, symbol: 'SOL/USDT', side: 'buy', type: 'limit', amount: 5, price: 90, actor: 'user' });
  const sellLimit = await trading.placeOrder({ accountId: f.k.id, symbol: 'SOL/USDT', side: 'sell', type: 'limit', amount: 0.5, price: 150, actor: 'user' });
  const res = await risk.closeAll();
  assert.equal(f.orders.get(lim.orderId).status, 'canceled');
  assert.equal(f.orders.get(sellLimit.orderId).status, 'open'); // a spot sell can't add to a position
  assert.ok(res.some(x => x.action === 'cancelled pending order'));
  assert.equal(risk.held(f.k.id, 'SOL/USDT'), 0);
  assert.equal(trading.mandate.sellOnly, true);
  risk.dispose(); trading.dispose();
});

test('a disabled task never runs, even if it was already queued', async () => {
  const { ws } = setup();
  const { Tasks } = require('../main/tasks');
  const ran = [];
  const assistant = { config: { model: 'm' }, busy: true, log: [], send: async p => { ran.push(p); } };
  const tasks = new Tasks({ ws, assistant, notify: () => {}, isPaused: () => false });
  const t = tasks.upsert({ name: 'T', prompt: 'do it' });
  tasks.runNow(t.id);
  tasks.upsert({ id: t.id, enabled: false });
  assistant.busy = false;
  await tasks.pump();
  assert.equal(ran.length, 0);
  assert.throws(() => tasks.runNow(t.id), /disabled/);
  tasks.upsert({ id: t.id, enabled: true });
  tasks.runNow(t.id);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(ran.length, 1);
  tasks.dispose();
});

test('agent searches go to DuckDuckGo, never Google', () => {
  const { agentUrl } = require('../main/search');
  assert.equal(agentUrl('btc price today'), 'https://duckduckgo.com/?q=btc%20price%20today');
  assert.equal(agentUrl('bitcoin'), 'https://duckduckgo.com/?q=bitcoin');
  assert.equal(agentUrl('x.com'), 'https://x.com');
  assert.equal(agentUrl('https://www.google.com/'), 'https://duckduckgo.com/');
  assert.equal(agentUrl('https://www.google.com/search?q=AI+assistant'), 'https://duckduckgo.com/?q=AI%20assistant');
  assert.equal(agentUrl('google.nl/search?q=eth'), 'https://duckduckgo.com/?q=eth');
  assert.equal(agentUrl('https://docs.google.com/document/d/1'), 'https://docs.google.com/document/d/1');
  assert.equal(agentUrl('https://www.google.com/maps'), 'https://www.google.com/maps');
});

test('a bot check goes to the user; the agent is locked out of it', async () => {
  const { Handoffs, BrowserGuard } = require('../main/guardrails');
  const botcheck = require('../main/botcheck');

  // detection: URL marks and page markers
  assert.equal(botcheck.fromUrl('https://www.google.com/sorry/index?continue=x'), 'Google "unusual traffic" check');
  assert.equal(botcheck.fromUrl('https://example.com/cdn-cgi/challenge-platform/x'), 'Cloudflare check');
  assert.equal(botcheck.fromUrl('https://duckduckgo.com/?q=btc'), null);
  assert.equal(botcheck.fromUrl('https://blog.example.com/how-captcha-works'), null); // an article about captchas is not one
  assert.match(botcheck.message('reCAPTCHA', 'https://www.google.com/sorry/index'), /reCAPTCHA on www\.google\.com.*I'm done.*won't touch/s);

  const sent = [];
  const handoffs = new Handoffs({ send: (...a) => sent.push(a), notify: () => {}, focus: () => {} });

  // a fake browser sitting on a bot-check page
  const browsers = {
    botChecks: new Map([['b1', 'reCAPTCHA']]),
    botCheck: async id => browsers.botChecks.get(id) || null,
    wc: () => ({ getURL: () => 'https://www.google.com/sorry/index' }),
  };
  const guard = new BrowserGuard({ ws: { settings: {}, getItem: () => ({ type: 'browser', profile: 'p1' }) }, browsers, handoffs, isPaused: () => false });

  await assert.rejects(() => guard.check('b1', 'click', { ref: 1 }), /only the user may complete it/i);
  await assert.rejects(() => guard.check('b1', 'type', { text: 'x' }), /only the user may complete it/i);
  await guard.check('b1', 'read'); // reading the page stays allowed
  await guard.check('b1', 'navigate', { url: 'https://duckduckgo.com' }); // and so does leaving for another site
  await guard.check('b1', 'scroll', {});
  browsers.botChecks.delete('b1');
  await guard.check('b1', 'click', { ref: 1 }); // cleared: the agent may work again

  // the hand-over asks the user, focuses the window and resolves on their answer
  const ask = handoffs.ask({ id: 'b1', message: botcheck.message('reCAPTCHA', 'https://www.google.com/sorry/index') });
  const pending = handoffs.list();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].browserId, 'b1');
  handoffs.answer(pending[0].id, true);
  assert.equal((await ask).accepted, true);
});

test('page loads to one host are paced, not hammered', async () => {
  const { BrowserControl } = require('../main/browserctl');
  const b = new BrowserControl({});
  const t0 = Date.now();
  await b.pace('https://example.com/a', 120);
  await b.pace('https://example.com/b', 120);
  assert.ok(Date.now() - t0 >= 110, 'second load to the same host should wait');
  const t1 = Date.now();
  await b.pace('https://other.com/a', 120);
  assert.ok(Date.now() - t1 < 60, 'a different host should not wait');
});

test('built-in engine: finds LM Studio and Ollama models, picks the right GPU and engine files', () => {
  const { scanModels, parseDevices, bestDevice, pickAssets } = require('../main/engine');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-engine-'));
  const put = (rel, bytes = 16) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(bytes)); return f; };
  const qwen = put('.lmstudio/models/org/Qwen-9B/Qwen-9B-Q4_K_M.gguf', 64);
  const proj = put('.lmstudio/models/org/Qwen-9B/mmproj-F16.gguf');
  put('.lmstudio/models/org/Tiny/tiny.gguf', 32);
  const blob = put('.ollama/models/blobs/sha256-abc', 48);
  put('.ollama/models/manifests/registry.ollama.ai/library/qwen3.5/9b', 1);
  fs.writeFileSync(path.join(home, '.ollama/models/manifests/registry.ollama.ai/library/qwen3.5/9b'),
    JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:abc', size: 48 }] }));
  const own = path.join(home, 'own'); fs.mkdirSync(own);

  const models = scanModels({ ownDir: own, home, ollamaDir: path.join(home, '.ollama', 'models') });
  const byName = Object.fromEntries(models.map(m => [m.name, m]));
  assert.equal(models.length, 3, 'mmproj files are not models');
  assert.equal(byName['Qwen-9B-Q4_K_M'].id, qwen);
  assert.equal(byName['Qwen-9B-Q4_K_M'].mmproj, proj, 'the vision projector next to a model is found');
  assert.equal(byName['Qwen-9B-Q4_K_M'].source, 'LM Studio');
  assert.equal(byName['qwen3.5:9b'].id, blob, 'Ollama models resolve to their blob file');
  assert.equal(byName.tiny.mmproj, null);

  // A dedicated card wins over the processor's graphics, even when that reports more (shared) memory.
  const devs = parseDevices('Available devices:\n  Vulkan0: NVIDIA GeForce RTX 4070 SUPER (11997 MiB, 11229 MiB free)\n  Vulkan1: AMD Radeon(TM) Graphics (16187 MiB, 15378 MiB free)');
  assert.equal(devs.length, 2);
  assert.equal(bestDevice(devs).id, 'Vulkan0');
  assert.equal(bestDevice(parseDevices('  Vulkan0: AMD Radeon RX 7800 XT (16368 MiB, 15000 MiB free)\n  Vulkan1: Intel(R) UHD Graphics (8000 MiB, 7000 MiB free)')).id, 'Vulkan0');

  // CUDA needs the matching runtime zip; the newest toolkit that has both is chosen.
  const release = { assets: ['llama-b1-bin-win-vulkan-x64.zip', 'llama-b1-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip', 'llama-b1-bin-win-cuda-13.4-x64.zip', 'cudart-llama-bin-win-cuda-13.4-x64.zip']
    .map(name => ({ name, size: 1 })) };
  assert.deepEqual(pickAssets(release, 'cuda').map(a => a.name), ['llama-b1-bin-win-cuda-13.4-x64.zip', 'cudart-llama-bin-win-cuda-13.4-x64.zip']);
  assert.deepEqual(pickAssets(release, 'vulkan').map(a => a.name), ['llama-b1-bin-win-vulkan-x64.zip']);
  assert.equal(pickAssets({ assets: [{ name: 'llama-b1-bin-win-cuda-13.4-x64.zip', size: 1 }] }, 'cuda'), null, 'no CUDA without its runtime');
  fs.rmSync(home, { recursive: true, force: true });
});

test('team: add, duplicate, rename, remove agents; each keeps its own settings and chat', async () => {
  const { ws, keys, trading, activity } = setup();
  const { Team } = require('../main/team');
  const { Agents } = require('../main/agents');
  const { slotCount } = require('../main/engine');
  const mcp = new McpServer({ ws, keys, trading, activity, browsers: { wcByItem: new Map() }, cursor: null, isPaused: () => false, getToken: () => 't', touch() {}, focusItem() {}, fileChanged() {} });
  ws.settings.llm = { runner: 'builtin', model: 'C:/m/qwen.gguf', numCtx: 16384 };
  const agents = new Agents(ws);
  const team = new Team({ ws, mcp, isPaused: () => false, safeStorage: fakeSafe, agents });

  // the old single assistant becomes the first team member, with its settings
  assert.equal(team.list().length, 1);
  assert.equal(team.list()[0].name, 'Assistant');
  assert.equal(team.primary.config.model, 'C:/m/qwen.gguf');

  // add copies the model but not the instructions; duplicate copies both
  team.get('assistant').setConfig({ role: 'Research competitors.' });
  const added = team.add();
  const dup = team.duplicate('assistant');
  const byId = Object.fromEntries(team.list().map(a => [a.id, a]));
  assert.equal(byId[added].name, 'Agent');
  assert.equal(byId[added].role, '');
  assert.equal(team.get(added).config.model, 'C:/m/qwen.gguf');
  assert.equal(byId[dup].name, 'Assistant 2');
  assert.equal(byId[dup].role, 'Research competitors.');
  assert.equal(team.duplicate(dup) && team.list().at(-1).name, 'Assistant 3', 'names stay unique');

  // agents on one built-in model share it: the engine gets one slot per agent, in steps
  assert.equal(team.slotsFor('C:/m/qwen.gguf'), 4);
  assert.deepEqual([1, 2, 3, 4, 5, 8].map(slotCount), [1, 2, 4, 4, 6, 6]);

  // each agent has its own settings and its own conversation file
  team.get(added).setConfig({ model: 'C:/m/other.gguf' });
  assert.equal(team.get('assistant').config.model, 'C:/m/qwen.gguf');
  assert.notEqual(team.get(added).file, team.get('assistant').file);

  // the system prompt tells an agent who it is and who else works in the canvas
  const prompt = team.get(dup).systemPrompt();
  assert.match(prompt, /You are "Assistant 2"/);
  assert.match(prompt, /Research competitors\./);

  // renaming keeps the agent's colour; names must be unique
  const color = agents.colorFor('Agent');
  team.update(added, { name: 'Scout' });
  assert.equal(agents.colorFor('Scout'), color);
  assert.throws(() => team.update(added, { name: 'assistant 2' }), /already an agent/);
  assert.ok(agents.list().find(a => a.name === 'Scout').builtIn);

  // remove deletes the agent; the last one stays
  team.remove(added);
  assert.ok(!team.list().some(a => a.id === added));
  for (const a of team.list().slice(1)) team.remove(a.id);
  assert.throws(() => team.remove('assistant'), /at least one/);

  // the team still behaves like the single assistant for older callers
  assert.equal(team.busy, false);
  assert.equal(team.log, team.primary.log);
});

test('agents stream their reasoning live, run without a step limit and stop only on a real loop', async () => {
  const http = require('http');
  const { ws, keys, trading, activity } = setup();
  const { LocalAgent, REPEAT_LIMIT, liveSplit } = require('../main/localagent');
  const mcp = new McpServer({ ws, keys, trading, activity, browsers: { wcByItem: new Map() }, cursor: null, isPaused: () => false, getToken: () => 't', touch() {}, focusItem() {}, fileChanged() {} });

  // An OpenAI-style server that streams: reasoning in pieces, then a tool call in pieces.
  // Mode "steps" calls a tool 12 times with different arguments, then answers.
  // Mode "loop" calls the same tool with the same arguments forever.
  let mode = 'steps', calls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = delta => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      send({ reasoning_content: 'Let me ' });
      send({ reasoning_content: 'think about it.' });
      const done = mode === 'steps' && calls > 12;
      if (done) send({ content: 'All done.' });
      else {
        const args = JSON.stringify({ query: mode === 'loop' ? 'same' : `q${calls}` });
        send({ tool_calls: [{ index: 0, id: `call${calls}`, function: { name: 'library_search', arguments: args.slice(0, 5) } }] });
        send({ tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const agent = new LocalAgent({ ws, mcp, isPaused: () => false, safeStorage: fakeSafe });
  agent.setConfig({ runner: 'custom', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'm' });
  const events = [];
  agent.on('event', e => events.push(e));

  await agent.send('do twelve things');
  assert.equal(calls, 13, 'no step limit: 12 tool steps and a final answer');
  assert.equal(agent.log.filter(e => e.type === 'tool').length, 12);
  assert.equal(agent.log.at(-1).text, 'All done.');
  assert.ok(events.some(e => e.type === 'stream' && !e.done), 'reasoning was shown while it was written');
  const thinking = agent.log.filter(e => e.type === 'thinking');
  assert.equal(thinking.length, 13);
  assert.ok(thinking.every(e => e.text === 'Let me think about it.' && !e.live), 'live blocks settle into the full reasoning');

  mode = 'loop'; calls = 0;
  await agent.send('loop forever');
  assert.equal(calls, REPEAT_LIMIT + 1, 'stops once the same step repeats more than the limit');
  assert.match(agent.log.at(-1).text, /stuck in a loop/);

  // <think> tags inside the answer count as reasoning while streaming
  assert.deepEqual(liveSplit('', '<think>plan</think>Hello'), { thinking: 'plan', text: 'Hello' });
  assert.deepEqual(liveSplit('', 'half a thought</think>Hi'), { thinking: 'half a thought', text: 'Hi' });
  assert.deepEqual(liveSplit('', '<think>still thinking'), { thinking: 'still thinking', text: '' });
  server.close();
});

test('team: a browser belongs to the agent working in it', () => {
  const { ws, keys, trading, activity } = setup();
  const { Team } = require('../main/team');
  const mcp = new McpServer({ ws, keys, trading, activity, browsers: { wcByItem: new Map() }, cursor: null, isPaused: () => false, getToken: () => 't', touch() {}, focusItem() {}, fileChanged() {} });
  const team = new Team({ ws, mcp, isPaused: () => false, safeStorage: fakeSafe });
  const b = team.add({ name: 'Writer' });
  const browser = ws.addItem({ type: 'browser', url: 'https://example.com', title: 'Example' }, 'agent');
  const a = team.get('assistant');
  a.busy = true; // the Assistant is in the middle of a task

  assert.equal(team.claim('assistant', 'browser_read', { id: browser.id }), null, 'first user claims it');
  assert.match(team.claim(b, 'browser_click', { id: browser.id }), /being used by Assistant/);
  assert.match(team.claim(b, 'item_close', { id: browser.id }), /being used by Assistant/, 'and may not close it');
  assert.equal(team.claim(b, 'browser_read', { id: 'not-a-browser' }), null, 'only browsers are claimed');
  assert.equal(team.busyItems(b).get(browser.id), 'Assistant', 'the canvas list marks it as in use');

  // a browser opened by an agent is its own straight away
  team.claimOpened(b, JSON.stringify({ id: 'b-new' }));
  assert.equal(team.claims.get('b-new'), b);

  // when the task ends the browser is free again
  a.busy = false;
  team.release('assistant');
  assert.equal(team.claim(b, 'browser_click', { id: browser.id }), null);
});

test('agents never put windows on top of each other', async () => {
  const { ws, keys, trading, activity } = setup();
  const mcp = new McpServer({ ws, keys, trading, activity, browsers: { wcByItem: new Map() }, cursor: null, isPaused: () => false, getToken: () => 't', touch() {}, focusItem() {}, fileChanged() {} });
  const overlaps = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

  // three agents ask for the exact same spot
  const first = ws.addItem({ type: 'note', title: 'A', x: 100, y: 100, w: 400, h: 300 }, 'agent');
  const second = ws.addItem({ type: 'note', title: 'B', x: 100, y: 100, w: 400, h: 300 }, 'agent');
  const third = ws.addItem({ type: 'note', title: 'C', x: 120, y: 110, w: 400, h: 300 }, 'agent');
  assert.deepEqual([first.x, first.y], [100, 100], 'a free spot is used as asked');
  assert.ok(!overlaps(first, second) && !overlaps(first, third) && !overlaps(second, third), 'later windows move to the nearest free spot');

  // moving or growing a window onto another one lands it next to it instead
  const r = JSON.parse((await mcp.callTool('item_arrange', { id: third.id, x: first.x, y: first.y, w: 600 })).content[0].text);
  const moved = ws.getItem(third.id);
  assert.equal(moved.w, 600);
  assert.ok(!overlaps(moved, first) && !overlaps(moved, second), 'arranged window does not cover another');
  assert.deepEqual([r.x, r.y], [moved.x, moved.y], 'the agent is told where it really went');

  // the person can still put windows wherever they like
  const mine = ws.addItem({ type: 'note', title: 'Mine', x: 100, y: 100, w: 200, h: 200 }, 'user');
  assert.deepEqual([mine.x, mine.y], [100, 100]);
});

test('team: a leader creates helpers, hands out tasks and collects their answers', async () => {
  const http = require('http');
  const { ws, keys, trading, activity } = setup();
  const { Team, MAX_HELPERS } = require('../main/team');
  const { Agents } = require('../main/agents');
  const { agentStore } = require('../main/cursor');
  const mcp = new McpServer({ ws, keys, trading, activity, browsers: { wcByItem: new Map() }, cursor: null, isPaused: () => false, getToken: () => 't', touch() {}, focusItem() {}, fileChanged() {} });
  // A model that answers every task at once with "Done: <task>".
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const msgs = JSON.parse(body).messages;
      const task = String(msgs.filter(m => m.role === 'user').at(-1).content).split('\n')[1] || '';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      setTimeout(() => res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `Done: ${task}` } }] })}\n\ndata: [DONE]\n\n`), 150);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  ws.settings.llm = { runner: 'custom', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'm' };
  const agents = new Agents(ws);
  const team = new Team({ ws, mcp, isPaused: () => false, safeStorage: fakeSafe, agents });
  mcp.ctx.team = team;
  const as = (who, name, args) => agentStore.run(who, () => mcp.callTool(name, args));
  const out = r => { if (r.isError) throw new Error(r.content[0].text); return JSON.parse(r.content[0].text); };
  const boss = { id: 'assistant', label: 'Assistant' };

  // only agents with "can lead" switched on get the team tools
  const toolNames = a => a.toolDefs().map(t => t.function.name);
  assert.ok(!toolNames(team.primary).includes('team_spawn'));
  assert.match((await as(boss, 'team_spawn', { name: 'Researcher' })).content[0].text, /not allowed to lead/);
  team.primary.setConfig({ canLead: true });
  assert.ok(toolNames(team.primary).includes('team_spawn'));
  assert.match(team.primary.systemPrompt(), /You can lead helper agents/);

  // spawn with a first task, wait, read the answer
  const h1 = out(await as(boss, 'team_spawn', { name: 'Researcher', role: 'Look things up.', task: 'find the price of gold' }));
  const helper = team.list().find(a => a.id === h1.id);
  assert.equal(helper.spawnedBy, 'Assistant');
  assert.equal(agents.list().find(a => a.name === 'Researcher').canTrade, false, 'helpers may not trade');
  assert.ok(!toolNames(team.get(h1.id)).includes('team_spawn'), 'helpers get no team tools');
  assert.match(team.get(h1.id).systemPrompt(), /helper of Assistant/);
  const waited = out(await as(boss, 'team_wait', { timeoutSeconds: 10 }));
  assert.equal(waited.finished, true);
  assert.equal(waited.agents[0].answer, 'Done: find the price of gold');
  assert.equal(waited.agents[0].status, 'done');

  // a new task for the same helper; the answer is for that task only
  out(await as(boss, 'team_assign', { id: h1.id, task: 'find the price of silver' }));
  assert.match((await as(boss, 'team_assign', { id: h1.id, task: 'again' })).content[0].text, /still working/);
  await as(boss, 'team_wait', { ids: [h1.id], timeoutSeconds: 10 });
  assert.equal(out(await as(boss, 'team_result', { id: h1.id })).answer, 'Done: find the price of silver');
  assert.match((await as(boss, 'team_assign', { id: 'assistant', task: 'x' })).content[0].text, /cannot give itself/);

  // helpers cannot make helpers
  assert.match((await as({ id: h1.id, label: 'Researcher' }, 'team_spawn', { name: 'Sub' })).content[0].text, /Helpers cannot/);

  // an outside AI over the local API can lead too
  const ext = out(await as({ id: 'mcp-1', label: 'Claude Code' }, 'team_spawn', { name: 'Worker', task: 'summarise the news' }));
  assert.equal(team.list().find(a => a.id === ext.id).spawnedBy, 'Claude Code');
  const extWait = out(await as({ id: 'mcp-1', label: 'Claude Code' }, 'team_wait', { timeoutSeconds: 10 }));
  assert.deepEqual(extWait.agents.map(a => a.answer), ['Done: summarise the news'], 'each leader waits for its own helpers');

  // limits: helpers per leader; only your own helpers can be removed; never the user's agents
  for (let i = 1; i < MAX_HELPERS; i++) out(await as(boss, 'team_spawn', { name: `H${i}` }));
  assert.match((await as(boss, 'team_spawn', { name: 'TooMany' })).content[0].text, /already has 6 helpers/);
  assert.match((await as(boss, 'team_remove', { id: ext.id })).content[0].text, /not yours/);
  assert.match((await as(boss, 'team_remove', { id: 'assistant' })).content[0].text, /only the user/);
  out(await as(boss, 'team_list', {}));
  assert.equal((await as(boss, 'team_remove', { id: h1.id })).isError, undefined);
  assert.ok(!team.list().some(a => a.id === h1.id));
  server.close();
});

test('team: a leader reserves engine slots for its helpers, so they do not reload the model', () => {
  const { ws, keys, trading, activity } = setup();
  const { Team } = require('../main/team');
  const mcp = new McpServer({ ws, keys, trading, activity, browsers: { wcByItem: new Map() }, cursor: null, isPaused: () => false, getToken: () => 't', touch() {}, focusItem() {}, fileChanged() {} });
  ws.settings.llm = { runner: 'builtin', model: 'C:/m/q.gguf' };
  const team = new Team({ ws, mcp, isPaused: () => false, safeStorage: fakeSafe });
  assert.equal(team.slotsFor('C:/m/q.gguf'), 1, 'one ordinary agent');
  team.primary.setConfig({ canLead: true });
  assert.equal(team.slotsFor('C:/m/q.gguf'), 4, 'a leader alone already gets room for 3 helpers');
  for (let i = 0; i < 3; i++) team.spawnHelper({ by: { id: 'mcp', label: 'Assistant' }, name: `H${i}` });
  assert.equal(team.slotsFor('C:/m/q.gguf'), 4, 'three helpers fit in what was reserved: no reload');
});

test('a long conversation is compressed into a summary near the context limit', async t => {
  const http = require('http');
  const { ws, keys, trading, activity } = setup();
  const { LocalAgent, SUMMARY_MARK } = require('../main/localagent');
  const mcp = new McpServer({ ws, keys, trading, activity, browsers: { wcByItem: new Map() }, cursor: null, isPaused: () => false, getToken: () => 't', touch() {}, focusItem() {}, fileChanged() {} });
  let summaryAsks = 0, failSummary = false, lastBody = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      const isSummary = j.messages[0].content.startsWith('You compress');
      if (isSummary) summaryAsks++; else lastBody = j;
      if (isSummary && failSummary) { res.writeHead(500); return res.end('{"error":"model fell over"}'); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const content = isSummary ? 'The user asked for gold prices. Found: gold 2400 USD/oz on kitco.com. Still to do: silver.' : 'Silver is 31 USD/oz.';
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1234 } })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const agent = new LocalAgent({ ws, mcp, isPaused: () => false, safeStorage: fakeSafe });
  agent.setConfig({ runner: 'custom', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'm', numCtx: 16384 });
  // An earlier task that filled most of the context: about 20K tokens of page reads.
  const makeHistory = () => {
    const h = [];
    for (let i = 0; i < 10; i++) {
      h.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, name: 'browser_read', args: { id: 'b1' } }] });
      h.push({ role: 'tool', tool_call_id: `c${i}`, name: 'browser_read', content: `page ${i} `.repeat(800) });
    }
    return h;
  };
  const history = makeHistory();
  agent.messages = [{ role: 'user', content: 'Find the gold price.' }, ...history, { role: 'assistant', content: 'Gold is 2400 USD/oz.' }];
  const room = () => agent.contextBudget();
  assert.ok(agent.usedTokens() - room().fixed > room().budget * 0.8, 'the test starts over the threshold');

  await agent.send('Now find the silver price.');
  assert.equal(summaryAsks, 1, 'the model was asked once for a summary');
  const first = agent.messages[0];
  assert.ok(first.content.startsWith(SUMMARY_MARK), 'the old part is replaced by the summary');
  assert.match(first.content, /gold 2400 USD\/oz/);
  assert.ok(agent.messages.some(m => typeof m.content === 'string' && m.content.includes('Now find the silver price.')), 'the current task stays word for word');
  const entry = agent.log.find(e => e.type === 'compact');
  assert.ok(entry && entry.after - room().fixed < room().budget * 0.6, `shown in the chat with sizes (${entry && entry.before} -> ${entry && entry.after})`);
  const asks = summaryAsks;
  await agent.maybeCompact(new AbortController().signal);
  assert.equal(summaryAsks, asks, 'no second compression right after the first');
  assert.ok(!agent.log.some(e => e.type === 'notice' && /Compressing/.test(e.text)), 'the progress line is removed afterwards');
  assert.equal(agent.log.at(-1).text, 'Silver is 31 USD/oz.');
  assert.ok(JSON.stringify(lastBody.messages).length < 20000, 'the next step sent the short version');
  assert.equal(agent.measured.tokens, 1234, 'the real size reported by the server is used');

  // when the summary fails, the old trimming still keeps the conversation inside the limit
  failSummary = true;
  agent.messages = [{ role: 'user', content: 'Find the gold price.' }, ...makeHistory(), { role: 'assistant', content: 'Gold is 2400 USD/oz.' }];
  agent.measured = null;
  agent.compactedAt = null;
  await agent.send('And platinum?');
  assert.ok(agent.log.some(e => e.type === 'notice' && /Could not compress/.test(e.text)));
  assert.equal(agent.log.at(-1).text, 'Silver is 31 USD/oz.', 'the task still ran');
  server.close();
});

test('compression first shortens old page reads and only summarises when that is not enough', async () => {
  const { ws, keys, trading, activity } = setup();
  const { LocalAgent } = require('../main/localagent');
  const mcp = new McpServer({ ws, keys, trading, activity, browsers: { wcByItem: new Map() }, cursor: null, isPaused: () => false, getToken: () => 't', touch() {}, focusItem() {}, fileChanged() {} });
  const agent = new LocalAgent({ ws, mcp, isPaused: () => false, safeStorage: fakeSafe });
  agent.setConfig({ runner: 'custom', baseUrl: 'http://127.0.0.1:9/v1', model: 'm', numCtx: 16384 });
  let asked = 0;
  agent.summarise = async () => { asked++; return 'summary'; };
  const { budget, fixed } = agent.contextBudget();
  // Five big page reads: over the threshold, but shortening the older three is enough.
  const reads = [];
  for (let i = 0; i < 5; i++) {
    reads.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, name: 'browser_read', args: { id: 'b1' } }] });
    reads.push({ role: 'tool', tool_call_id: `c${i}`, name: 'browser_read', content: 'x'.repeat(Math.round(budget * 3.2 * 0.2)) });
  }
  agent.messages = [{ role: 'user', content: 'read four pages' }, ...reads];
  assert.ok(agent.usedTokens() - fixed > budget * 0.8, 'starts over the threshold');
  await agent.maybeCompact(new AbortController().signal);
  assert.equal(asked, 0, 'no model call needed');
  assert.ok(agent.usedTokens() - fixed < budget * 0.55, 'back under the target');
  assert.match(agent.messages[2].content, /older result shortened/);
  assert.ok(agent.messages.at(-1).content.length > 1500, 'the latest page read stays whole');
});

test('ad blocking: on by default, off per browser, nothing blocked on allowed sites', () => {
  const { ws } = setup();
  const { Adblock, matches } = require('../main/adblock');
  const ab = new Adblock({ ws });
  // a stand-in for the filter engine: which sessions have blocking switched on
  const on = new Set();
  ab.blocker = { isBlockingEnabled: s => on.has(s), enableBlockingInSession: s => on.add(s), disableBlockingInSession: s => on.delete(s) };
  const sesA = { name: 'a' }, sesB = { name: 'b' };
  ab.attach(sesA, 'pa');
  ab.attach(sesB, 'pb');
  assert.ok(on.has(sesA) && on.has(sesB), 'every browser is protected by default');
  assert.equal(ab.isOn('pa'), true);

  ab.setBrowser('pb', false);
  assert.ok(on.has(sesA) && !on.has(sesB), 'one browser switched off, the other stays on');
  assert.equal(ab.isOn('pb'), false);
  assert.deepEqual(ws.settings.adblock.off, ['pb'], 'remembered in the settings');

  ab.configure({ enabled: false });
  assert.equal(on.size, 0, 'the global switch turns it off everywhere');
  ab.configure({ enabled: true });
  ab.setBrowser('pb', true);
  assert.equal(on.size, 2);

  // site list: cleaned up, and sub-domains count
  const s = ab.configure({ allow: ['https://www.Example.com/news', ' shop.test ', '', 'example.com'] });
  assert.deepEqual(s.allow, ['www.example.com', 'shop.test', 'example.com']);
  assert.ok(matches('news.example.com', s.allow) && matches('shop.test', s.allow));
  assert.ok(!matches('notexample.com', s.allow), 'only real sub-domains match');
  assert.equal(ab.cosmetics({}, 'https://www.example.com/page'), undefined, 'no cosmetic filters on an allowed site');
});

// Newer features live in their own file.
require('./features');
require('./connectors');
