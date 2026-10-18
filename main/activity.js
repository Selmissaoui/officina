'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { appendJsonl, readJsonl } = require('./store');

const localDay = iso => {
  const d = iso ? new Date(iso) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Append-only record of everything agents (and notable user actions) did.
// Keeps running per-action counters so stats never need a full re-read.
class Activity extends EventEmitter {
  constructor(root) {
    super();
    this.file = path.join(root, 'activity.jsonl');
    const all = readJsonl(this.file);
    this.recent = all.slice(-300);
    this.totals = {};
    this.byDay = {};
    for (const e of all) this._count(e);
  }

  _count(e) {
    const key = `${e.actor}:${e.action}`;
    this.totals[key] = (this.totals[key] || 0) + 1;
    const day = localDay(e.time);
    const d = (this.byDay[day] ||= {});
    d[key] = (d[key] || 0) + 1;
  }

  log(actor, action, detail = '', extra = {}) {
    const entry = { time: new Date().toISOString(), actor, action, detail: String(detail).slice(0, 500), ...extra };
    this.recent.push(entry);
    if (this.recent.length > 500) this.recent.splice(0, this.recent.length - 300);
    this._count(entry);
    try { appendJsonl(this.file, entry); } catch { /* disk full etc. must not break the app */ }
    this.emit('entry', entry);
    return entry;
  }

  list(limit = 200) {
    return this.recent.slice(-limit);
  }

  // Sum counters whose "actor:action" key matches a predicate, overall and today.
  count(pred) {
    const today = this.byDay[localDay()] || {};
    let total = 0, day = 0;
    for (const [k, v] of Object.entries(this.totals)) if (pred(k)) total += v;
    for (const [k, v] of Object.entries(today)) if (pred(k)) day += v;
    return { total, today: day };
  }

  clear() {
    this.recent = [];
    this.totals = {};
    this.byDay = {};
    fs.rmSync(this.file, { force: true });
  }
}

module.exports = { Activity, localDay };
