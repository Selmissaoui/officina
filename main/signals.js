'use strict';
const http = require('http');
const crypto = require('crypto');
const { writeJson, readJson } = require('./store');
const path = require('path');
class Signals {
  constructor({ ws, tasks, stop, snapshot }) { Object.assign(this, { ws, tasks, stop, snapshot }); this.server = null; this.seen = readJson(path.join(ws.root, 'signals-seen.json'), []); }
  status() { return { running: !!this.server, ...(this.ws.settings.signals || {}) }; }
  async configure(input) {
    await this.close();
    const port = Number(input.port || 4781);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535');
    const config = { enabled: !!input.enabled, lan: !!input.lan, port, token: this.ws.settings.signals?.token || crypto.randomBytes(32).toString('hex'), taskId: String(input.taskId || '') };
    this.ws.settings.signals = config; this.ws.saveSettings();
    if (!config.enabled) return this.status();
    this.server = http.createServer(async (req, res) => {
      const reply = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
      if (req.url === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:", 'Cache-Control': 'no-store' });
        return res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Officina Companion</title><style>body{font:18px system-ui;background:#111827;color:white;margin:24px}button{padding:20px;background:#c02626;color:white;border:0;border-radius:12px}img{width:100%}</style><h1>Officina</h1><button id="stop">STOP AGENT</button><p id="status"></p><img id="canvas"><script>const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);const headers={Authorization:'Bearer '+token};document.getElementById('stop').onclick=async()=>{await fetch('/stop',{method:'POST',headers});load()};async function load(){const r=await fetch('/state',{headers});if(!r.ok){document.getElementById('status').textContent='Access denied. Open the companion link from the app.';return}const d=await r.json();document.getElementById('status').textContent=d.paused?'Agent stopped':'Agent available';document.getElementById('canvas').src=d.image||''}load();setInterval(load,5000)</script>`);
      }
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return reply(403, { error: 'Origin blocked' });
      const auth = Buffer.from(req.headers.authorization || ''), expected = Buffer.from('Bearer ' + config.token);
      if (auth.length !== expected.length || !crypto.timingSafeEqual(auth, expected)) return reply(401, { error: 'Unauthorized' });
      try {
        if (req.url === '/stop' && req.method === 'POST') { this.stop(); return reply(200, { stopped: true }); }
        if (req.url === '/state' && req.method === 'GET') return reply(200, await this.snapshot());
        if (req.url !== '/signal' || req.method !== 'POST') return reply(404, { error: 'Not found' });
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 8192) return reply(413, { error: 'Too large' }); }
        const data = JSON.parse(body);
        if (typeof data.id !== 'string' || !data.id || data.id.length > 160) return reply(400, { error: 'A unique signal id is required' });
        if (this.seen.includes(data.id)) return reply(200, { duplicate: true });
        // Incoming text cannot change a saved task, select an account, or bypass its mandate.
        this.tasks.runNow(config.taskId);
        this.seen.push(data.id); this.seen = this.seen.slice(-1000); writeJson(path.join(this.ws.root, 'signals-seen.json'), this.seen);
        return reply(202, { queued: true });
      } catch (e) { return reply(400, { error: e.message }); }
    });
    this.server.requestTimeout = 10000;
    try { await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, config.lan ? '0.0.0.0' : '127.0.0.1', resolve); }); }
    catch (e) { this.server = null; throw e; }
    return this.status();
  }
  async close() { if (this.server) { const server = this.server; this.server = null; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
}
module.exports = { Signals };
