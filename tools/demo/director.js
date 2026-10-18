// Records the Officina advertisement video.
//   node tools/demo/director.js [output.mp4]
// It prepares a fresh demo workspace, starts a scripted model, Officina (1920x1080) and
// the recorder, then plays the scenes through the real interface: title cards and
// captions are an overlay, every click and every agent action is real.
// Needs: Brave already installed somewhere to copy (DEMO_SOFTWARE=<Officina-Data>/software),
// optionally the model engine (DEMO_ENGINE=<Officina-Data>/engine) so the status bar shows it.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMockModel } = require('./mock-model');
const OVERLAY = require('./overlay');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'Officina-ad.mp4'));
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-ad-'));
const CDP_PORT = 9339, REC_PORT = 9555, MCP_PORT = 4793;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const electron = require('electron');

const copyDir = (from, to) => { if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true }); };

// ---------- a small DevTools client for the Officina window ----------
let sock, nextId = 0;
const pending = new Map();
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const page = targets.find(t => t.type === 'page' && t.url.startsWith('ac://app'));
      if (page) {
        sock = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise(r => sock.addEventListener('open', r));
        sock.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
        return;
      }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('Officina did not start');
}
async function ui(expression) {
  const id = ++nextId;
  const m = await new Promise(r => { pending.set(id, r); sock.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } })); });
  if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text);
  return m.result?.result?.value;
}
const ad = (method, ...args) => ui(`window.__ad.${method}(${args.map(a => JSON.stringify(a)).join(', ')})`);
const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ui(expr).catch(() => false)) return true; await sleep(400); } throw new Error(`timed out: ${expr}`); };

(async () => {
  // ---------- 1. a fresh workspace with Brave, the engine and a lead agent ----------
  const model = await startMockModel({ pace: 1 });
  copyDir(process.env.DEMO_SOFTWARE || path.join(ROOT, 'workspace-dev', 'software'), path.join(WS, 'software'));
  copyDir(process.env.DEMO_ENGINE || '', path.join(WS, 'engine'));
  fs.mkdirSync(path.join(WS, 'files', 'brand'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'build', 'icon-1024.png'), path.join(WS, 'files', 'brand', 'officina-icon.png'));
  fs.writeFileSync(path.join(WS, 'settings.json'), JSON.stringify({
    disclaimerAcceptedAt: new Date().toISOString(), braveAutoInstallTried: 'demo', mcpPort: MCP_PORT, mcpEnabled: true,
    ui: { mode: 'technical', theme: 'pro', appearance: 'dark', cursor: { show: true, speed: 'normal', follow: false, captions: true } },
    team: [{ id: 'assistant', name: 'CEO', runner: 'custom', baseUrl: model.url, model: 'officina-demo', canLead: true, role: 'You lead a small research team.', toolset: 'essential', numCtx: 32768, temperature: 0.3 }],
  }, null, 2));

  const app = spawn(electron, ['.', `--remote-debugging-port=${CDP_PORT}`, `--workspace=${WS}`, '--officina-window=1920x1080'], { cwd: ROOT, stdio: 'ignore' });
  const rec = spawn(electron, [path.join(__dirname, 'recorder.js'), `--port=${REC_PORT}`], { cwd: ROOT, stdio: 'ignore' });
  const cleanup = () => { try { app.kill(); } catch { /* gone */ } try { rec.kill(); } catch { /* gone */ } model.server.close(); };
  process.on('exit', cleanup);
  await connect();
  await waitFor('!!document.querySelector("#rail") && !!window.ac');
  await sleep(1500);

  // ---------- 2. a lived-in but messy canvas ----------
  await ui(`(async () => {
    const add = p => window.ac.addItem(p);
    const brave = await add({ type: 'browser', url: 'https://dredyson.com/how-i-built-a-fully-local-ai-stack-for-algorithmic-trading-research-a-quants-complete-step-by-step-guide-to-offline-llms-rag-knowledge-bases-and-custom-memory-systems-for-financial-modeling-with/', title: 'Local AI stack', x: 640, y: 140, w: 980, h: 660 });
    const n1 = await add({ type: 'note', title: 'Ideas', x: 80, y: 900, color: 'yellow' });
    await window.ac.noteWrite(n1.id, '- Compare local models\\n- Watch BTC above 80K\\n- Ask the team for a brief');
    const n2 = await add({ type: 'note', title: 'Watchlist', x: 1750, y: 60, color: 'green' });
    await window.ac.noteWrite(n2.id, '**BTC** · **ETH** · **SOL**\\n\\nAlerts on Telegram');
    await add({ type: 'file', path: 'brand/officina-icon.png', title: 'officina-icon.png', x: 120, y: 120, w: 380, h: 420 });
    const n3 = await add({ type: 'note', title: 'Meeting', x: 1500, y: 980, color: 'blue' });
    await window.ac.noteWrite(n3.id, 'Friday: review the agents\\' research');
    window.__braveId = brave.id;
    return brave.id;
  })()`);
  await ui('document.getElementById("zoom-fit").click()');
  await sleep(9000); // Brave starts and loads the page
  await ui(OVERLAY);

  // ---------- 3. record ----------
  await ad('cardOn', { title: 'Officina', sub: 'A workspace where AI agents browse, research and report. On your own computer.', chips: ['Windows', 'macOS', 'Runs locally'] });
  const recUrl = `http://127.0.0.1:${REC_PORT}`;
  for (let i = 0; i < 40; i++) { try { await fetch(`${recUrl}/ping`); break; } catch { await sleep(300); } }
  const started = await (await fetch(`${recUrl}/start?title=Officina&w=1920&h=1080&fps=30&out=${encodeURIComponent(OUT)}`, { method: 'POST' })).json();
  if (!started.ok) throw new Error(started.error);
  console.log('recording', started.mime);

  // Intro
  await sleep(3200);
  await ad('cardOff');

  // Scene: one canvas, organised in a click
  ad('caption', 'One canvas for everything', 'Browsers, notes and files side by side', 4200);
  await sleep(1400);
  await ad('click', '#organize');
  await sleep(2800);

  // Scene: Brave built in
  await ui(`window.__ad.dblclick('.item[data-id="' + window.__braveId + '"] .item-head .engine-tag')`);
  await sleep(1200);
  ad('caption', 'Brave, built in', 'Ads blocked by Brave Shields, and no "ad blocker detected" pop-ups', 4600);
  await ad('wheel', '.engine-brave .brave-surface', 120, 10);
  await sleep(1600);
  await ad('moveTo', '.engine-brave .brave-shield', 700);
  await sleep(1400);

  // Scene: give one task to the lead agent
  await ad('click', '.rail-btn[data-panel="chat"]');
  await sleep(900);
  ad('caption', 'Give one task', 'The lead agent splits it and hands the parts to helpers', 5200);
  await ad('type', '.team-card textarea', 'Make me a short brief on local AI models and Bitcoin. Split the work.', 28);
  await sleep(300);
  await ui(`window.__ad.click(window.__ad.byText('.team-card .btn', 'Send'))`);
  await sleep(1500);
  await ad('click', '#chat-close');
  await ad('click', '#zoom-fit');
  ad('caption', 'A team that works in parallel', 'Each agent has its own colour, its own cursor and its own browser', 0);
  // Wait for both helpers' browsers, then look over their shoulders one by one.
  // A helper's window, found by the page it works on.
  const helperSel = page => `[...document.querySelectorAll('.item.engine-brave')].find(e => (e.querySelector('.url')?.value || '').includes('${page}'))`;
  const helperWindow = async page => { await waitFor(`!!(${helperSel(page)})`, 60000); await ui(`window.__ad.dblclick((${helperSel(page)}).querySelector('.item-head .engine-tag'))`); };
  await sleep(1500);
  await helperWindow('Large_language_model');
  await sleep(5500);
  ad('caption', 'Live, where you can see it', 'They open pages, read and scroll, and write what they find', 0);
  await helperWindow('Bitcoin');
  await sleep(6000);

  // Scene: steer them while they work
  await ad('click', '.rail-btn[data-panel="chat"]');
  await sleep(700);
  ad('caption', 'Steer them while they work', 'One message to several agents, read before their next step', 5600);
  await ad('type', '.group-text', 'Tell me what you found so far.', 26);
  await ui(`window.__ad.click(window.__ad.byText('.group-box .btn', 'Send to ticked'))`);
  await sleep(2600);
  await ad('click', '#chat-close');
  await ad('click', '#zoom-fit');
  await sleep(2500);

  // Scene: results and the clean-up
  ad('caption', 'They finish, report and tidy up', 'Windows they no longer need are closed; the brief lands on the canvas', 0);
  await waitFor(`window.ac.teamList().then(l => l.length >= 3 && l.every(a => !a.busy))`, 120000);
  await sleep(1200);
  await ad('click', '#organize');
  await sleep(3200);
  await ad('clearCaption');

  // Scene: the agents panel
  await ad('click', '.rail-btn[data-panel="agents"]');
  ad('caption', 'See who is doing what', 'Pause one agent, keep another away from trading', 3600);
  await sleep(4000);

  // Scene: connectors
  await ad('click', '.rail-btn[data-panel="connectors"]');
  ad('caption', 'Talk to them from your phone', 'Link Telegram or Discord: tasks in, answers and alerts out', 4200);
  await sleep(4600);

  // Scene: trading within limits
  await ad('click', '.rail-btn[data-panel="trading"]');
  ad('caption', 'Trading, within your limits', 'Paper or live, only inside the limits you approve', 4000);
  await sleep(4400);

  // Scene: bring your own agents
  await ad('click', '.rail-btn[data-panel="agent"]');
  ad('caption', 'Bring your own AI', 'Claude Code, Codex or any MCP app works in the same canvas', 4000);
  await sleep(4400);

  // Scene: everything searchable
  await ad('click', '#search-btn');
  await sleep(500);
  ad('caption', 'Everything they make is searchable', 'Notes, files, pages and trades in one library', 4200);
  await ad('type', '#drawer-body input', 'bitcoin', 10);
  await sleep(2600);
  await ad('click', '#drawer-close');

  // Scene: status bar
  ad('caption', 'Always know what is running', 'Local API, model, Brave, linked chats, memory and tokens', 3800);
  await ad('spot', '#statusbar', 3400, 4);
  await ad('hideCursor');

  // Outro: the video ends on the card.
  await ad('cardOn', { title: 'Your agents. Your computer.', sub: 'Officina for Windows and macOS', chips: ['Brave built in', 'Agent teams', 'Telegram & Discord', 'Local models'] });
  await sleep(3800);

  await (await fetch(`${recUrl}/stop`, { method: 'POST' })).json();
  console.log('saved', OUT, `${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB`);
  cleanup();
  process.exit(0);
})().catch(e => { console.error('DEMO FAILED:', e.stack, e.cause || ''); process.exit(1); });
