'use strict';
// Connectors: talk to your agents from Telegram and Discord. A bot you create yourself
// (its token stays encrypted in Officina) relays messages between a chat and one of the
// built-in agents. Only chats you link with a one-time pairing code shown in Officina
// can use it; anything else gets a short "not linked" reply (in direct messages only).
//
// In a linked chat: plain text goes to the chosen agent (or is read before its next
// step when it is busy) and its answer comes back. Commands: /help /status /agents
// /use <name> /peek /roundoff /stop /resume /new /done /cancel. Officina's notifications
// (an agent needs you, a task finished, a trade) also go to linked chats.
const { EventEmitter } = require('events');
const crypto = require('crypto');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PAIR_TTL = 10 * 60e3;
const MAX_PAIR_TRIES = 5;

// Splits long answers at paragraph or line breaks so each part fits the service's limit.
function split(text, max) {
  const out = [];
  let rest = String(text || '').trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// ---------- Telegram: Bot API with long polling (no public address needed) ----------
class TelegramBot {
  constructor({ token, fetchImpl = globalThis.fetch, api = 'https://api.telegram.org', onMessage, onState }) {
    Object.assign(this, { token, fetch: fetchImpl, api, onMessage, onState });
    this.running = false;
    this.offset = 0;
    this.max = 3900;
  }

  async call(method, body, signal) {
    const r = await this.fetch(`${this.api}/bot${this.token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { const e = new Error(j.description || `Telegram answered ${r.status}`); e.status = r.status; throw e; }
    return j.result;
  }

  async start() {
    this.running = true;
    this.onState({ state: 'connecting' });
    let me;
    try { me = await this.call('getMe'); } catch (e) {
      this.running = false;
      return this.onState({ state: 'error', error: e.status === 401 || e.status === 404 ? 'Telegram does not accept this token. Copy it again from @BotFather.' : e.message });
    }
    this.onState({ state: 'online', botName: `@${me.username}`, botId: String(me.id), error: '' });
    this.loop();
  }

  async loop() {
    let backoff = 1000;
    while (this.running) {
      this.ctl = new AbortController();
      try {
        const updates = await this.call('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message'] }, this.ctl.signal);
        backoff = 1000;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          const m = u.message;
          if (!m || typeof m.text !== 'string') continue;
          const user = m.from?.username ? `@${m.from.username}` : [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || 'someone';
          this.onMessage({ chatId: String(m.chat.id), user, text: m.text, direct: m.chat.type === 'private', chatName: m.chat.title || user });
        }
      } catch (e) {
        if (!this.running) break;
        if (e.status === 409) { this.onState({ state: 'error', error: 'Another program is reading this bot (or it has a webhook). Stop that program, or create a separate bot for Officina.' }); this.running = false; break; }
        if (e.status === 401) { this.onState({ state: 'error', error: 'Telegram no longer accepts this token.' }); this.running = false; break; }
        this.onState({ state: 'connecting', error: `Connection problem: ${e.message}. Retrying.` });
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
        if (this.running) this.onState({ state: 'online', error: '' });
      }
    }
  }

  stop() { this.running = false; this.ctl?.abort(); }

  async send(chatId, text) {
    for (const part of split(text, this.max)) await this.call('sendMessage', { chat_id: chatId, text: part, disable_web_page_preview: true });
  }

  async sendFile(chatId, { buf, mime, name, caption, video }) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption.slice(0, 1000));
    const field = mime.startsWith('image/') ? 'photo' : (video && mime.includes('mp4') ? 'video' : 'document');
    form.append(field, new Blob([buf], { type: mime }), name);
    const r = await this.fetch(`${this.api}/bot${this.token}/send${field[0].toUpperCase()}${field.slice(1)}`, { method: 'POST', body: form });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.description || `Telegram answered ${r.status}`);
  }

  typing(chatId) { return this.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}); }
}

// ---------- Discord: Gateway (websocket) for incoming, REST for outgoing ----------
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15); // guild messages, direct messages, message content

class DiscordBot {
  constructor({ token, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, api = 'https://discord.com/api/v10', onMessage, onState }) {
    Object.assign(this, { token, fetch: fetchImpl, WS: WebSocketImpl, api, onMessage, onState });
    this.running = false;
    this.max = 1900;
    this.seq = null;
  }

  async rest(method, path, body) {
    const r = await this.fetch(`${this.api}${path}`, { method, headers: { Authorization: `Bot ${this.token}`, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (https://github.com/Selmissaoui/officina, 1.0)' }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 204) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.message || `Discord answered ${r.status}`); e.status = r.status; throw e; }
    return j;
  }

  async start() {
    this.running = true;
    this.onState({ state: 'connecting' });
    let url;
    try { url = (await this.rest('GET', '/gateway/bot')).url; } catch (e) {
      this.running = false;
      return this.onState({ state: 'error', error: e.status === 401 ? 'Discord does not accept this token. Reset it under Bot in the Developer Portal and paste the new one.' : e.message });
    }
    this.connect(url);
  }

  connect(url) {
    if (!this.running) return;
    const ws = new this.WS(`${url}?v=10&encoding=json`);
    this.ws = ws;
    ws.onmessage = ev => {
      let p;
      try { p = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (p.s != null) this.seq = p.s;
      if (p.op === 10) {
        clearInterval(this.beat);
        this.beat = setInterval(() => { try { ws.send(JSON.stringify({ op: 1, d: this.seq })); } catch { /* closing */ } }, p.d.heartbeat_interval);
        ws.send(JSON.stringify({ op: 2, d: { token: this.token, intents: INTENTS, properties: { os: 'windows', browser: 'officina', device: 'officina' } } }));
      } else if (p.op === 1) {
        ws.send(JSON.stringify({ op: 1, d: this.seq }));
      } else if (p.op === 7 || p.op === 9) {
        try { ws.close(4000); } catch { /* already closed */ }
      } else if (p.op === 0 && p.t === 'READY') {
        this.botId = p.d.user.id;
        this.onState({ state: 'online', botName: p.d.user.username, botId: p.d.user.id, appId: p.d.application?.id || p.d.user.id, error: '' });
      } else if (p.op === 0 && p.t === 'MESSAGE_CREATE') {
        const m = p.d;
        if (!m.author || m.author.bot || typeof m.content !== 'string') return;
        const mentioned = (m.mentions || []).some(u => u.id === this.botId);
        const text = m.content.replace(new RegExp(`<@!?${this.botId}>`, 'g'), '').trim();
        if (!text) return;
        this.onMessage({ chatId: m.channel_id, user: m.author.global_name || m.author.username, text, direct: !m.guild_id, mentioned, chatName: m.guild_id ? `#channel ${m.channel_id}` : (m.author.global_name || m.author.username) });
      }
    };
    ws.onclose = ev => {
      clearInterval(this.beat);
      if (!this.running) return;
      if (ev.code === 4004) { this.running = false; return this.onState({ state: 'error', error: 'Discord rejected the token.' }); }
      if (ev.code === 4014) { this.running = false; return this.onState({ state: 'error', error: 'Turn on "Message Content Intent" for this bot (Developer Portal, Bot page), then switch the connector off and on.' }); }
      this.onState({ state: 'connecting', error: 'Reconnecting to Discord…' });
      setTimeout(() => this.connect(url), 3000);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  stop() { this.running = false; clearInterval(this.beat); try { this.ws?.close(1000); } catch { /* closed */ } }

  async sendFile(chatId, { buf, mime, name, caption }) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content: (caption || '').slice(0, 1900), allowed_mentions: { parse: [] } }));
    form.append('files[0]', new Blob([buf], { type: mime }), name);
    const r = await this.fetch(`${this.api}/channels/${chatId}/messages`, { method: 'POST', headers: { Authorization: `Bot ${this.token}`, 'User-Agent': 'DiscordBot (https://github.com/Selmissaoui/officina, 1.0)' }, body: form });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || `Discord answered ${r.status}`); }
  }

  async send(chatId, text) {
    for (const part of split(text, this.max)) await this.rest('POST', `/channels/${chatId}/messages`, { content: part, allowed_mentions: { parse: [] } });
  }

  typing(chatId) { return this.rest('POST', `/channels/${chatId}/typing`).catch(() => {}); }
}

const SERVICES = {
  telegram: { name: 'Telegram', Bot: TelegramBot },
  discord: { name: 'Discord', Bot: DiscordBot },
};

const HELP = [
  'Officina commands:',
  '/status: what the agents are doing',
  '/agents: list the agents, /use <name>: pick who answers here',
  '/roundoff: ask working agents to finish and report',
  '/peek: a picture of what your agent is doing, /peek 10: a 10-second clip',
  '/stop: pause every agent and auto-trading, /resume: let them continue',
  '/new: start a fresh conversation with your agent',
  '/done or /cancel: answer a request where an agent waits for you',
  'Anything else goes to your agent.',
].join('\n');

class Connectors extends EventEmitter {
  constructor({ ws, safeStorage, team, activity, handoffs = null, setPaused = null, isPaused = () => false, peek = null, fetchImpl, WebSocketImpl }) {
    super();
    Object.assign(this, { ws, safe: safeStorage, team, activity, handoffs, setPaused, isPaused, peek, fetchImpl, WebSocketImpl });
    this.bots = new Map();     // service -> bot
    this.state = new Map();    // service -> { state, error, botName, botId, appId }
    this.waiting = new Map();  // agent id -> [{ service, chatId, since }]
    this.notLinkedReplied = new Map();
    this.typingTimer = setInterval(() => this.keepTyping(), 4500);
    this.typingTimer.unref?.();
    this.offTeam = null;
    if (team) {
      const fn = e => this.onAgentEvent(e);
      team.on('event', fn);
      this.offTeam = () => team.off('event', fn);
    }
  }

  // ---------- settings ----------
  cfg(id) {
    const all = (this.ws.settings.connectors ||= {});
    return (all[id] ||= { enabled: false, notify: true, links: [], agentId: '' });
  }

  token(id) {
    const enc = this.cfg(id).tokenEnc;
    if (!enc) return '';
    try { return this.safe.decryptString(Buffer.from(enc, 'base64')); } catch { return ''; }
  }

  status() {
    return Object.entries(SERVICES).map(([id, s]) => {
      const c = this.cfg(id);
      const st = this.state.get(id) || { state: 'off' };
      const pair = c.pair && c.pair.expires > Date.now() ? c.pair : null;
      return {
        id, name: s.name, enabled: !!c.enabled, hasToken: !!c.tokenEnc, notify: c.notify !== false, agentId: c.agentId || '',
        state: c.enabled ? st.state || 'connecting' : 'off', error: c.enabled ? st.error || '' : '', botName: st.botName || c.botName || '', appId: st.appId || '',
        links: (c.links || []).map(l => ({ chatId: l.chatId, name: l.name, agentId: l.agentId || '', linkedAt: l.linkedAt })),
        pairCode: pair ? pair.code : null, pairExpires: pair ? pair.expires : null,
      };
    });
  }

  changed() { this.emit('status', this.status()); }

  configure(id, patch = {}) {
    if (!SERVICES[id]) throw new Error(`Unknown connector ${id}`);
    const c = this.cfg(id);
    if (typeof patch.token === 'string' && patch.token.trim()) {
      if (!this.safe.isEncryptionAvailable()) throw new Error('Secure storage is not available on this computer, so the token cannot be saved safely.');
      c.tokenEnc = this.safe.encryptString(patch.token.trim()).toString('base64');
      if (patch.enabled === undefined) patch.enabled = true;
    }
    if (patch.removeToken) { delete c.tokenEnc; c.enabled = false; c.links = []; delete c.botName; }
    if (patch.notify !== undefined) c.notify = !!patch.notify;
    if (typeof patch.agentId === 'string') c.agentId = patch.agentId;
    if (patch.enabled !== undefined) c.enabled = !!patch.enabled && !!c.tokenEnc;
    this.ws.saveSettings();
    this.restart(id);
    return this.status();
  }

  // A fresh six-digit code, valid for ten minutes. Sending "/pair <code>" to the bot links that chat.
  newPairCode(id) {
    const c = this.cfg(id);
    c.pair = { code: String(crypto.randomInt(100000, 1000000)), expires: Date.now() + PAIR_TTL, tries: 0 };
    this.ws.saveSettings();
    this.changed();
    return c.pair.code;
  }

  unlink(id, chatId) {
    const c = this.cfg(id);
    c.links = (c.links || []).filter(l => l.chatId !== String(chatId));
    this.ws.saveSettings();
    this.activity?.log('user', 'connector.unlinked', `${SERVICES[id].name} ${chatId}`);
    this.changed();
    return this.status();
  }

  setLinkAgent(id, chatId, agentId) {
    const l = (this.cfg(id).links || []).find(x => x.chatId === String(chatId));
    if (l) { l.agentId = agentId; this.ws.saveSettings(); this.changed(); }
    return this.status();
  }

  // ---------- running the bots ----------
  startAll() { for (const id of Object.keys(SERVICES)) this.restart(id); }

  restart(id) {
    this.bots.get(id)?.stop();
    this.bots.delete(id);
    const c = this.cfg(id);
    if (!c.enabled || !c.tokenEnc) { this.state.delete(id); this.changed(); return; }
    const bot = new SERVICES[id].Bot({
      token: this.token(id), fetchImpl: this.fetchImpl, WebSocketImpl: this.WebSocketImpl,
      onMessage: m => this.onMessage(id, m).catch(e => this.activity?.log('system', 'connector.failed', `${SERVICES[id].name}: ${e.message}`)),
      onState: s => {
        this.state.set(id, { ...(this.state.get(id) || {}), ...s });
        if (s.botName && s.botName !== c.botName) { c.botName = s.botName; this.ws.saveSettings(); }
        if (s.state === 'error') this.activity?.log('system', 'connector.error', `${SERVICES[id].name}: ${s.error}`);
        this.changed();
      },
    });
    this.bots.set(id, bot);
    bot.start();
  }

  stopAll() { for (const b of this.bots.values()) b.stop(); this.bots.clear(); clearInterval(this.typingTimer); this.offTeam?.(); }

  // ---------- incoming ----------
  link(id, chatId) { return (this.cfg(id).links || []).find(l => l.chatId === String(chatId)) || null; }

  agentFor(id, link) {
    const want = link?.agentId || this.cfg(id).agentId;
    return (want && this.team.members.get(want)) || this.team.primary;
  }

  reply(id, chatId, text) {
    return this.bots.get(id)?.send(chatId, text).catch(e => this.activity?.log('system', 'connector.failed', `${SERVICES[id].name}: ${e.message}`));
  }

  async onMessage(id, { chatId, user, text, direct, mentioned, chatName }) {
    const t = String(text || '').trim();
    const link = this.link(id, chatId);
    if (!link) {
      const m = t.match(/^\/?pair(?:@\S+)?\s+(\d{6})$/i);
      const c = this.cfg(id);
      if (m) {
        const pair = c.pair && c.pair.expires > Date.now() ? c.pair : null;
        if (pair && crypto.timingSafeEqual(Buffer.from(pair.code), Buffer.from(m[1]))) {
          c.links = [...(c.links || []), { chatId: String(chatId), name: chatName || user, linkedAt: new Date().toISOString() }];
          delete c.pair;
          this.ws.saveSettings();
          this.activity?.log('user', 'connector.linked', `${SERVICES[id].name}: ${chatName || user}`);
          this.changed();
          return this.reply(id, chatId, `Linked to Officina. ${this.agentFor(id).name} answers here.\n\n${HELP}`);
        }
        if (pair && ++pair.tries >= MAX_PAIR_TRIES) { delete c.pair; this.ws.saveSettings(); this.changed(); }
        else if (pair) this.ws.saveSettings();
        return this.reply(id, chatId, 'That code is not valid (or has expired). Make a new one in Officina under Connectors.');
      }
      // Only direct messages get a hint, at most once every ten minutes; group chats are ignored.
      if (!direct) return;
      const last = this.notLinkedReplied.get(`${id}:${chatId}`) || 0;
      if (Date.now() - last < 10 * 60e3) return;
      this.notLinkedReplied.set(`${id}:${chatId}`, Date.now());
      return this.reply(id, chatId, 'This chat is not linked to Officina yet. In Officina, open Connectors, make a pairing code and send it here as: /pair 123456');
    }
    // In a linked group or server channel, only messages that mention the bot or start with "/" count.
    if (!direct && id === 'discord' && !mentioned && !t.startsWith('/')) return;
    if (t.startsWith('/')) return this.command(id, chatId, link, t);
    return this.toAgent(id, chatId, link, user, t);
  }

  async command(id, chatId, link, t) {
    const [cmdRaw, ...rest] = t.slice(1).split(/\s+/);
    const cmd = cmdRaw.replace(/@.*$/, '').toLowerCase();
    const arg = rest.join(' ').trim();
    const team = this.team;
    if (cmd === 'help' || cmd === 'start') return this.reply(id, chatId, HELP);
    if (cmd === 'status' || cmd === 'agents') {
      const lines = team.list().map(a => `${a.busy ? '● working' : '○ idle'}  ${a.name}${a.spawnedBy ? ` (helper of ${a.spawnedBy})` : ''}${a.busy && a.last ? `: ${a.last.type === 'tool' ? a.last.name.replace(/_/g, ' ') : a.last.text.slice(0, 80)}` : ''}`);
      const pending = this.handoffs?.list() || [];
      return this.reply(id, chatId, [`${this.isPaused() ? 'Agents are STOPPED.' : `${team.list().filter(a => a.busy).length} working`}. Answers here: ${this.agentFor(id, link).name}.`, ...lines, ...(pending.length ? ['', `Waiting for you: ${pending.map(p => p.message.slice(0, 100)).join(' | ')} (reply /done or /cancel)`] : [])].join('\n'));
    }
    if (cmd === 'use') {
      const a = team.list().find(x => x.name.toLowerCase() === arg.toLowerCase()) || team.list().find(x => x.name.toLowerCase().startsWith(arg.toLowerCase()) && arg);
      if (!a) return this.reply(id, chatId, `No agent called "${arg}". Agents: ${team.list().map(x => x.name).join(', ')}`);
      link.agentId = a.id;
      this.ws.saveSettings();
      this.changed();
      return this.reply(id, chatId, `${a.name} answers here from now on.`);
    }
    if (cmd === 'roundoff' || cmd === 'wrapup') {
      const r = team.wrapUp({});
      return this.reply(id, chatId, r.asked.length ? `Asked ${r.asked.map(a => a.name).join(', ')} to round off. Their answers come here if they were working for this chat.` : 'Nobody is working right now.');
    }
    if (cmd === 'peek') {
      if (!this.peek) return this.reply(id, chatId, 'Peek is not available.');
      const name = this.agentFor(id, link).name;
      const secs = Number(arg);
      try {
        if (secs > 0) {
          await this.reply(id, chatId, `Recording ${Math.min(secs, 20)} seconds of ${name}…`);
          const c = await this.peek.clip(name, secs);
          await this.bots.get(id)?.sendFile(chatId, { ...c, name: c.mime.includes('mp4') ? 'peek.mp4' : 'peek.webm', video: true });
        } else {
          const s = await this.peek.shot(name);
          await this.bots.get(id)?.sendFile(chatId, { ...s, mime: 'image/jpeg', name: 'peek.jpg' });
        }
      } catch (e) { return this.reply(id, chatId, `Peek failed: ${e.message}`); }
      return;
    }
    if (cmd === 'stop') { this.setPaused?.(true); return this.reply(id, chatId, 'Stopped: agents and auto-trading are paused. /resume lets them continue.'); }
    if (cmd === 'resume') { this.setPaused?.(false); return this.reply(id, chatId, 'Agents may continue.'); }
    if (cmd === 'new') { const a = this.agentFor(id, link); a.reset(); return this.reply(id, chatId, `Started a fresh conversation with ${a.name}.`); }
    if (cmd === 'done' || cmd === 'cancel') {
      const pending = this.handoffs?.list() || [];
      if (!pending.length) return this.reply(id, chatId, 'No agent is waiting for you.');
      this.handoffs.answer(pending[0].id, cmd === 'done');
      return this.reply(id, chatId, cmd === 'done' ? 'Told the agent you are done.' : 'Told the agent no.');
    }
    return this.reply(id, chatId, `Unknown command /${cmd}.\n\n${HELP}`);
  }

  async toAgent(id, chatId, link, user, text) {
    const a = this.agentFor(id, link);
    const from = `${user} on ${SERVICES[id].name}`;
    if (this.isPaused()) return this.reply(id, chatId, 'Agents are stopped right now. Send /resume to let them continue.');
    if (!a.config.model) return this.reply(id, chatId, `${a.name} has no model yet. Choose one in Officina first.`);
    this.activity?.log('user', 'connector.message', `${SERVICES[id].name} to ${a.name}: ${text.slice(0, 120)}`);
    const list = this.waiting.get(a.id) || [];
    if (a.busy) {
      a.deliver(text, from);
      if (!list.some(w => w.service === id && w.chatId === chatId)) list.push({ service: id, chatId, since: a.log.length });
      this.waiting.set(a.id, list);
      return this.reply(id, chatId, `${a.name} is working; it reads this before its next step and answers here when it is done.`);
    }
    list.push({ service: id, chatId, since: a.log.length });
    this.waiting.set(a.id, list);
    this.bots.get(id)?.typing(chatId);
    a.send(`[Message from ${from}]\n${text}`).catch(e => this.reply(id, chatId, `Could not start ${a.name}: ${e.message}`));
  }

  // When an agent someone is waiting for finishes, its answer goes back to those chats.
  onAgentEvent(e) {
    if (e.type !== 'busy' || e.busy !== false) return;
    const waiting = this.waiting.get(e.agent);
    if (!waiting?.length) return;
    this.waiting.delete(e.agent);
    const a = this.team.members.get(e.agent);
    if (!a) return;
    for (const w of waiting) {
      const since = a.log.slice(w.since);
      const answer = [...since].reverse().find(x => x.type === 'assistant');
      const problem = [...since].reverse().find(x => x.type === 'error' || (x.type === 'notice' && /^Stopped/.test(x.text)));
      const text = answer ? answer.text : problem ? `${a.name}: ${problem.text}` : `${a.name} finished without an answer.`;
      this.reply(w.service, w.chatId, text);
    }
  }

  keepTyping() {
    for (const [agentId, list] of this.waiting) {
      if (!this.team.members.get(agentId)?.busy) continue;
      for (const w of list) this.bots.get(w.service)?.typing(w.chatId);
    }
  }

  // ---------- outgoing ----------
  // Officina's notifications, sent to every linked chat of connectors with notifications on.
  async notify(title, body = '') {
    const text = [title, body].filter(Boolean).join('\n').slice(0, 3500);
    let sent = 0;
    for (const id of Object.keys(SERVICES)) {
      const c = this.cfg(id);
      if (!c.enabled || c.notify === false || !this.bots.get(id)) continue;
      for (const l of c.links || []) { await this.reply(id, l.chatId, text); sent++; }
    }
    return sent;
  }

  // An agent messaging the user (message_user tool): every linked chat.
  async messageUser(text, from = 'Officina') {
    let sent = 0;
    for (const id of Object.keys(SERVICES)) {
      const c = this.cfg(id);
      if (!c.enabled || !this.bots.get(id)) continue;
      for (const l of c.links || []) { await this.reply(id, l.chatId, `${from}: ${text}`); sent++; }
    }
    if (!sent) throw new Error('No Telegram or Discord chat is linked. The user can link one under Connectors.');
    return sent;
  }
}

module.exports = { Connectors, TelegramBot, DiscordBot, SERVICES, split, HELP };
