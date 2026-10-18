// Evaluate JS in the Officina UI via the DevTools protocol (dev/test only).
// usage: node test/cdp.js '<expression>'   (app must run with --remote-debugging-port=9333)
const expr = process.argv[2];
(async () => {
  const targets = await (await fetch('http://127.0.0.1:9333/json')).json();
  const page = targets.find(t => t.type === 'page' && t.url.startsWith('ac://app'));
  if (!page) throw new Error('UI page not found: ' + targets.map(t => t.type + ' ' + t.url).join(', '));
  const sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => sock.addEventListener('open', r));
  sock.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true } }));
  sock.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id !== 1) return;
    const r = m.result;
    if (r.exceptionDetails) console.log('EXCEPTION', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    else console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 1));
    sock.close();
  });
})().catch(e => { console.error(e.message); process.exit(1); });
