'use strict';
// Built-in model engine. Runs llama.cpp's llama-server in the background so the
// assistant works without LM Studio or Ollama open. The engine is downloaded once
// into Officina-Data/engine; models are GGUF files found in LM Studio's and
// Ollama's folders or in Officina-Data/models, so nothing is downloaded twice.
const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const platform = require('./platform');

const RELEASES = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20';
const VARIANTS = {
  vulkan: { label: 'Vulkan (any graphics card)', match: [/^llama-b\d+-bin-win-vulkan-x64\.zip$/] },
  cuda: { label: 'CUDA (NVIDIA, fastest)', match: [/^llama-b\d+-bin-win-cuda-(\d+\.\d+)-x64\.zip$/, /^cudart-llama-bin-win-cuda-(\d+\.\d+)-x64\.zip$/] },
  cpu: { label: 'CPU only', match: [/^llama-b\d+-bin-win-cpu-x64\.zip$/] },
  metal: { label: 'Metal (Apple Silicon)', match: [/^llama-b\d+-bin-macos-arm64\.(zip|tar\.gz)$/] },
  macx64: { label: 'Intel Mac', match: [/^llama-b\d+-bin-macos-x64\.(zip|tar\.gz)$/] },
};
// What to install on this computer when nobody picks: Vulkan on Windows, Metal on a Mac.
const DEFAULT_VARIANT = process.platform === 'darwin' ? (process.arch === 'arm64' ? 'metal' : 'macx64') : 'vulkan';
const SERVER = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Picks the assets for a variant from one release; for CUDA the newest toolkit that has both zips.
function pickAssets(release, variant) {
  const v = VARIANTS[variant];
  if (!v) throw new Error(`Unknown engine type "${variant}"`);
  const assets = release.assets || [];
  if (variant !== 'cuda') {
    const a = assets.find(x => v.match[0].test(x.name));
    return a ? [a] : null;
  }
  const versions = assets.map(x => x.name.match(v.match[0])?.[1]).filter(Boolean)
    .sort((a, b) => Number(b.split('.')[0]) - Number(a.split('.')[0]) || Number(b.split('.')[1]) - Number(a.split('.')[1]));
  for (const ver of versions) {
    const main = assets.find(x => x.name.match(v.match[0])?.[1] === ver);
    const rt = assets.find(x => x.name.match(v.match[1])?.[1] === ver);
    if (main && rt) return [main, rt];
  }
  return null;
}

// "  Vulkan0: NVIDIA GeForce RTX 4070 SUPER (11997 MiB, 11229 MiB free)"
function parseDevices(text) {
  return String(text).split(/\r?\n/).map(l => l.match(/^\s*([A-Za-z]+\d+):\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)/))
    .filter(Boolean).map(m => ({ id: m[1], name: m[2], totalMiB: Number(m[3]), freeMiB: Number(m[4]) }));
}

// A dedicated card beats the graphics built into the processor, whose "memory" is shared system RAM.
function bestDevice(devices) {
  const integrated = d => /\b(UHD|Iris|Radeon\(TM\) Graphics|Radeon Graphics|Vega \d+ Graphics|Intel\(R\) Graphics)\b/i.test(d.name) && !/\bRX\b|\bArc\b/i.test(d.name);
  const dedicated = devices.filter(d => !integrated(d));
  return (dedicated.length ? dedicated : devices).sort((a, b) => b.totalMiB - a.totalMiB)[0] || null;
}

function walkGguf(dir, depth = 5, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) walkGguf(abs, depth - 1, out);
    else if (e.isFile() && /\.gguf$/i.test(e.name)) out.push(abs);
  }
  return out;
}

const fileSizeOf = f => { try { return fs.statSync(f).size; } catch { return 0; } };
const fileSize = f => { try { return fs.statSync(f).size; } catch { return 0; } };

// GGUF files from LM Studio (and the older ~/.cache/lm-studio), our own folder, and Ollama's blob store.
function scanModels({ ownDir, home = os.homedir(), ollamaDir = process.env.OLLAMA_MODELS || path.join(home, '.ollama', 'models') } = {}) {
  const models = [];
  const seen = new Set();
  const add = m => { const key = path.resolve(m.id).toLowerCase(); if (!seen.has(key) && m.size > 0) { seen.add(key); models.push(m); } };
  const folders = [
    [ownDir, 'Officina'],
    [path.join(home, '.lmstudio', 'models'), 'LM Studio'],
    [path.join(home, '.cache', 'lm-studio', 'models'), 'LM Studio'],
  ];
  for (const [dir, source] of folders) {
    if (!dir) continue;
    const files = walkGguf(dir);
    for (const f of files.filter(f => !/^mmproj/i.test(path.basename(f)))) {
      const mmproj = files.find(m => path.dirname(m) === path.dirname(f) && /^mmproj/i.test(path.basename(m))) || null;
      const rel = path.relative(dir, path.dirname(f)).split(path.sep).join('/');
      add({ id: f, name: path.basename(f).replace(/\.gguf$/i, ''), folder: rel, source, size: fileSize(f), mmproj });
    }
  }
  const manifests = path.join(ollamaDir, 'manifests');
  const blob = digest => path.join(ollamaDir, 'blobs', digest.replace(':', '-'));
  // Manifest files have no extension, so they need their own walk.
  const walkAll = (dir, depth, out = []) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) { const abs = path.join(dir, e.name); if (e.isDirectory() && depth > 0) walkAll(abs, depth - 1, out); else if (e.isFile()) out.push(abs); }
    return out;
  };
  for (const f of walkAll(manifests, 4)) {
    let m; try { m = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const layer = (m.layers || []).find(l => l.mediaType === 'application/vnd.ollama.image.model');
    if (!layer) continue;
    const proj = (m.layers || []).find(l => l.mediaType === 'application/vnd.ollama.image.projector');
    const parts = path.relative(manifests, f).split(path.sep); // registry/namespace/model/tag
    const [ns, model, tag] = parts.slice(-3);
    add({ id: blob(layer.digest), name: `${ns === 'library' ? '' : `${ns}/`}${model}:${tag}`, folder: '', source: 'Ollama', size: fileSize(blob(layer.digest)), mmproj: proj ? blob(proj.digest) : null });
  }
  return models.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

class Engine extends EventEmitter {
  constructor({ root, fetchImpl = globalThis.fetch }) {
    super();
    this.dir = path.join(root, 'engine');
    this.modelsDir = path.join(root, 'models');
    this.stateFile = path.join(this.dir, 'engine.json');
    this.fetch = fetchImpl;
    this.servers = new Map(); // model path -> { child, url, ctx, slots, vision, inflight, starting, log }
    this.slotCap = new Map(); // model path -> most slots that started fine (after a crash with more)
    this.installing = null;
    this.error = '';
    this.devices = null;
    fs.mkdirSync(this.modelsDir, { recursive: true });
  }

  installed() {
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      return this.serverPath(s) ? s : null;
    } catch { return null; }
  }

  // Process ids of the running model servers (for the memory meter).
  pids() {
    return [...this.servers.values()].map(x => x.child?.pid).filter(Boolean);
  }

  status() {
    const inst = this.installed();
    const gpu = this.devices ? bestDevice(this.devices) : null;
    return {
      platform: process.platform, defaultVariant: DEFAULT_VARIANT,
      installed: inst ? { build: inst.build, variant: inst.variant, label: VARIANTS[inst.variant]?.label } : null,
      installing: this.installing, error: this.error, gpu,
      running: [...this.servers.values()].filter(x => x.url).map(x => ({ model: x.model, name: path.basename(x.model).replace(/\.gguf$/i, ''), ctx: x.ctx, slots: x.slots })),
      loading: [...this.servers.values()].some(x => x.starting), variants: Object.fromEntries(Object.entries(VARIANTS).map(([k, v]) => [k, v.label])),
    };
  }

  emitStatus() { this.emit('status', this.status()); }

  // ---------- install ----------
  // llama-server inside an installed folder (the Mac download keeps it one folder deeper).
  serverPath(s = this.installed()) {
    if (!s) return null;
    const dir = path.join(this.dir, s.folder);
    const direct = path.join(dir, SERVER);
    return fs.existsSync(direct) ? direct : platform.findBelow(dir, e => e.isFile() && e.name === SERVER, 3);
  }

  async install(variant = DEFAULT_VARIANT) {
    if (process.platform === 'darwin' && !['metal', 'macx64'].includes(variant)) variant = DEFAULT_VARIANT;
    if (this.installing) throw new Error('The engine is already being installed.');
    this.installing = { variant, done: 0, total: 0, step: 'Looking up the latest engine' };
    this.error = '';
    this.emitStatus();
    try {
      const res = await this.fetch(RELEASES, { headers: { 'User-Agent': 'Officina', Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const release = (await res.json()).find(r => pickAssets(r, variant));
      if (!release) throw new Error(`No ${VARIANTS[variant].label} engine found in recent llama.cpp releases.`);
      const assets = pickAssets(release, variant);
      const folder = `${release.tag_name}-${variant}`;
      const target = path.join(this.dir, folder);
      fs.mkdirSync(target, { recursive: true });
      this.installing.total = assets.reduce((s, a) => s + a.size, 0);
      for (const a of assets) {
        this.installing.step = `Downloading ${a.name}`;
        const zip = path.join(this.dir, `${a.name}.part`);
        await this.download(a.browser_download_url, zip);
        this.installing.step = 'Unpacking';
        this.emitStatus();
        await platform.unpack(zip, target);
        fs.rmSync(zip, { force: true });
      }
      if (!platform.findBelow(target, e => e.isFile() && e.name === SERVER, 3)) throw new Error(`The download did not contain ${SERVER}.`);
      await this.stop();
      const previous = this.installed();
      fs.writeFileSync(this.stateFile, JSON.stringify({ build: release.tag_name, variant, folder, installedAt: new Date().toISOString() }, null, 2));
      if (previous && previous.folder !== folder) fs.rmSync(path.join(this.dir, previous.folder), { recursive: true, force: true });
      this.devices = null;
      return this.status();
    } catch (e) {
      this.error = `Engine install failed: ${e.message}`;
      throw new Error(this.error);
    } finally {
      this.installing = null;
      this.emitStatus();
    }
  }

  async download(url, file) {
    const res = await this.fetch(url, { headers: { 'User-Agent': 'Officina' }, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
    const out = fs.createWriteStream(file);
    let last = 0;
    try {
      for await (const chunk of res.body) {
        if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
        this.installing.done += chunk.length;
        if (Date.now() - last > 250) { last = Date.now(); this.emitStatus(); }
      }
    } finally {
      await new Promise(r => out.end(r));
    }
  }

  // ---------- models ----------
  models() {
    return scanModels({ ownDir: this.modelsDir });
  }

  async listDevices() {
    if (this.devices) return this.devices;
    const inst = this.installed();
    if (!inst) return [];
    const exe = this.serverPath(inst);
    const text = await new Promise(resolve => execFile(exe, ['--list-devices'], { windowsHide: true, timeout: 20000, cwd: path.dirname(exe) }, (_e, so, se) => resolve(`${so}\n${se}`)));
    this.devices = parseDevices(text);
    return this.devices;
  }

  // ---------- run ----------
  // One llama-server per model. Agents on the same model share it: the server gets
  // several slots, so their requests run side by side instead of loading the model twice.
  isRunning(model) {
    const x = this.servers.get(model);
    return !!x && !!x.child && !!x.url;
  }

  async start({ model, ctx = 16384, vision = false, slots = 1 }) {
    const want = { ctx: Number(ctx), vision: !!vision, slots: Math.min(slotCount(slots), this.slotCap.get(model) || MAX_SLOTS) };
    let cur = this.servers.get(model);
    if (cur?.starting) { await cur.starting.catch(() => {}); cur = this.servers.get(model); }
    const fits = cur && cur.url && cur.vision === want.vision && cur.ctx >= want.ctx && cur.slots >= want.slots;
    // Never restart a model while another agent is waiting on it; extra requests just queue.
    if (cur && cur.url && (fits || cur.inflight > 0)) return cur.url;
    if (cur) { await this.stopServer(cur); await this.settleMemory(); }
    const entry = { model, ...want, inflight: 0, child: null, url: null, log: [] };
    this.servers.set(model, entry);
    // Some models crash the engine with many slots (seen: 8 slots on Vulkan). Then try
    // again with fewer and remember that number for this model, so it is tried only once.
    entry.starting = this.launch(entry).catch(async e => {
      if (entry.slots <= 2 || !/stopped while loading|this many agents/.test(e.message)) throw e;
      const fewer = entry.slots > 4 ? 4 : 2;
      this.slotCap.set(model, fewer);
      Object.assign(entry, { slots: fewer, log: [] });
      await this.settleMemory();
      return this.launch(entry);
    });
    this.emitStatus();
    try {
      return await entry.starting;
    } catch (e) {
      if (this.servers.get(model) === entry) this.servers.delete(model);
      throw e;
    } finally {
      entry.starting = null;
      this.emitStatus();
    }
  }

  // Wraps one request, so the model is not restarted under an agent that is waiting for it.
  async use(model, fn) {
    const x = this.servers.get(model);
    if (x) x.inflight++;
    try { return await fn(); } finally { if (x) x.inflight--; }
  }

  async launch(entry) {
    const { model, ctx, vision, slots } = entry;
    const inst = this.installed();
    if (!inst) throw new Error('The built-in engine is not installed yet. Open Assistant, Change, and install it.');
    if (!fs.existsSync(model)) throw new Error(`Model file not found: ${model}`);
    const exe = this.serverPath(inst);
    const port = await freePort();
    // No fixed -c: the engine picks the largest context that still fits in free graphics
    // memory, and only goes below the minimum (-fitc, per agent slot) by moving layers to
    // the processor. A fixed large context pushed the model onto the processor (10x slower).
    const minCtx = Math.min(Math.max(ctx, 4096), 16384);
    const args = ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-np', String(slots), '--fit', 'on', '-fitc', String(minCtx), '--no-webui'];
    this.devices = null; // free memory changes all the time; ask again
    const gpu = bestDevice(await this.listDevices());
    if (gpu && inst.variant !== 'cpu') {
      args.push('--device', gpu.id);
      // The engine fits against Vulkan's view of free memory, which ignores what games and
      // other apps hold; keep that much (plus a margin) free so Windows does not page to RAM.
      const hidden = Math.max(0, gpu.freeMiB - await this.realFreeMiB(gpu));
      args.push('-fitt', String(Math.round(hidden + 768)));
    }
    entry.warning =gpu && inst.variant !== 'cpu' ? await this.memoryWarning(gpu, model, slots, minCtx) : '';
    const mmproj = vision ? this.models().find(m => m.id === model)?.mmproj : null;
    if (mmproj) args.push('--mmproj', mmproj);
    this.error = '';
    const child = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    entry.child = child;
    const keep = d => { entry.log.push(...String(d).split(/\r?\n/).filter(Boolean)); if (entry.log.length > 300) entry.log.splice(0, entry.log.length - 200); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let exited = null;
    child.on('exit', code => {
      exited = code ?? 'killed';
      entry.child = null;
      entry.url = null;
      if (this.servers.get(model) === entry && !entry.starting) { this.servers.delete(model); this.emitStatus(); }
    });
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 5 * 60e3; // large models on slow disks take a while
    while (Date.now() < deadline) {
      if (exited !== null) throw new Error(this.explain(entry, exited));
      try {
        const r = await this.fetch(`${url}/health`);
        if (r.ok) {
          entry.url = url;
          entry.port = port;
          try { entry.ctxSlot = (await (await this.fetch(`${url}/props`)).json()).default_generation_settings?.n_ctx || null; } catch { entry.ctxSlot = null; }
          return url;
        }
      } catch { /* still loading */ }
      await sleep(500);
    }
    await this.stopServer(entry);
    throw new Error('The model took too long to load.');
  }

  // The context each agent really got for this model (the engine may fit less than asked).
  contextFor(model) { return this.servers.get(model)?.ctxSlot || null; }

  warningFor(model) { return this.servers.get(model)?.warning || ''; }

  // Says so before loading when the model will not fit next to what other apps already
  // hold in graphics memory, and names the model apps that are holding memory.
  async memoryWarning(gpu, model, slots, minCtx) {
    const size = this.models().find(m => m.id === model)?.size || fileSizeOf(model);
    const needMiB = size / 1048576 + 600 + slots * minCtx * 0.03; // weights + runtime + a rough KV allowance
    gpu = { ...gpu, freeMiB: await this.realFreeMiB(gpu) };
    if (gpu.freeMiB >= needMiB) return '';
    const holders = [];
    try {
      const r = await Promise.race([this.fetch('http://127.0.0.1:11434/api/ps'), sleep(1500).then(() => null)]);
      const ps = r && r.ok ? await r.json() : null;
      for (const m of ps?.models || []) holders.push(`Ollama holds ${m.name} (${(m.size_vram / 1e9).toFixed(1)} GB)`);
    } catch { /* Ollama not running */ }
    const gb = n => (n / 1024).toFixed(1);
    return `Only ${gb(gpu.freeMiB)} of ${gb(gpu.totalMiB)} GB graphics memory is free and this model needs about ${gb(needMiB)} GB, so part of it will run on the processor and be slow.${holders.length ? ` ${holders.join('; ')}: stop it in Ollama or close Ollama.` : ''} Games and other model apps (LM Studio) also use graphics memory.`;
  }

  // The driver frees a stopped model's memory a moment after the process exits. Loading
  // the next one before that makes it think the card is full and move layers to the
  // processor (seen: 2.4 tokens a second). Wait until free memory stops rising.
  async settleMemory() {
    this.devices = null;
    const gpu = bestDevice(await this.listDevices());
    if (!gpu) return;
    await sleep(800); // the release has not always started right after the exit
    let last = -1;
    for (let i = 0; i < 25; i++) {
      const free = await this.realFreeMiB({ ...gpu, freeMiB: Infinity });
      if (!Number.isFinite(free)) { await sleep(1500); return; } // no way to read it: give it a moment
      if (last >= 0 && Math.abs(free - last) < 64) return;
      last = free;
      await sleep(400);
    }
  }

  // Vulkan reports free memory from its own point of view and misses what games and
  // other apps hold, so on NVIDIA cards nvidia-smi gives the real number.
  async realFreeMiB(gpu) {
    if (!/nvidia|geforce|rtx|gtx|quadro/i.test(gpu.name)) return gpu.freeMiB;
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe');
    const out = await new Promise(resolve => execFile(fs.existsSync(exe) ? exe : 'nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 5000 }, (e, so) => resolve(e ? '' : so)));
    const free = out.split(/\r?\n/).map(Number).filter(n => n > 0);
    return free.length ? Math.min(gpu.freeMiB, Math.max(...free)) : gpu.freeMiB;
  }

  // Turns llama-server's last words into something a person can act on.
  explain(entry, code) {
    const tail = entry.log.slice(-40).join('\n');
    if (/pre-allocated tensor|cannot run the operation/i.test(tail)) return `The engine could not serve this many agents at once on this model (${entry.slots} slots).`;
    if (/unknown model architecture|unknown architecture/i.test(tail)) return 'This engine version does not know this model yet. Update the engine (Assistant, Change, Update engine).';
    if (/out of memory|ErrorOutOfDeviceMemory|failed to allocate|cudaMalloc failed/i.test(tail)) return 'Not enough graphics memory for this model. Pick a smaller context, fewer agents on this model, or a smaller model.';
    const last = entry.log.filter(l => /error|failed/i.test(l)).slice(-2).join(' ');
    return `The engine stopped while loading the model (code ${code}).${last ? ` ${last.slice(0, 300)}` : ''}`;
  }

  async stopServer(entry) {
    const child = entry.child;
    entry.child = null;
    entry.url = null;
    if (this.servers.get(entry.model) === entry) this.servers.delete(entry.model);
    if (!child) return;
    child.kill();
    await Promise.race([new Promise(r => child.once('exit', r)), sleep(3000)]);
  }

  // Stops one model, or every model when none is given.
  async stop(model) {
    const targets = model ? [this.servers.get(model)].filter(Boolean) : [...this.servers.values()];
    await Promise.all(targets.map(x => this.stopServer(x)));
    this.emitStatus();
  }
}

// Slots come in steps, so adding one agent rarely means reloading the model.
// 6, not 8: eight slots crashed llama.cpp on Vulkan with Qwen3.5 (pre-allocated KV tensor error).
const MAX_SLOTS = 6;
const slotCount = n => (n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : MAX_SLOTS);

module.exports = { Engine, scanModels, parseDevices, bestDevice, pickAssets, slotCount, VARIANTS };
