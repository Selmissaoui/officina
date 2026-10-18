'use strict';
// The built-in agents. Each one is a LocalAgent with its own name, colour, model,
// instructions and conversation, and they all work in the canvas at the same time.
// Profiles live in settings.team; agents on the same built-in model share one engine.
// For older callers (tasks, spaces, backup) the team also behaves like the single
// assistant it replaced: busy means "any agent busy", send goes to the first agent.
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { LocalAgent, WRAP_UP } = require('./localagent');
const { newId, readJson, writeJson } = require('./store');

const MAX_AGENTS = 12;
const MAX_HELPERS = 6;    // helpers one leader may have at once
const MAX_PER_MODEL = 6;  // agents that can share one built-in model (engine slots; 8 crashed on Vulkan)
const HELPER_RESERVE = 3; // engine slots a leader keeps free for helpers (what it is told to use)
const NAME_MAX = 24;

class Team extends EventEmitter {
  constructor({ ws, mcp, isPaused, safeStorage, engine = null, agents = null }) {
    super();
    Object.assign(this, { ws, mcp, isPaused, safeStorage, engine, agents });
    if (!Array.isArray(ws.settings.team) || !ws.settings.team.length) {
      ws.settings.team = [{ ...(ws.settings.llm || {}), id: 'assistant', name: 'Assistant' }];
      ws.saveSettings();
    }
    this.members = new Map();
    this.claims = new Map(); // browser item id -> id of the agent working in it
    for (const p of this.profiles) this.spawn(p.id);
    if (agents) {
      agents.builtIns = () => this.profiles.map(p => p.name);
      agents.busyOf = name => { const p = this.profiles.find(x => x.name === name); return !!(p && this.members.get(p.id)?.busy); };
    }
    this._timer = null;
    // Tokens every built-in agent sent to and got back from its model, for the toolbar counter.
    this.tokenFile = path.join(ws.root, 'tokens.json');
    this.tokens = readJson(this.tokenFile, null) || { since: new Date().toISOString(), in: 0, out: 0, steps: 0, byAgent: {} };
    this._tokTimer = null;
  }

  get profiles() { return this.ws.settings.team; }

  profile(id) { return this.profiles.find(p => p.id === id) || {}; }

  saveProfile(id, cur) {
    const i = this.profiles.findIndex(p => p.id === id);
    if (i < 0) return;
    this.profiles[i] = { ...cur, id, name: this.profiles[i].name };
    this.ws.saveSettings();
    this.changed();
  }

  spawn(id) {
    const a = new LocalAgent({ ws: this.ws, mcp: this.mcp, isPaused: this.isPaused, safeStorage: this.safeStorage, engine: this.engine, id, team: this });
    a.on('event', e => {
      this.emit('event', { ...e, agent: id });
      if (['busy', 'assistant', 'error', 'tool', 'reset'].includes(e.type)) this.changed();
      if (e.type === 'busy') this.agents?.changed();
    });
    this.members.set(id, a);
    return a;
  }

  get(id) { return (id && this.members.get(id)) || this.primary; }

  get primary() { return this.members.get(this.profiles[0].id); }

  list() {
    return this.profiles.map(p => {
      const a = this.members.get(p.id);
      const last = a ? [...a.log].reverse().find(e => ['assistant', 'error', 'tool', 'notice', 'user'].includes(e.type)) : null;
      return {
        id: p.id, name: p.name, role: p.role || '', runner: p.runner || '', model: p.model || '',
        spawnedBy: p.spawnedBy || '', canLead: !!p.canLead && !p.spawnedBy,
        color: this.agents ? this.agents.colorFor(p.name) : null, busy: !!a?.busy,
        last: last ? { type: last.type, text: String(last.text || '').slice(0, 300), name: last.name || '', status: last.status || '' } : null,
      };
    });
  }

  uniqueName(wanted) {
    const base = String(wanted || 'Agent').replace(/\s+\d+$/, '').trim().slice(0, NAME_MAX - 3) || 'Agent';
    const taken = new Set(this.profiles.map(p => p.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  }

  // A new agent with the model settings of an existing one. Duplicate also keeps its instructions.
  add({ from = null, name = '', keepRole = false } = {}) {
    if (this.profiles.length >= MAX_AGENTS) throw new Error(`At most ${MAX_AGENTS} agents.`);
    const src = this.profile(from || this.profiles[0].id);
    const id = newId('ag');
    const { id: _id, name: srcName, role, spawnedBy, canLead, ...settings } = src;
    const lead = keepRole ? { canLead: !!canLead, ...(spawnedBy ? { spawnedBy } : {}) } : {};
    this.profiles.push({ ...settings, ...lead, id, name: this.uniqueName(name || (keepRole ? srcName : 'Agent')), role: keepRole ? role || '' : '' });
    this.ws.saveSettings();
    this.spawn(id);
    this.changed(true);
    return id;
  }

  duplicate(id) {
    if (!this.members.has(id)) throw new Error('No such agent.');
    return this.add({ from: id, keepRole: true });
  }

  update(id, { name, role } = {}) {
    const p = this.profiles.find(x => x.id === id);
    if (!p) throw new Error('No such agent.');
    if (typeof name === 'string' && name.trim() && name.trim() !== p.name) {
      const clean = name.trim().slice(0, NAME_MAX);
      if (this.profiles.some(x => x.id !== id && x.name.toLowerCase() === clean.toLowerCase())) throw new Error(`There is already an agent called ${clean}.`);
      this.agents?.rename(p.name, clean);
      p.name = clean;
    }
    if (typeof role === 'string') p.role = role.slice(0, 4000);
    this.ws.saveSettings();
    this.changed(true);
    return this.list();
  }

  remove(id) {
    if (this.profiles.length <= 1) throw new Error('Keep at least one agent.');
    const i = this.profiles.findIndex(p => p.id === id);
    if (i < 0) throw new Error('No such agent.');
    const a = this.members.get(id);
    a?.stop();
    this.release(id);
    const [p] = this.profiles.splice(i, 1);
    this.members.delete(id);
    if (a) fs.rmSync(a.file, { force: true });
    this.ws.saveSettings();
    try { this.agents?.forget(p.name); } catch { /* registry keeps it */ }
    this.changed(true);
    return this.list();
  }

  // Give several agents their own task in one go.
  sendMany(tasks) {
    const started = [];
    for (const { id, text } of tasks || []) {
      const a = this.members.get(id);
      const t = String(text || '').trim();
      if (!a || !t || a.busy) continue;
      a.send(t).catch(e => this.emit('event', { type: 'error', text: e.message, agent: id }));
      started.push(id);
    }
    return started;
  }

  // How many agents use this built-in model: the engine gives it that many slots. A leader
  // reserves room for its helpers up front, so creating them does not reload the model.
  slotsFor(model) {
    const on = this.profiles.filter(p => p.runner === 'builtin' && p.model === model);
    const helpers = on.filter(p => p.spawnedBy).length;
    const leads = on.some(p => p.canLead && !p.spawnedBy);
    return Math.max(1, on.length - helpers + (leads ? Math.max(helpers, HELPER_RESERVE) : helpers));
  }

  // ---------- agents that lead other agents ----------
  // A leader (a built-in agent with "can lead" on, or an outside AI over the local API)
  // can create helpers, give them tasks, wait for them and read their answers.
  // Helpers never create agents themselves, may not trade, and share the leader's model.
  leaderCheck(by) {
    const member = by && this.members.get(by.id);
    if (!member) return null; // an outside AI over the local API
    const p = this.profile(by.id);
    if (p.spawnedBy) throw new Error('Helpers cannot create or lead other agents.');
    if (!p.canLead) throw new Error(`${p.name} is not allowed to lead other agents. The user can switch this on in its settings.`);
    return p;
  }

  spawnHelper({ by, name = '', role = '', task = '' }) {
    const leader = this.leaderCheck(by);
    const leaderName = leader ? leader.name : (by?.label || 'Local API');
    const src = leader || this.profile(this.profiles[0].id);
    if (!src.model) throw new Error('The first agent has no model yet. Choose a model in the assistant panel first.');
    const helpers = this.profiles.filter(p => p.spawnedBy === leaderName);
    if (helpers.length >= MAX_HELPERS) throw new Error(`${leaderName} already has ${MAX_HELPERS} helpers. Give one of them a new task, or remove one with team_remove.`);
    if (src.runner === 'builtin' && this.slotsFor(src.model) >= MAX_PER_MODEL) throw new Error(`${MAX_PER_MODEL} agents already share this model, which is the most the graphics card can serve at once.`);
    const id = this.add({ from: src.id, name: name || 'Helper' });
    const p = this.profiles.find(x => x.id === id);
    Object.assign(p, { role: String(role).slice(0, 4000), spawnedBy: leaderName, canLead: false });
    this.ws.saveSettings();
    if (this.agents) { this.agents.colorFor(p.name); this.agents.update(p.name, { canTrade: false }); }
    this.changed(true);
    if (task) this.assign(id, task, by);
    return { id, name: p.name };
  }

  assign(id, task, by) {
    const a = this.members.get(id);
    if (!a) throw new Error(`No agent with id ${id}. Call team_list.`);
    if (by && by.id === id) throw new Error('An agent cannot give itself a task.');
    if (a.busy) throw new Error(`${a.name} is still working. Wait for it with team_wait, or pick another agent.`);
    const text = String(task || '').trim();
    if (!text) throw new Error('The task is empty.');
    a.taskFrom = a.log.length;
    a.taskBy = by?.label || '';
    a.send(by?.label ? `[Task from ${by.label}]\n${text}` : text).catch(e => this.emit('event', { type: 'error', text: e.message, agent: id }));
    return { id, name: a.name, started: true };
  }

  // What an agent produced for its latest task.
  result(id) {
    const a = this.members.get(id);
    if (!a) throw new Error(`No agent with id ${id}. Call team_list.`);
    const since = a.log.slice(a.taskFrom || 0);
    const answer = [...since].reverse().find(e => e.type === 'assistant');
    const problem = [...since].reverse().find(e => e.type === 'error' || (e.type === 'notice' && /^Stopped/.test(e.text)));
    const steps = since.filter(e => e.type === 'tool');
    return {
      id, name: a.name, busy: a.busy, status: a.busy ? 'working' : problem ? 'stopped' : answer ? 'done' : 'idle',
      answer: answer ? answer.text.slice(0, 6000) : '', problem: problem ? problem.text.slice(0, 600) : '',
      steps: steps.length, lastStep: steps.length ? steps.at(-1).name : '',
    };
  }

  // Waits until the given agents (default: the leader's helpers) are idle, then returns their results.
  async wait({ ids, timeoutS = 300, by }) {
    const leaderName = by && this.members.has(by.id) ? this.profile(by.id).name : (by?.label || 'Local API');
    const targets = (ids && ids.length ? ids : this.profiles.filter(p => p.spawnedBy === leaderName).map(p => p.id)).filter(id => this.members.has(id));
    if (!targets.length) throw new Error('No agents to wait for. Create helpers with team_spawn first.');
    const caller = by && this.members.get(by.id);
    const deadline = Date.now() + Math.min(Math.max(Number(timeoutS) || 300, 5), 1800) * 1000;
    while (Date.now() < deadline && targets.some(id => this.members.get(id)?.busy)) {
      if (this.isPaused() || caller?.abort?.signal.aborted) break;
      await new Promise(r => setTimeout(r, 500));
    }
    return { finished: targets.every(id => !this.members.get(id)?.busy), agents: targets.map(id => this.result(id)) };
  }

  removeHelper(id, by) {
    const p = this.profiles.find(x => x.id === id);
    if (!p) throw new Error(`No agent with id ${id}.`);
    if (!p.spawnedBy) throw new Error(`${p.name} was made by the user; only the user can remove it.`);
    if (by && this.members.has(by.id) && this.profile(by.id).name !== p.spawnedBy) throw new Error(`${p.name} is a helper of ${p.spawnedBy}, not yours.`);
    return this.remove(id);
  }

  // ---------- one browser, one agent ----------
  // An agent that works in a browser owns it until its task ends. Another agent that
  // tries to use or close it gets a refusal telling it to open its own window.
  claim(agentId, tool, args) {
    const id = args?.id;
    if (!id || !(tool.startsWith('browser_') || tool === 'item_close')) return null;
    if (this.ws.getItem(id)?.type !== 'browser') return null;
    const owner = this.claims.get(id);
    if (owner && owner !== agentId && this.members.get(owner)?.busy) {
      return `This browser (${id}) is being used by ${this.profile(owner).name}. Do not use it: open your own window with browser_open, or wait until ${this.profile(owner).name} is done.`;
    }
    if (tool !== 'item_close') this.claims.set(id, agentId);
    return null;
  }

  claimOpened(agentId, resultText) {
    try { const id = JSON.parse(resultText).id; if (id) this.claims.set(id, agentId); } catch { /* not JSON */ }
  }

  release(agentId) {
    for (const [item, owner] of this.claims) if (owner === agentId) this.claims.delete(item);
  }

  // Windows another agent is working in right now (itemId -> agent name).
  busyItems(exceptId) {
    const me = this.profile(exceptId).name;
    const out = new Map();
    for (const [item, owner] of this.claims) if (owner !== exceptId && this.members.get(owner)?.busy) out.set(item, this.profile(owner).name);
    for (const a of this.agents ? this.agents.list() : []) if (a.status === 'working' && a.itemId && a.name !== me && !out.has(a.itemId)) out.set(a.itemId, a.name);
    return out;
  }

  // ---------- talking to agents while they work ----------
  // One message for several agents. An idle agent starts on it; a busy one reads it
  // before its next step (so "tell me your findings" reaches agents in the middle of a task).
  broadcast(ids, text, from = '') {
    const t = String(text || '').trim();
    if (!t) throw new Error('The message is empty.');
    const targets = (ids && ids.length ? ids : this.profiles.map(p => p.id)).filter(id => this.members.has(id));
    const out = [];
    for (const id of targets) {
      const a = this.members.get(id);
      if (a.busy) { a.deliver(t, from || 'You'); out.push({ id, name: a.name, delivered: 'during its task' }); continue; }
      if (!a.config.model) { out.push({ id, name: a.name, delivered: 'no model' }); continue; }
      a.send(from ? `[Message from ${from}]\n${t}` : t).catch(e => this.emit('event', { type: 'error', text: e.message, agent: id }));
      out.push({ id, name: a.name, delivered: 'started' });
    }
    return out;
  }

  // Asks busy agents (default: all of them, or a leader's helpers) to finish and report.
  wrapUp({ ids, by } = {}) {
    const leaderName = by && this.members.has(by.id) ? this.profile(by.id).name : (by?.label || '');
    let targets = ids && ids.length ? ids : leaderName ? this.profiles.filter(p => p.spawnedBy === leaderName).map(p => p.id) : this.profiles.map(p => p.id);
    targets = targets.filter(id => this.members.get(id)?.busy && (!by || id !== by.id));
    for (const id of targets) this.members.get(id).deliver(WRAP_UP, leaderName || 'the user', { wrapUp: true });
    return { asked: targets.map(id => ({ id, name: this.members.get(id).name })) };
  }

  // A leader telling agents something while they work (team_message).
  message({ ids, text, wrapUp = false, by }) {
    if (wrapUp) return this.wrapUp({ ids, by });
    const leaderName = by && this.members.has(by.id) ? this.profile(by.id).name : (by?.label || 'Local API');
    const targets = (ids && ids.length ? ids : this.profiles.filter(p => p.spawnedBy === leaderName).map(p => p.id)).filter(id => this.members.has(id) && (!by || id !== by.id));
    if (!targets.length) throw new Error('No agents to message. Give ids from team_list.');
    return { sent: this.broadcast(targets, text, leaderName) };
  }

  // ---------- token counter ----------
  countTokens(name, { input = 0, output = 0 } = {}) {
    const t = this.tokens;
    t.in += input; t.out += output; t.steps += 1;
    const a = (t.byAgent[name] ||= { in: 0, out: 0, steps: 0 });
    a.in += input; a.out += output; a.steps += 1;
    if (this._tokTimer) return;
    this._tokTimer = setTimeout(() => { this._tokTimer = null; writeJson(this.tokenFile, this.tokens); this.emit('tokens', this.tokenSummary()); }, 700);
  }

  tokenSummary() {
    const t = this.tokens;
    return { since: t.since, in: t.in, out: t.out, total: t.in + t.out, steps: t.steps, byAgent: Object.entries(t.byAgent).map(([name, v]) => ({ name, ...v, total: v.in + v.out })).sort((a, b) => b.total - a.total) };
  }

  resetTokens() {
    this.tokens = { since: new Date().toISOString(), in: 0, out: 0, steps: 0, byAgent: {} };
    writeJson(this.tokenFile, this.tokens);
    this.emit('tokens', this.tokenSummary());
    return this.tokenSummary();
  }

  // Reset space: every agent but the first is removed, the first starts with an empty chat.
  resetAll() {
    this.stop();
    const first = this.profiles[0];
    for (const p of this.profiles.slice(1)) {
      const a = this.members.get(p.id);
      if (a) fs.rmSync(a.file, { force: true });
      this.members.delete(p.id);
    }
    this.ws.settings.team = [{ ...first, name: 'Assistant', role: '', canLead: false }];
    delete this.ws.settings.team[0].spawnedBy;
    this.ws.saveSettings();
    this.claims.clear();
    this.primary.reset();
    this.resetTokens();
    this.changed(true);
  }

  // ---------- the single-assistant surface older code still uses ----------
  get busy() { return [...this.members.values()].some(a => a.busy); }
  get log() { return this.primary.log; }
  get config() { return this.primary.config; } // saved tasks check the first agent's model
  send(text) { return this.primary.send(text); }
  stop() { for (const a of this.members.values()) a.stop(); }
  reset() { for (const a of this.members.values()) a.reset(); }
  detect() { return this.primary.detect(); }
  listModels(...a) { return this.primary.listModels(...a); }
  modelInfo(...a) { return this.primary.modelInfo(...a); }

  changed(now = false) {
    if (now) { clearTimeout(this._timer); this._timer = null; this.emit('changed', this.list()); return; }
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.emit('changed', this.list()); }, 250);
  }
}

module.exports = { Team, MAX_AGENTS, MAX_HELPERS, MAX_PER_MODEL };
