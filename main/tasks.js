'use strict';
// Saved tasks: reusable prompts for the built-in assistant, runnable with one
// click or on a schedule ("every 15 minutes", "every day at 08:00").
// Runs are queued, so two tasks never drive the canvas at the same time.
const path = require('path');
const { EventEmitter } = require('events');
const { readJson, writeJson, newId } = require('./store');

function nextRun(task, from = new Date()) {
  const s = task.schedule;
  if (!task.enabled || !s || s.type === 'none') return null;
  if (s.type === 'once') return task.lastRunAt ? null : new Date(s.at);
  if (s.type === 'every') {
    const mins = Math.max(1, Number(s.minutes) || 60);
    const base = new Date(task.lastRunAt || task.createdAt || from);
    const t = new Date(base.getTime() + mins * 60e3);
    return t < from ? from : t;
  }
  if (s.type === 'daily') {
    const [hh, mm] = String(s.time || '08:00').split(':').map(Number);
    const t = new Date(from);
    t.setHours(hh || 0, mm || 0, 0, 0);
    const days = Array.isArray(s.days) && s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6];
    for (let i = 0; i < 8; i++) {
      const cand = new Date(t.getFullYear(), t.getMonth(), t.getDate() + i, hh || 0, mm || 0);
      if (cand > from && days.includes(cand.getDay()) && (!task.lastRunAt || new Date(task.lastRunAt) < cand)) return cand;
    }
  }
  return null;
}

class Tasks extends EventEmitter {
  constructor({ ws, assistant, notify, isPaused }) {
    super();
    this.ws = ws;
    this.assistant = assistant;
    this.notify = notify;
    this.isPaused = isPaused;
    this.file = path.join(ws.root, 'tasks.json');
    this.data = readJson(this.file, { tasks: [], runs: [] });
    for (const run of this.data.runs) if (run.status === 'running') { run.status = 'interrupted'; run.endedAt = new Date().toISOString(); }
    this.queue = [];
    this.running = null;
    this.timer = setInterval(() => this.tick(), 20000);
    this.timer.unref?.();
  }

  dispose() { this.disposed = true; clearInterval(this.timer); clearTimeout(this.retry); }
  save() { if (this.data.runs.length > 300) this.data.runs.splice(0, 100); writeJson(this.file, this.data); this.emit('changed'); }

  list() {
    return {
      tasks: this.data.tasks.map(t => ({ ...t, nextRunAt: t.nextDueAt || nextRun(t)?.toISOString() || null, queued: this.queue.includes(t.id), running: this.running === t.id })),
      runs: this.data.runs.slice(-60).reverse(),
    };
  }

  upsert(input) {
    if (input.schedule) {
      const s = input.schedule;
      if (!['none', 'every', 'daily', 'once'].includes(s.type)) throw new Error('Unknown schedule');
      if (s.type === 'every' && (!Number.isFinite(Number(s.minutes)) || Number(s.minutes) < 1)) throw new Error('Interval must be at least one minute');
      if (s.type === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) throw new Error('Use a valid HH:MM time');
      if (s.type === 'once' && !Number.isFinite(Date.parse(s.at))) throw new Error('Choose a valid date');
    }
    if (!String(input.prompt ?? this.data.tasks.find(t => t.id === input.id)?.prompt ?? '').trim()) throw new Error('A task needs instructions.');
    let t = input.id ? this.data.tasks.find(x => x.id === input.id) : null;
    if (!t) { t = { id: newId('task'), createdAt: new Date().toISOString(), enabled: true, schedule: { type: 'none' } }; this.data.tasks.push(t); }
    if (input.name !== undefined) t.name = String(input.name).slice(0, 80) || 'Task';
    if (input.prompt !== undefined) t.prompt = String(input.prompt).slice(0, 4000);
    if (input.enabled !== undefined) t.enabled = !!input.enabled;
    if (!t.enabled) this.queue = this.queue.filter(q => q !== t.id);
    if (input.schedule) t.schedule = input.schedule;
    if (input.notify !== undefined) t.notify = !!input.notify;
    if (!t.prompt) throw new Error('A task needs instructions.');
    t.nextDueAt = nextRun(t)?.toISOString() || null;
    this.save();
    return t;
  }

  remove(id) {
    this.data.tasks = this.data.tasks.filter(t => t.id !== id);
    this.queue = this.queue.filter(q => q !== id);
    this.save();
    return true;
  }

  runNow(id) {
    const task = this.data.tasks.find(t => t.id === id);
    if (!task) throw new Error('No such task');
    if (!task.enabled) throw new Error('This task is disabled. Enable it to run it.');
    if (!this.queue.includes(id) && this.running !== id) this.queue.push(id);
    this.save();
    this.pump();
    return true;
  }

  tick() {
    const now = new Date();
    for (const t of this.data.tasks) {
      if (!t.enabled) continue;
      const due = (t.nextDueAt ? new Date(t.nextDueAt) : nextRun(t, new Date(t.createdAt)));
      if (due && due <= now && !this.queue.includes(t.id) && this.running !== t.id) this.queue.push(t.id);
    }
    this.pump();
  }

  async pump() {
    if (this.disposed || this.running || !this.queue.length) return;
    if (this.isPaused()) return;
    if (!this.assistant.config.model) return; // no model chosen yet
    if (this.assistant.busy) return;
    const id = this.queue.shift();
    const t = this.data.tasks.find(x => x.id === id);
    if (!t || !t.enabled) return this.pump();
    this.running = id;
    const run = { id: newId('run'), taskId: id, name: t.name, startedAt: new Date().toISOString(), status: 'running' };
    this.data.runs.push(run);
    t.lastRunAt = run.startedAt;
    t.nextDueAt = nextRun(t)?.toISOString() || null;
    this.save();
    const before = this.assistant.log.length;
    try {
      await this.assistant.send(`[Scheduled task: ${t.name}]\n${t.prompt}`);
      const added = this.assistant.log.slice(before);
      const err = added.find(e => e.type === 'error');
      const answer = [...added].reverse().find(e => e.type === 'assistant');
      run.status = err ? 'error' : added.some(e => e.type === 'notice' && /stopped|paused/i.test(e.text)) ? 'interrupted' : 'done';
      run.summary = (err?.text || answer?.text || '').slice(0, 400);
      run.steps = added.filter(e => e.type === 'tool').length;
    } catch (e) {
      run.status = 'error';
      run.summary = e.message;
    } finally {
      run.endedAt = new Date().toISOString();
      this.running = null;
      this.save();
      if (t.notify !== false) this.notify?.('tasks', `${run.status === 'done' ? 'Task finished' : 'Task failed'}: ${t.name}`, run.summary || '');
      this.retry = setTimeout(() => this.pump(), 500);
    }
  }
}

module.exports = { Tasks, nextRun };
