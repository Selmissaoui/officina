// Connector tests with fake Telegram and Discord servers (no network, no real tokens).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Workspace } = require('../main/workspace');
const { Connectors, split } = require('../main/connectors');

const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from('ENC:' + Buffer.from(s).toString('base64')),
  decryptString: b => Buffer.from(b.toString().slice(4), 'base64').toString(),
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await sleep(10); } };

// A team with one agent that answers "echo: <text>" after a short while.
function fakeTeam() {
  const team = new EventEmitter();
  const agent = { id: 'a1', name: 'CEO', busy: false, log: [], config: { model: 'm' }, inbox: [],
    async send(text) {
      agent.busy = true; team.emit('event', { type: 'busy', busy: true, agent: 'a1' });
      await sleep(30);
      agent.log.push({ type: 'assistant', text: `echo: ${text.split('\n').pop()}` });
      agent.busy = false; team.emit('event', { type: 'busy', busy: false, agent: 'a1' });
    },
    deliver(text, from) { agent.inbox.push({ text, from }); },
    reset() { agent.log = []; },
  };
  Object.assign(team, { members: new Map([['a1', agent]]), primary: agent, list: () => [{ id: 'a1', name: 'CEO', busy: agent.busy, last: null }], wrapUp: () => ({ asked: [] }) });
  return { team, agent };
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-conn-'));
  const ws = new Workspace(root);
  ws.init();
  return ws;
}

test('split keeps every part under the limit and breaks at lines', () => {
  const parts = split(`${'a'.repeat(30)}\n${'b'.repeat(30)}\n${'c'.repeat(30)}`, 40);
  assert.deepEqual(parts, ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)]);
  assert.ok(split('x'.repeat(100), 30).every(p => p.length <= 30));
});

test('Telegram: only a chat linked with the pairing code talks to the agent, and gets its answer', async () => {
  const ws = setup();
  const { team, agent } = fakeTeam();
  const sent = [];
  const files = [];
  const queue = [];
  let id = 1;
  const fetchImpl = async (url, opts) => {
    const method = url.split('/').pop();
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
    if (opts.body instanceof FormData) files.push({ method, form: opts.body });
    const ok = result => ({ status: 200, json: async () => ({ ok: true, result }) });
    if (!url.includes('/botTOKEN123/')) return { status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) };
    if (method === 'getMe') return ok({ id: 42, username: 'officina_test_bot' });
    if (method === 'sendMessage') { sent.push(body); return ok({}); }
    if (method === 'sendChatAction') return ok(true);
    if (method === 'getUpdates') {
      for (let i = 0; i < 20 && !queue.length && !opts.signal?.aborted; i++) await sleep(10);
      if (opts.signal?.aborted) throw new Error('aborted');
      return ok(queue.splice(0).map(m => ({ update_id: id++, message: m })));
    }
    return ok({});
  };
  const paused = { v: false };
  const peek = { shot: async name => ({ buf: Buffer.from('jpg'), caption: `${name} (canvas)` }), clip: async (name, s) => ({ buf: Buffer.from('mp4'), mime: 'video/mp4', caption: `${name} (${s} s)` }) };
  const c = new Connectors({ ws, safeStorage: fakeSafe, team, fetchImpl, setPaused: v => { paused.v = v; }, isPaused: () => paused.v, peek });
  const msg = (text, chat = 7) => queue.push({ text, chat: { id: chat, type: 'private' }, from: { username: 'testuser' } });

  c.configure('telegram', { token: 'WRONG' });
  await until(() => c.status()[0].state === 'error');
  assert.match(c.status()[0].error, /does not accept this token/);

  c.configure('telegram', { token: 'TOKEN123' });
  await until(() => c.status()[0].state === 'online');
  assert.equal(c.status()[0].botName, '@officina_test_bot');
  assert.ok(!JSON.stringify(ws.settings.connectors).includes('TOKEN123'), 'the token is stored encrypted');

  msg('hello');
  await until(() => sent.length === 1);
  assert.match(sent[0].text, /not linked/);
  msg('hello again');
  await sleep(150);
  assert.equal(sent.length, 1, 'the hint is not repeated');

  const code = c.status()[0].pairCode || (c.newPairCode('telegram'), c.status()[0].pairCode);
  msg('/pair 000000');
  await until(() => sent.length === 2);
  assert.match(sent[1].text, /not valid/);
  msg(`/pair ${code}`);
  await until(() => sent.length === 3);
  assert.match(sent[2].text, /Linked to Officina/);
  assert.equal(c.status()[0].links.length, 1);
  assert.equal(c.status()[0].pairCode, null, 'a code works once');

  msg('what did you find?');
  await until(() => sent.some(s => s.text === 'echo: what did you find?'));
  assert.equal(sent.at(-1).chat_id, '7');

  // a busy agent reads it before its next step
  agent.busy = true;
  msg('also check ETH');
  await until(() => agent.inbox.length === 1);
  assert.deepEqual(agent.inbox[0], { text: 'also check ETH', from: '@testuser on Telegram' });
  agent.busy = false;

  msg('/stop');
  await until(() => paused.v === true);
  msg('do something');
  await until(() => sent.some(s => /stopped right now/.test(s.text)));
  msg('/resume');
  await until(() => paused.v === false);

  // /peek: a picture, /peek 5: a clip, sent as a file
  msg('/peek');
  await until(() => files.length === 1);
  assert.equal(files[0].method, 'sendPhoto');
  assert.equal(files[0].form.get('caption'), 'CEO (canvas)');
  msg('/peek 5');
  await until(() => files.length === 2);
  assert.equal(files[1].method, 'sendVideo');
  assert.ok(sent.some(s => /Recording 5 seconds of CEO/.test(s.text)));

  // notifications go to linked chats
  const n = await c.notify('AI needs you', 'A bot check');
  assert.equal(n, 1);
  assert.match(sent.at(-1).text, /AI needs you\nA bot check/);

  // another chat cannot use it
  const before = sent.length;
  msg('ignore me', 99);
  await until(() => sent.length === before + 1);
  assert.match(sent.at(-1).text, /not linked/);
  c.stopAll();
});

test('Discord: the bot logs in over the gateway, pairs a DM and answers through the API', async () => {
  const ws = setup();
  const { team } = fakeTeam();
  const posts = [];
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/gateway/bot')) return { status: 200, ok: true, json: async () => ({ url: 'wss://gateway.test' }) };
    if (opts.method === 'POST' && /\/messages$/.test(url)) { posts.push({ url, body: JSON.parse(opts.body) }); return { status: 200, ok: true, json: async () => ({}) }; }
    return { status: 204, ok: true, json: async () => ({}) };
  };
  let gw;
  class FakeWS {
    constructor(url) {
      gw = this;
      this.url = url;
      this.sent = [];
      setTimeout(() => this.onmessage({ data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }) }), 5);
    }
    send(raw) {
      const p = JSON.parse(raw);
      this.sent.push(p);
      if (p.op === 2) setTimeout(() => this.onmessage({ data: JSON.stringify({ op: 0, s: 1, t: 'READY', d: { user: { id: 'B1', username: 'Officina' }, application: { id: 'APP1' } } }) }), 5);
    }
    close() { this.onclose?.({ code: 1000 }); }
    dm(content, extra = {}) { this.onmessage({ data: JSON.stringify({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { channel_id: 'C9', content, author: { id: 'U1', username: 'testuser' }, mentions: [], ...extra } }) }); }
  }
  const c = new Connectors({ ws, safeStorage: fakeSafe, team, fetchImpl, WebSocketImpl: FakeWS });
  c.configure('discord', { token: 'DTOKEN' });
  await until(() => c.status()[1].state === 'online');
  const identify = gw.sent.find(p => p.op === 2);
  assert.equal(identify.d.token, 'DTOKEN');
  assert.ok(identify.d.intents & (1 << 15), 'asks for message content');
  assert.equal(c.status()[1].appId, 'APP1');

  c.newPairCode('discord');
  gw.dm(`pair ${c.status()[1].pairCode}`);
  await until(() => posts.length === 1);
  assert.match(posts[0].body.content, /Linked to Officina/);
  assert.deepEqual(posts[0].body.allowed_mentions, { parse: [] }, 'never pings anyone');
  gw.dm('summarise the news');
  await until(() => posts.some(p => p.body.content === 'echo: summarise the news'));
  // in a server channel the bot only listens when it is mentioned
  c.cfg('discord').links.push({ chatId: 'G1', name: 'server' });
  const before = posts.length;
  gw.onmessage({ data: JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', d: { channel_id: 'G1', guild_id: 'S1', content: 'chatter', author: { id: 'U2', username: 'x' }, mentions: [] } }) });
  await sleep(100);
  assert.equal(posts.length, before);
  gw.onmessage({ data: JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', d: { channel_id: 'G1', guild_id: 'S1', content: '<@B1> hi bot', author: { id: 'U2', username: 'x' }, mentions: [{ id: 'B1' }] } }) });
  await until(() => posts.some(p => p.body.content === 'echo: hi bot'));
  c.stopAll();
});
