// Minimal MCP client for driving a running Officina from the command line.
// usage: node test/mcp.js <workspaceDir> <tool> '<json args>' [--img out.jpg]
const fs = require('fs');
const path = require('path');
const [ws, tool, argJson = '{}', ...rest] = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(path.join(ws, 'settings.json'), 'utf8'));
const url = `http://127.0.0.1:${settings.mcpPort}/mcp`;
const imgOut = rest[rest.indexOf('--img') + 1];
async function rpc(method, params, id = 1) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${settings.mcpToken}` }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const t = await r.text();
  return t ? JSON.parse(t) : { status: r.status };
}
(async () => {
  if (tool === 'list') { const r = await rpc('tools/list', {}); console.log(r.result.tools.map(t => t.name).join('\n')); return; }
  if (tool === 'init') { console.log(JSON.stringify(await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }), null, 1).slice(0, 800)); return; }
  const r = await rpc('tools/call', { name: tool, arguments: JSON.parse(argJson) });
  if (r.error) { console.log('RPC ERROR', r.error); process.exit(1); }
  for (const c of r.result.content) {
    if (c.type === 'text') console.log(c.text);
    else if (c.type === 'image') { const out = imgOut || `shot-${Date.now()}.jpg`; fs.writeFileSync(out, Buffer.from(c.data, 'base64')); console.log(`[image -> ${out}]`); }
  }
  if (r.result.isError) process.exit(2);
})().catch(e => { console.error(e.message); process.exit(1); });
