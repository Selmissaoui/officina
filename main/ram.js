'use strict';
// Memory meter for the toolbar: how full the computer's memory is, and how much of it
// Officina uses itself (the app, its Brave browsers and the built-in model engine).
// Brave and the engine are separate programs, so their share is read from Windows every
// few seconds (only while they run), counting each started process and its children.
const os = require('os');
const { processList } = require('./platform');

const EXTRA_EVERY = 8000;

// Sum of the working sets of the given root processes and all their descendants, split by program name.
function treeTotals(rows, roots) {
  const kids = new Map();
  for (const r of rows) {
    if (!kids.has(r.ParentProcessId)) kids.set(r.ParentProcessId, []);
    kids.get(r.ParentProcessId).push(r);
  }
  const byPid = new Map(rows.map(r => [r.ProcessId, r]));
  const seen = new Set(), out = {};
  const walk = r => {
    if (!r || seen.has(r.ProcessId)) return;
    seen.add(r.ProcessId);
    const name = String(r.Name || '').toLowerCase().replace(/\.exe$/, '');
    out[name] = (out[name] || 0) + Number(r.WorkingSetSize || 0);
    for (const k of kids.get(r.ProcessId) || []) walk(k);
  };
  for (const pid of roots) walk(byPid.get(pid));
  return out;
}

class RamMeter {
  constructor({ app, extraPids = () => [] }) {
    this.app = app;
    this.extraPids = extraPids;
    this.extra = {};
    this.timer = null;
    this.busy = false;
  }

  start() {
    this.timer = setInterval(() => this.readExtra(), EXTRA_EVERY);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  readExtra() {
    const roots = this.extraPids();
    if (!roots.length) { this.extra = {}; return; }
    if (this.busy) return;
    this.busy = true;
    processList(['brave', 'llama-server'], (err, rows) => {
      this.busy = false;
      if (!err) this.extra = treeTotals(rows, roots);
    });
  }

  read() {
    const total = os.totalmem(), free = os.freemem();
    let appBytes = 0;
    try { for (const m of this.app.getAppMetrics()) appBytes += (m.memory?.workingSetSize || 0) * 1024; } catch { /* not in Electron */ }
    return {
      total, used: total - free, app: appBytes,
      brave: this.extra.brave || 0, engine: this.extra['llama-server'] || 0,
      officina: appBytes + (this.extra.brave || 0) + (this.extra['llama-server'] || 0),
    };
  }
}

module.exports = { RamMeter, treeTotals };
