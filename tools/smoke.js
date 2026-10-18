// Starts a built (locked) Officina and checks it over the local API: the app starts, the
// compiled main process answers, a note can be made, and the window renders (screenshot).
// usage: node tools/smoke.js <path to the app executable> <output folder>
// A locked build refuses debugging ports, so the local API is the way in.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [exe, outDir = '.'] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-smoke-'));
const PORT = 4799;
// Skip the first-run Brave download in the test: new windows use the built-in browser.
fs.writeFileSync(path.join(ws, 'settings.json'), JSON.stringify({ disclaimerAcceptedAt: new Date().toISOString(), ui: { mode: 'technical' }, mcpPort: PORT, braveAutoInstallTried: 'smoke', browserEngine: 'builtin' }));

const child = spawn(exe, [`--workspace=${ws}`], { stdio: 'ignore' });
const fail = msg => { console.error(`SMOKE FAILED: ${msg}`); try { child.kill(); } catch { /* gone */ } process.exit(1); };
child.on('exit', code => fail(`the app exited (${code})`));

(async () => {
  let token;
  for (let i = 0; i < 120 && !token; i++) {
    await sleep(500);
    try { token = JSON.parse(fs.readFileSync(path.join(ws, 'settings.json'), 'utf8')).mcpToken; } catch { /* not yet */ }
  }
  if (!token) fail('no settings written within 60 s');
  const url = `http://127.0.0.1:${PORT}/mcp`;
  let sid = null, id = 0;
  const rpc = async (method, params) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    sid = r.headers.get('mcp-session-id') || sid;
    return r.json();
  };
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) { try { await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Smoke', version: '1' } }); ready = true; } catch { await sleep(500); } }
  if (!ready) fail('the local API did not answer');
  const call = async (name, args = {}) => { const r = await rpc('tools/call', { name, arguments: args }); if (r.result?.isError) throw new Error(`${name}: ${r.result.content[0]?.text}`); return r.result.content; };
  const tools = (await rpc('tools/list', {})).result.tools.length;
  if (tools < 50) fail(`only ${tools} tools`);
  await call('note_create', { title: 'Smoke test', content: 'The compiled build works.' });
  const overview = JSON.parse((await call('workspace_overview'))[0].text);
  if (!overview.notes.some(n => n.title === 'Smoke test')) fail('the note is missing');
  await sleep(1500);
  // Some virtual machines (the Intel Mac runners) cannot capture the screen; the rest still counts.
  let shotNote = 'screenshot saved';
  try {
    const shot = (await call('canvas_screenshot')).find(c => c.type === 'image');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `smoke-${process.platform}-${process.arch}.jpg`), Buffer.from(shot.data, 'base64'));
  } catch (e) { shotNote = `no screenshot (${e.message})`; }
  console.log(`SMOKE OK: ${tools} tools, note made, ${shotNote}`);
  child.removeAllListeners('exit');
  child.kill();
  process.exit(0);
})().catch(e => fail(e.message));
