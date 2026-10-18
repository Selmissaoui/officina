'use strict';
// Registry of the AI agents that work in the canvas: every connected MCP app
// (by its client name) and the built-in assistant. Each agent keeps a fixed
// colour (its cursor, its window highlight, its log entries), can be paused on
// its own and can be kept away from trading, while the global STOP still
// stops everything.
const { EventEmitter } = require('events');

const COLORS = ['#0d7468', '#d9480f', '#7048e8', '#1971c2', '#c2255c', '#2f9e44', '#f08c00', '#5f3dc4'];
const TRADE_TOOLS = new Set(['trading_place_order', 'trading_cancel_order']);

class Agents extends EventEmitter {
  constructor(ws) {
    super();
    this.ws = ws;
    this.live = new Map(); // name -> { lastSeen, lastAction, itemId, sessions:Set }
    this._timer = null;
    this.builtIns = () => ['Assistant']; // the team replaces this with its agents' names
    this.busyOf = () => false;            // and this with "is that built-in agent working right now"
  }

  get saved() {
    return (this.ws.settings.agents ||= {});
  }

  ensure(name) {
    name = String(name || 'Agent').slice(0, 24);
    if (!this.saved[name]) {
      const used = new Set(Object.values(this.saved).map(a => a.color));
      const color = COLORS.find(c => !used.has(c)) || COLORS[Object.keys(this.saved).length % COLORS.length];
      this.saved[name] = { color, paused: false, canTrade: true, actions: 0, firstSeen: new Date().toISOString() };
      this.ws.saveSettings();
      this.changed();
    }
    return { name, ...this.saved[name] };
  }

  colorFor(name) {
    return this.ensure(name).color;
  }

  // Called before a tool runs: returns an error message when this agent may not do it.
  blocked(name, tool) {
    const a = this.ensure(name);
    if (a.paused && tool !== 'workspace_overview') return `${name} is paused by the user. Wait until the user resumes this agent.`;
    if (!a.canTrade && TRADE_TOOLS.has(tool)) return `${name} is not allowed to trade. The user can allow it in the Agents panel.`;
    return null;
  }

  touch(name, tool, itemId, sessionId) {
    const a = this.ensure(name);
    const l = this.live.get(a.name) || { sessions: new Set() };
    l.lastSeen = Date.now();
    l.lastAction = tool;
    if (itemId) l.itemId = itemId;
    if (sessionId) l.sessions.add(sessionId);
    this.live.set(a.name, l);
    this.saved[a.name].actions = (this.saved[a.name].actions || 0) + 1;
    this.saved[a.name].lastSeen = new Date().toISOString();
    this.changed();
  }

  update(name, patch) {
    const a = this.saved[name];
    if (!a) throw new Error(`No agent called ${name}`);
    if (patch.paused !== undefined) a.paused = !!patch.paused;
    if (patch.canTrade !== undefined) a.canTrade = !!patch.canTrade;
    if (patch.color && /^#[0-9a-f]{6}$/i.test(patch.color)) a.color = patch.color;
    this.ws.saveSettings();
    this.changed(true);
    return this.list();
  }

  // Keeps colour, permissions and counts when a built-in agent is renamed.
  rename(from, to) {
    if (!this.saved[from] || from === to) return;
    this.saved[to] = { ...this.saved[from] };
    delete this.saved[from];
    if (this.live.has(from)) { this.live.set(to, this.live.get(from)); this.live.delete(from); }
    this.ws.saveSettings();
    this.changed(true);
  }

  forget(name) {
    if (this.builtIns().includes(name)) throw new Error('Built-in agents are always listed. Remove the agent in the assistant panel instead.');
    delete this.saved[name];
    this.live.delete(name);
    this.ws.saveSettings();
    this.changed(true);
    return this.list();
  }

  // Reset space: everyone is forgotten; the built-in agents come back with fresh colours.
  resetAll() {
    this.ws.settings.agents = {};
    this.live.clear();
    this.ws.saveSettings();
    this.changed(true);
  }

  list() {
    const now = Date.now();
    for (const name of this.builtIns()) this.ensure(name);
    return Object.entries(this.saved).map(([name, a]) => {
      const l = this.live.get(name) || {};
      const idle = l.lastSeen ? now - l.lastSeen : Infinity;
      const item = l.itemId ? this.ws.getItem(l.itemId) : null;
      return {
        name, color: a.color, paused: !!a.paused, canTrade: a.canTrade !== false, actions: a.actions || 0,
        // Built-in agents are always there: working while their task runs (a model can think
        // for a minute between steps), otherwise idle. Outside apps count as away after 10 minutes.
        status: a.paused ? 'paused' : this.builtIns().includes(name) ? (this.busyOf(name) ? 'working' : 'idle') : idle < 15000 ? 'working' : idle < 10 * 60e3 ? 'idle' : 'away',
        lastSeen: l.lastSeen ? new Date(l.lastSeen).toISOString() : a.lastSeen || null,
        lastAction: l.lastAction || null, itemId: item ? item.id : null, itemTitle: item ? item.title : null,
        builtIn: this.builtIns().includes(name),
      };
    }).sort((x, y) => (y.status === 'working') - (x.status === 'working') || String(y.lastSeen || '').localeCompare(String(x.lastSeen || '')));
  }

  // Coalesce bursts of activity into one UI update.
  changed(now = false) {
    if (now) { clearTimeout(this._timer); this._timer = null; this.emit('changed', this.list()); return; }
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.emit('changed', this.list()); }, 400);
  }
}

module.exports = { Agents, TRADE_TOOLS };
