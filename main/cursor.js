'use strict';
// The AI's own on-screen cursor. It is purely visual and lives in the canvas
// UI; the user's real mouse is never moved. Before every agent input the
// cursor glides to the target and shows what happens (click ripple, typed
// text, key press, scroll), so the user can follow along. When the user turns
// it off, actions run immediately without the animation delay.
const { AsyncLocalStorage } = require('async_hooks');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Which agent is acting (an MCP connection or the built-in assistant). Tool
// calls run inside agentStore.run(...), so every cursor event knows its agent.
const agentStore = new AsyncLocalStorage();
const DEFAULT_AGENT = { id: 'agent', label: 'AI' };

// Offset from an item's top-left corner to its content area (1px border + 38px header).
const BORDER = 1;
const HEAD = 39;
const SPEED = { fast: 0.45, normal: 1, slow: 2.4 };

class AiCursor {
  constructor({ ws, send }) {
    this.ws = ws;
    this.send = send;
    this.positions = new Map(); // agent id -> world coordinates of that cursor's tip
  }

  get agent() {
    const a = agentStore.getStore() || DEFAULT_AGENT;
    return { ...a, color: this.colorFor ? this.colorFor(a.label) : undefined };
  }

  get pos() {
    return this.positions.get(this.agent.id) || null;
  }

  set pos(v) {
    this.positions.set(this.agent.id, v);
  }

  get opts() {
    const c = this.ws.settings.ui?.cursor || {};
    return { show: c.show !== false, speed: SPEED[c.speed] ? c.speed : 'normal', follow: !!c.follow, captions: c.captions !== false };
  }

  get enabled() {
    return this.opts.show;
  }

  pageToWorld(itemId, px, py) {
    const it = this.ws.getItem(itemId);
    if (!it) return null;
    return { x: it.x + BORDER + px, y: it.y + HEAD + py };
  }

  itemPoint(itemId, where = 'center') {
    const it = this.ws.getItem(itemId);
    if (!it) return null;
    if (where === 'header') return { x: it.x + Math.min(it.w / 2, 160), y: it.y + 19 };
    if (where === 'urlbar') return { x: it.x + Math.min(it.w * 0.35, 220), y: it.y + 19 };
    return { x: it.x + it.w / 2, y: it.y + it.h / 2 };
  }

  // Animate to a world point. Returns the animation time in ms (0 when off);
  // the caller decides whether to wait for it.
  move(world, { caption, itemId } = {}) {
    if (!world) return 0;
    const o = this.opts;
    const from = this.pos;
    this.pos = world;
    if (!o.show) return 0;
    const scale = this.ws.state.viewport?.scale || 1;
    const dist = from ? Math.hypot(world.x - from.x, world.y - from.y) * scale : 260;
    const k = SPEED[o.speed];
    const ms = Math.round(Math.min(950, Math.max(140, 160 + dist * 0.5)) * k);
    this.send('cursor', { kind: 'move', from, to: world, ms, caption: o.captions ? caption : null, itemId, follow: o.follow, agent: this.agent });
    return ms;
  }

  async moveAndWait(world, opts) {
    const ms = this.move(world, opts);
    if (ms) await sleep(ms);
  }

  // One-off visual events at the current position: click, key, type, scroll, point.
  event(kind, data = {}) {
    const o = this.opts;
    // "point" is a message meant for the user, so it shows even with the cursor hidden.
    if ((!o.show && kind !== 'point') || !this.pos) return 0;
    if (!o.captions) delete data.caption;
    this.send('cursor', { kind, at: this.pos, ...data, speed: o.speed, agent: this.agent });
    return { click: 160, key: 140, scroll: 120, type: 0, point: 0, drag: 0 }[kind] * SPEED[o.speed] || 0;
  }

  async pause(base) {
    if (this.enabled) await sleep(Math.round(base * SPEED[this.opts.speed]));
  }

  hide() {
    this.send('cursor', { kind: 'hide' });
  }
}

module.exports = { AiCursor, HEAD, BORDER, agentStore };
