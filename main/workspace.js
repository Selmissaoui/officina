'use strict';
// The workspace is the container: every piece of state the app produces lives
// under one data directory. Agents and the UI only ever reach files through
// safePath(), which refuses anything that resolves outside files/.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { readJson, writeJson, readJsonl, newId } = require('./store');

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.js', '.ts', '.py', '.html', '.css', '.xml', '.yaml', '.yml', '.ini', '.toml', '.sql', '.sh', '.bat', '.ps1']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

function fileKind(rel) {
  const ext = path.extname(rel).toLowerCase();
  if (rel.startsWith('screenshots/')) return 'screenshot';
  if (rel.startsWith('downloads/')) return 'download';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'other';
}

function previewKind(rel) {
  const ext = path.extname(rel).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'other';
}

class Workspace extends EventEmitter {
  constructor(root) {
    super();
    this.root = root;
    this.dirs = {
      files: path.join(root, 'files'),
      notes: path.join(root, 'notes'),
      secrets: path.join(root, 'secrets'),
    };
    this.stateFile = path.join(root, 'state.json');
    this.metaFile = path.join(root, 'meta.json');
    this.settingsFile = path.join(root, 'settings.json');
    this.tradesFile = path.join(root, 'trades.jsonl');
    this._saveTimer = null;
  }

  init() {
    for (const d of Object.values(this.dirs)) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(this.root, 'README.txt'),
      'Officina workspace.\r\nEverything the app saves lives in this folder: notes/, files/, browser profiles (chromium/),\r\n' +
      'encrypted API keys and session cookies (secrets/), the trade log and the activity log.\r\nDelete this folder to wipe the workspace completely.\r\n');
    this.state = readJson(this.stateFile, null) || { items: [], closedBrowsers: [], viewport: { x: 0, y: 0, scale: 1 }, z: 1 };
    this.state.closedBrowsers ||= [];
    this.state.spaces ||= [{ id: 'default', name: 'Main', viewport: this.state.viewport }];
    this.state.activeSpace ||= 'default';
    for (const item of this.state.items) item.spaceId ||= 'default';
    this.meta = readJson(this.metaFile, {});
    this.settings = readJson(this.settingsFile, {});
  }

  // ---------- persistence ----------
  saveSoon() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 250);
  }

  saveNow() {
    clearTimeout(this._saveTimer);
    writeJson(this.stateFile, this.state);
    writeJson(this.metaFile, this.meta);
  }

  saveSettings() {
    writeJson(this.settingsFile, this.settings);
  }

  // ---------- canvas items ----------
  listItems() {
    return this.state.items.filter(i => (i.spaceId || 'default') === (this.state.activeSpace || 'default'));
  }

  getItem(id) {
    return this.state.items.find(i => i.id === id) || null;
  }

  requireItem(id, type) {
    const item = this.getItem(id);
    if (!item) throw new Error(`No canvas item with id "${id}". Call workspace_overview to see the open items.`);
    if (type && item.type !== type) throw new Error(`Item "${id}" is a ${item.type}, not a ${type}.`);
    return item;
  }

  nextZ() {
    this.state.z = (this.state.z || 1) + 1;
    return this.state.z;
  }

  // Nearest free spot to a hint (default: centre of the user's view), so new
  // windows never land on top of existing ones. exceptId leaves out the item being moved.
  placement(w, h, hint, exceptId = null) {
    const v = this.state.viewport;
    const viewW = (this.state.viewSize?.w || 1600) / v.scale;
    const viewH = (this.state.viewSize?.h || 900) / v.scale;
    const start = hint || { x: -v.x / v.scale + viewW / 2 - w / 2, y: -v.y / v.scale + viewH / 2 - h / 2 };
    const gap = 24;
    const free = (x, y) => this.listItems().filter(i => i.type !== 'frame' && i.id !== exceptId).every(i => x + w + gap <= i.x || i.x + i.w + gap <= x || y + h + gap <= i.y || i.y + i.h + gap <= y);
    if (free(start.x, start.y)) return { x: Math.round(start.x), y: Math.round(start.y) };
    const step = 40;
    for (let ring = 1; ring < 80; ring++) {
      const candidates = [];
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        candidates.push({ x: start.x + dx * step, y: start.y + dy * step, d: Math.hypot(dx, dy * 1.4) });
      }
      candidates.sort((a, b) => a.d - b.d);
      const hit = candidates.find(c => free(c.x, c.y));
      if (hit) return { x: Math.round(hit.x), y: Math.round(hit.y) };
    }
    return { x: Math.round(start.x), y: Math.round(start.y) };
  }

  addItem(partial, actor = 'user') {
    const defaults = {
      browser: { w: 900, h: 640, title: 'Browser', url: 'https://duckduckgo.com' },
      frame: { w: 1000, h: 760, title: 'Group', color: 'blue' },
      widget: { w: 360, h: 300, title: 'Widget', widget: 'price', symbol: 'BTC/USDT', accountId: 'paper' },
      note: { w: 340, h: 300, title: 'Note', color: 'yellow' },
      file: { w: 520, h: 440 },
      folder: { w: 340, h: 420 },
    }[partial.type];
    if (!defaults) throw new Error(`Unknown item type ${partial.type}`);
    const id = partial.id || newId(partial.type[0]);
    const item = { ...defaults, ...partial, spaceId: this.state.activeSpace || 'default', id, createdBy: actor, createdAt: new Date().toISOString(), z: this.nextZ() };
    for (const k of ['x', 'y', 'w', 'h']) if (item[k] == null || !Number.isFinite(Number(item[k]))) delete item[k]; else item[k] = Number(item[k]);
    item.w ??= defaults.w || 500;
    item.h ??= defaults.h || 420;
    if (item.x == null || item.y == null) Object.assign(item, this.placement(item.w, item.h, partial.hint));
    // An agent's own position is a wish, not an order: it never lands on another window.
    else if (actor === 'agent' && item.type !== 'frame') Object.assign(item, this.placement(item.w, item.h, { x: item.x, y: item.y }));
    delete item.hint;
    if (item.type === 'browser') {
      item.profile ||= id;
      // A profile lives in one browser engine: windows that share it, or reopen it, use the same one.
      const twin = this.state.items.find(i => i.type === 'browser' && i.profile === item.profile) || this.state.closedBrowsers.find(b => b.profile === item.profile);
      if (twin) item.engine = twin.engine || 'builtin';
      else item.engine = item.engine === 'brave' || item.engine === 'builtin' ? item.engine : (this.browserEngine ? this.browserEngine() : 'builtin');
    }
    if (item.type === 'note' && !fs.existsSync(this.notePath(id))) this.writeNote(id, partial.content || '', actor, item.title);
    delete item.content;
    if (item.type === 'browser') this.state.closedBrowsers = this.state.closedBrowsers.filter(b => b.profile !== item.profile);
    if (this.getItem(id)) throw new Error('An item with this ID already exists');
    if (item.type === 'frame') item.z = 0;
    this.state.items.push(item);
    this.saveSoon();
    this.emit('item:upsert', item, actor);
    return item;
  }

  updateItem(id, patch, actor = 'user') {
    const item = this.getItem(id);
    if (!item) return null;
    const allowed = ['x', 'y', 'w', 'h', 'z', 'title', 'url', 'color', 'linkedKey', 'collapsed', 'locked', 'renamed', 'muted', 'zoom', 'tabs', 'activeTab', 'symbol', 'accountId', 'widget', 'spaceId'];
    for (const k of allowed) if (patch[k] !== undefined) item[k] = patch[k];
    if (patch.raise) item.z = this.nextZ();
    if (item.type === 'note' && patch.title !== undefined) this.touchNoteMeta(id, { title: patch.title });
    this.saveSoon();
    this.emit('item:upsert', item, actor);
    return item;
  }

  removeItem(id, actor = 'user') {
    const item = this.getItem(id);
    if (!item) return false;
    this.state.items = this.state.items.filter(i => i.id !== id);
    // Closing a window never throws data away: notes and files stay in the
    // library, and a closed browser keeps its profile so the login survives.
    if (item.type === 'browser') {
      this.state.closedBrowsers = this.state.closedBrowsers.filter(b => b.profile !== item.profile);
      this.state.closedBrowsers.unshift({ profile: item.profile, title: item.title, url: item.url, engine: item.engine || 'builtin', closedAt: new Date().toISOString() });
    }
    this.saveSoon();
    this.emit('item:remove', id, actor);
    return true;
  }

  profiles() {
    const set = new Set(this.state.items.filter(i => i.type === 'browser').map(i => i.profile));
    for (const b of this.state.closedBrowsers) set.add(b.profile);
    return [...set];
  }

  // ---------- notes ----------
  notePath(id) {
    if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error('Invalid note id');
    return path.join(this.dirs.notes, `${id}.md`);
  }

  readNote(id) {
    try {
      return fs.readFileSync(this.notePath(id), 'utf8');
    } catch {
      return '';
    }
  }

  writeNote(id, content, actor = 'user', title) {
    fs.writeFileSync(this.notePath(id), content);
    this.touchNoteMeta(id, { title, actor });
    this.emit('note:changed', id, content, actor);
  }

  touchNoteMeta(id, { title, actor } = {}) {
    const key = `notes/${id}.md`;
    const now = new Date().toISOString();
    const m = (this.meta[key] ||= { createdBy: actor || 'user', createdAt: now });
    m.updatedAt = now;
    if (actor) m.updatedBy = actor;
    if (title !== undefined) m.title = title;
    this.saveSoon();
  }

  // ---------- files ----------
  safePath(rel) {
    if (typeof rel !== 'string' || !rel.trim()) throw new Error('A file path is required');
    const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    // A drive letter is an absolute Windows path: refused on every platform, so agents behave the same everywhere.
    if (/^[a-z]:/i.test(clean)) throw new Error('Path is outside the workspace; agents can only use files inside the workspace.');
    const abs = path.resolve(this.dirs.files, clean);
    const base = path.resolve(this.dirs.files);
    if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('Path is outside the workspace; agents can only use files inside the workspace.');
    // Lexical containment alone does not stop links/junctions escaping files/.
    // Check existing ancestors too, including when creating a new nested file.
    let current = base;
    for (const part of ['', ...path.relative(base, abs).split(path.sep).filter(Boolean)]) {
      current = path.join(current, part);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are outside the workspace file boundary');
      } catch (error) {
        if (error.code === 'ENOENT') break;
        throw error;
      }
    }
    return abs;
  }

  relPath(abs) {
    return path.relative(this.dirs.files, abs).split(path.sep).join('/');
  }

  uniqueRel(rel) {
    let candidate = rel;
    const ext = path.extname(rel);
    const stem = rel.slice(0, rel.length - ext.length);
    for (let n = 2; fs.existsSync(this.safePath(candidate)); n++) candidate = `${stem} (${n})${ext}`;
    return candidate;
  }

  writeFile(rel, data, actor = 'user', extraMeta = {}) {
    const abs = this.safePath(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    const key = this.relPath(abs);
    const now = new Date().toISOString();
    const prev = this.meta[`files/${key}`];
    this.meta[`files/${key}`] = { ...prev, createdBy: prev?.createdBy || actor, createdAt: prev?.createdAt || now, updatedAt: now, updatedBy: actor, ...extraMeta };
    this.saveSoon();
    this.emit('library:changed');
    return key;
  }

  recordFile(rel, actor, extraMeta = {}) {
    const now = new Date().toISOString();
    this.meta[`files/${rel}`] = { createdBy: actor, createdAt: now, updatedAt: now, ...extraMeta };
    this.saveSoon();
    this.emit('library:changed');
  }

  readFile(rel) {
    return fs.readFileSync(this.safePath(rel));
  }

  listDir(rel = '') {
    const abs = this.safePath(rel || '.');
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs, { withFileTypes: true })
      .filter(d => !d.isSymbolicLink() && !d.name.endsWith('.tmp'))
      .map(d => {
        const childRel = rel ? `${rel.replace(/\/+$/, '')}/${d.name}` : d.name;
        const st = fs.statSync(path.join(abs, d.name));
        return { name: d.name, path: childRel, dir: d.isDirectory(), size: st.size, modified: st.mtime.toISOString(), kind: d.isDirectory() ? 'folder' : previewKind(childRel) };
      })
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  }

  walkFiles(dir = this.dirs.files, out = []) {
    this.safePath(this.relPath(dir) || '.');
    if (!fs.existsSync(dir)) return out;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isSymbolicLink()) continue;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) this.walkFiles(abs, out);
      else if (!d.name.endsWith('.tmp')) out.push(abs);
    }
    return out;
  }

  // Copy files/folders from the real filesystem INTO the container. The
  // originals are never touched afterwards.
  importPaths(paths, actor = 'user', destDir = '') {
    const imported = [];
    for (const src of paths) {
      const st = fs.statSync(src);
      const base = path.basename(src);
      const rel = this.uniqueRel(destDir ? `${destDir}/${base}` : base);
      const dest = this.safePath(rel);
      if (st.isDirectory()) {
        fs.cpSync(src, dest, { recursive: true });
        for (const f of this.walkFiles(dest)) this.recordFile(this.relPath(f), actor, { importedFrom: src });
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        this.recordFile(rel, actor, { importedFrom: src });
      }
      imported.push({ path: rel, dir: st.isDirectory() });
    }
    return imported;
  }

  duplicateFile(rel, actor = 'user') {
    const src = this.safePath(rel);
    const copy = this.uniqueRel(rel);
    fs.copyFileSync(src, this.safePath(copy));
    this.recordFile(copy, actor, { copiedFrom: rel });
    return copy;
  }

  // Counts for the status screen. Notes/files come from the metadata so
  // things the user made by hand count too, not only agent actions.
  stats(localDay) {
    const today = localDay();
    let notes = 0, notesToday = 0, files = 0, filesToday = 0, screenshots = 0;
    for (const [key, m] of Object.entries(this.meta)) {
      const isToday = m.createdAt && localDay(m.createdAt) === today;
      if (key.startsWith('notes/')) { notes++; if (isToday) notesToday++; }
      else if (key.startsWith('files/screenshots/')) screenshots++;
      else if (key.startsWith('files/') && !key.startsWith('files/downloads/')) { files++; if (isToday) filesToday++; }
    }
    let trades = 0, tradesToday = 0;
    for (const t of readJsonl(this.tradesFile)) {
      if (t.status !== 'filled' && t.status !== 'open' && t.status !== 'submitted') continue;
      trades++;
      if (localDay(t.time) === today) tradesToday++;
    }
    return { notes, notesToday, files, filesToday, screenshots, trades, tradesToday, browsers: this.profiles().length };
  }

  // Wipe every piece of content. Settings that are about the app itself
  // (appearance, MCP port/token, disclaimer) are kept by the caller.
  // Puts like with like: browsers in one block, notes in the next, then files and folders,
  // then widgets, each under a labelled group frame. Frames made this way are marked auto
  // and are reused (or removed when their block is empty) the next time.
  organize(actor = 'user') {
    const GROUPS = [
      ['browser', 'Browsers', ['browser'], 'blue', 'browser'],
      ['note', 'Notes', ['note'], 'yellow', 'note'],
      ['file', 'Files and folders', ['file', 'folder'], 'green', 'file or folder'],
      ['widget', 'Widgets', ['widget'], 'purple', 'widget'],
    ];
    const items = this.listItems();
    const loose = items.filter(i => i.type !== 'frame');
    if (!loose.length) return { moved: 0, groups: [] };
    const PAD = 32, HEAD = 56, GAP = 28, BLOCK_GAP = 120;
    let x = Math.min(...loose.map(i => i.x)), y0 = Math.min(...loose.map(i => i.y));
    const out = [];
    const autoFrames = items.filter(i => i.type === 'frame' && i.auto);
    for (const [key, title, types, color, one] of GROUPS) {
      const list = loose.filter(i => types.includes(i.type)).sort((a, b) => (a.y - b.y) || (a.x - b.x));
      const frame = autoFrames.find(f => f.auto === key);
      if (!list.length) { if (frame) this.removeItem(frame.id, actor); continue; }
      // Rows about as wide as they are tall, so a block stays roughly square.
      const area = list.reduce((s, i) => s + (i.w + GAP) * (i.h + GAP), 0);
      const maxRow = Math.max(Math.max(...list.map(i => i.w)), Math.sqrt(area) * 1.3);
      let cx = 0, cy = 0, rowH = 0, width = 0;
      const spots = [];
      for (const it of list) {
        if (cx > 0 && cx + it.w > maxRow) { cx = 0; cy += rowH + GAP; rowH = 0; }
        spots.push([it, cx, cy]);
        cx += it.w + GAP;
        rowH = Math.max(rowH, it.h);
        width = Math.max(width, cx - GAP);
      }
      const height = cy + rowH;
      for (const [it, ox, oy] of spots) this.updateItem(it.id, { x: Math.round(x + PAD + ox), y: Math.round(y0 + HEAD + oy) }, actor);
      const box = { x: Math.round(x), y: Math.round(y0), w: Math.round(width + PAD * 2), h: Math.round(height + HEAD + PAD) };
      const label = `${title} (${list.length})`;
      if (frame) this.updateItem(frame.id, { ...box, title: label }, actor);
      else this.addItem({ type: 'frame', title: label, color, auto: key, ...box }, actor);
      out.push({ group: title, count: list.length, label: list.length === 1 ? `1 ${one}` : `${list.length} ${title.toLowerCase()}`, ...box });
      x += box.w + BLOCK_GAP;
    }
    return { moved: loose.length, groups: out };
  }

  reset() {
    for (const d of [this.dirs.files, this.dirs.notes, this.dirs.secrets]) {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
      fs.mkdirSync(d, { recursive: true });
    }
    for (const f of [this.tradesFile, path.join(this.root, 'paper.json')]) fs.rmSync(f, { force: true });
    this.state = { items: [], closedBrowsers: [], viewport: { x: 0, y: 0, scale: 1 }, z: 1, viewSize: this.state.viewSize };
    this.meta = {};
    this.saveNow();
  }

  // ---------- library ----------
  library({ query = '', kind = 'all', createdBy = 'all', limit = 500 } = {}) {
    const entries = [];
    const q = query.trim().toLowerCase();

    for (const f of fs.readdirSync(this.dirs.notes)) {
      if (!f.endsWith('.md')) continue;
      const id = f.slice(0, -3);
      const m = this.meta[`notes/${f}`] || {};
      const content = this.readNote(id);
      const item = this.getItem(id);
      entries.push({
        kind: 'note', id, name: item?.title || m.title || 'Note', path: `notes/${f}`, itemId: item ? id : null,
        createdBy: m.createdBy || 'user', createdAt: m.createdAt, updatedAt: m.updatedAt,
        snippet: content.slice(0, 160), _search: content,
      });
    }

    for (const abs of this.walkFiles()) {
      const rel = this.relPath(abs);
      const m = this.meta[`files/${rel}`] || {};
      const st = fs.statSync(abs);
      const onCanvas = this.state.items.find(i => (i.type === 'file' && i.path === rel));
      let search = '';
      if (q && previewKind(rel) === 'text' && st.size < 512 * 1024) {
        try { search = fs.readFileSync(abs, 'utf8'); } catch { /* unreadable */ }
      }
      entries.push({
        kind: fileKind(rel), name: path.basename(rel), path: rel, itemId: onCanvas?.id || null,
        createdBy: m.createdBy || 'user', createdAt: m.createdAt || st.birthtime.toISOString(), updatedAt: st.mtime.toISOString(),
        size: st.size, snippet: m.source ? `from ${m.source}` : (m.importedFrom ? `imported from ${m.importedFrom}` : ''), _search: search,
      });
    }

    for (const t of readJsonl(this.tradesFile)) {
      entries.push({
        kind: 'trade', id: t.id, name: `${t.side?.toUpperCase()} ${t.amount} ${t.symbol}`, createdBy: t.actor, createdAt: t.time,
        snippet: [t.accountLabel || t.account, t.status, t.error, t.reason].filter(Boolean).join(', '), _search: t.reason || '',
      });
    }

    for (const b of this.state.items.filter(i => i.type === 'browser')) {
      entries.push({ kind: 'browser', name: b.title, itemId: b.id, profile: b.profile, createdBy: b.createdBy, createdAt: b.createdAt, snippet: b.url });
    }
    for (const b of this.state.closedBrowsers) {
      entries.push({ kind: 'browser', name: `${b.title} (closed)`, itemId: null, profile: b.profile, url: b.url, createdBy: 'user', createdAt: b.closedAt, snippet: `${b.url}. Reopen it to continue the saved session.` });
    }

    return entries
      .filter(e => kind === 'all' || e.kind === kind || (kind === 'file' && ['image', 'pdf', 'text', 'other', 'download'].includes(e.kind)))
      .filter(e => createdBy === 'all' || (createdBy === 'agent' ? e.createdBy === 'agent' : e.createdBy !== 'agent'))
      .filter(e => !q || `${e.name} ${e.snippet} ${e.path || ''} ${e._search}`.toLowerCase().includes(q))
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
      .slice(0, limit)
      .map(({ _search, ...e }) => e);
  }
}

module.exports = { Workspace, previewKind, fileKind };
