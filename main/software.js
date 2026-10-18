'use strict';
// Software for the space: programs Officina downloads into Officina-Data/software and runs
// from there. Nothing is installed on the computer itself and nothing is shared with the
// user's own copy of a program (Brave here keeps its own profiles in Officina-Data/brave).
// Downloads come from the publisher's GitHub releases and are checked against the
// published SHA-256 before they are unpacked.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const platform = require('./platform');

// The Brave download for this computer: Windows x64, or a Mac with Apple Silicon or Intel.
const BRAVE_ASSET = process.platform === 'darwin'
  ? new RegExp(`^brave-v(\\d+\\.\\d+\\.\\d+)-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}\\.zip$`)
  : /^brave-v(\d+\.\d+\.\d+)-win32-x64\.zip$/;

const CATALOG = [
  {
    id: 'brave',
    name: 'Brave',
    description: 'Browser with Brave Shields. Sites that complain about ad blockers usually stay quiet in Brave, so agents get stuck less.',
    latest: 'https://api.github.com/repos/brave/brave-browser/releases/latest',
    releases: 'https://api.github.com/repos/brave/brave-browser/releases?per_page=40',
    // Brave also publishes Nightly and Beta builds here, not always marked as pre-release:
    // only releases named "Release v..." are the stable browser.
    stable: /^Release v/,
    asset: BRAVE_ASSET,
    // Where the program sits in the unpacked download.
    exe: dir => (process.platform === 'darwin'
      ? (app => (app ? path.join(app, 'Contents', 'MacOS', 'Brave Browser') : null))(platform.findBelow(dir, e => e.isDirectory() && /^Brave Browser.*\.app$/.test(e.name), 2))
      : path.join(dir, 'brave.exe')),
  },
];
const CHECK_EVERY = 6 * 3600e3;

class Software extends EventEmitter {
  constructor({ root, fetchImpl = globalThis.fetch, unpack = null }) {
    super();
    this.dir = path.join(root, 'software');
    this.stateFile = path.join(this.dir, 'software.json');
    this.fetch = fetchImpl;
    this.unpack = unpack || platform.unpack;
    this.installing = new Map(); // id -> { done, total, step }
    this.errors = new Map();
    this.latest = new Map();     // id -> { version, checkedAt }
    this.beforeChange = new Map(); // id -> async () => void: stop the program before its files change
  }

  readState() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return {}; }
  }

  writeState(s) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(s, null, 2));
  }

  entry(id) {
    const e = CATALOG.find(x => x.id === id);
    if (!e) throw new Error(`Unknown software "${id}"`);
    return e;
  }

  installed(id) {
    const s = this.readState()[id];
    if (!s) return null;
    const exe = this.entry(id).exe(path.join(this.dir, s.folder));
    return exe && fs.existsSync(exe) ? { ...s, exe } : null;
  }

  exePath(id) {
    return this.installed(id)?.exe || null;
  }

  status() {
    return CATALOG.map(e => {
      const inst = this.installed(e.id);
      const latest = this.latest.get(e.id);
      return {
        id: e.id, name: e.name, description: e.description,
        installed: inst ? { version: inst.version, installedAt: inst.installedAt } : null,
        latest: latest?.version || null,
        update: !!(inst && latest && latest.version !== inst.version && newer(latest.version, inst.version)),
        installing: this.installing.get(e.id) || null,
        error: this.errors.get(e.id) || '',
      };
    });
  }

  emitStatus() { this.emit('status', this.status()); }

  // The newest stable release that has a Windows zip, with its checksum file.
  async findRelease(e) {
    const list = [];
    for (const url of [e.latest, e.releases].filter(Boolean)) {
      const res = await this.fetch(url, { headers: { 'User-Agent': 'Officina', Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const j = await res.json();
      list.push(...(Array.isArray(j) ? j : [j]));
      if (list.some(r => this.usable(e, r))) break;
    }
    for (const r of list) {
      if (!this.usable(e, r)) continue;
      const zip = (r.assets || []).find(a => e.asset.test(a.name));
      const sum = zip && r.assets.find(a => a.name === `${zip.name}.sha256`);
      if (zip && sum) return { version: zip.name.match(e.asset)[1], zip, sum };
    }
    throw new Error(`No download of ${e.name} for this computer found in its recent releases.`);
  }

  usable(e, r) {
    return !r.prerelease && !r.draft && (!e.stable || e.stable.test(r.name || '')) && (r.assets || []).some(a => e.asset.test(a.name));
  }

  async checkLatest(id, force = false) {
    const cur = this.latest.get(id);
    if (!force && cur && Date.now() - cur.checkedAt < CHECK_EVERY) return cur.version;
    const rel = await this.findRelease(this.entry(id));
    this.latest.set(id, { version: rel.version, checkedAt: Date.now() });
    this.emitStatus();
    return rel.version;
  }

  async install(id) {
    const e = this.entry(id);
    if (this.installing.has(id)) throw new Error(`${e.name} is already being installed.`);
    const prog = { done: 0, total: 0, step: 'Looking up the latest version' };
    this.installing.set(id, prog);
    this.errors.delete(id);
    this.emitStatus();
    const part = path.join(this.dir, `${id}.zip.part`);
    try {
      const rel = await this.findRelease(e);
      this.latest.set(id, { version: rel.version, checkedAt: Date.now() });
      const sumText = await (await this.fetch(rel.sum.browser_download_url, { headers: { 'User-Agent': 'Officina' }, redirect: 'follow' })).text();
      const expected = (sumText.match(/\b[0-9a-f]{64}\b/i) || [])[0];
      if (!expected) throw new Error('The checksum file of the download could not be read.');
      fs.mkdirSync(this.dir, { recursive: true });
      prog.total = rel.zip.size;
      prog.step = `Downloading ${e.name} ${rel.version}`;
      const got = await this.download(rel.zip.browser_download_url, part, prog);
      if (got.toLowerCase() !== expected.toLowerCase()) throw new Error('The download does not match its published checksum, so it was thrown away.');
      prog.step = 'Unpacking';
      this.emitStatus();
      const folder = path.join(id, rel.version);
      const target = path.join(this.dir, folder);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(target, { recursive: true });
      await this.unpack(part, target);
      const exe = e.exe(target);
      if (!exe || !fs.existsSync(exe)) throw new Error(`The download did not contain the ${e.name} program.`);
      const previous = this.installed(id);
      await this.beforeChange.get(id)?.();
      const state = this.readState();
      state[id] = { version: rel.version, folder, installedAt: new Date().toISOString() };
      this.writeState(state);
      if (previous && previous.folder !== folder) fs.rmSync(path.join(this.dir, previous.folder), { recursive: true, force: true });
      return this.status();
    } catch (err) {
      this.errors.set(id, `${e.name} could not be installed: ${err.message}`);
      throw new Error(this.errors.get(id));
    } finally {
      fs.rmSync(part, { force: true });
      this.installing.delete(id);
      this.emitStatus();
    }
  }

  async remove(id) {
    const e = this.entry(id);
    const inst = this.installed(id);
    await this.beforeChange.get(id)?.();
    if (inst) fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    const state = this.readState();
    delete state[id];
    this.writeState(state);
    this.errors.delete(id);
    this.emitStatus();
    return { removed: !!inst, name: e.name };
  }

  // Streams to disk and hashes on the way, so a 250 MB zip is never held in memory.
  async download(url, file, prog) {
    const res = await this.fetch(url, { headers: { 'User-Agent': 'Officina' }, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    let last = 0;
    try {
      for await (const chunk of res.body) {
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
        prog.done += chunk.length;
        if (Date.now() - last > 300) { last = Date.now(); this.emitStatus(); }
      }
    } finally {
      await new Promise(r => out.end(r));
    }
    return hash.digest('hex');
  }
}

// "1.97.56" > "1.96.120"
function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

module.exports = { Software, CATALOG, newer };
