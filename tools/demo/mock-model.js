// A scripted model for the demo video: an OpenAI-compatible server that plays a fixed
// plan per agent (the lead agent splits the job, two helpers browse and write notes),
// streaming its "reasoning" a little at a time so the chat looks alive.
const http = require('http');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Which agent is asking, and how far along its task it is.
function who(body) {
  const sys = body.messages.find(m => m.role === 'system')?.content || '';
  return (sys.match(/You are "([^"]+)"/) || [])[1] || 'CEO';
}
const lastTool = body => [...body.messages].reverse().find(m => m.role === 'tool');
const toolJson = m => { try { return JSON.parse(m.content); } catch { return {}; } };
const lastUser = body => [...body.messages].reverse().find(m => m.role === 'user')?.content || '';
// The browser this agent opened: the first tool result shaped like browser_open's answer
// (OpenAI-style tool messages carry no tool name).
function myBrowser(body) {
  for (const m of body.messages) if (m.role === 'tool') { const j = toolJson(m); if (j.id && j.profile && j.url) return j.id; }
  return null;
}

const PLANS = {
  CEO: [
    ['The user wants a short market brief. Two independent parts: local AI models and Bitcoin. I will give each part to a helper and combine their notes.',
      { tool: 'team_spawn', args: { name: 'Researcher', role: 'You research AI topics and write short factual notes.', task: 'Read the Wikipedia page on large language models and write the four key facts as a note.' } }],
    ['Now the second helper for the market part.',
      { tool: 'team_spawn', args: { name: 'Analyst', role: 'You research markets and write short notes with numbers.', task: 'Read the Wikipedia page on Bitcoin, check the current BTC price, and write the key numbers as a note.' } }],
    ['Both helpers are working. I will wait for their answers.', { tool: 'team_wait', args: { timeoutSeconds: 300 } }],
    ['Both are done. Combining their findings into one brief.',
      { tool: 'note_create', args: { title: 'Team brief', content: '# Team brief\n\n**Local AI**\n- Large language models now run fully on a home PC or a Mac.\n- Open models close most of the gap with cloud models.\n\n**Bitcoin**\n- Price checked live on the exchange.\n- Fixed supply of 21 million coins.\n\n_Notes by Researcher and Analyst are next to this one._' } }],
    ['', { text: 'Done. The Researcher and the Analyst each wrote a note, and the combined brief is on the canvas.' }],
  ],
  Researcher: [
    ['I will open the Wikipedia page on large language models.', { tool: 'browser_open', args: { url: 'https://en.wikipedia.org/wiki/Large_language_model', title: 'Large language models' } }],
    ['Reading the page.', { tool: 'browser_read', id: true }],
    ['Scrolling to the history section.', { tool: 'browser_scroll', id: true, args: { direction: 'down', amount: 1200 } }],
    ['Reading what is on screen now.', { tool: 'browser_read', id: true }],
    ['Further down to the training section.', { tool: 'browser_scroll', id: true, args: { direction: 'down', amount: 1200 } }],
    ['And the part on running models locally.', { tool: 'browser_scroll', id: true, args: { direction: 'down', amount: 1400 } }],
    ['One more look before I write it down.', { tool: 'browser_read', id: true }],
    ['I have enough for the note.', { tool: 'note_create', args: { title: 'Local AI: key facts', content: '- LLMs learn from huge text collections.\n- Open-weight models can run on your own computer.\n- Quantised models fit in consumer graphics memory.\n- Tool use lets them act, not only answer.' } }],
    ['', { text: 'Wrote the four key facts about large language models as a note.' }],
  ],
  Analyst: [
    ['Opening the Bitcoin page first.', { tool: 'browser_open', args: { url: 'https://en.wikipedia.org/wiki/Bitcoin', title: 'Bitcoin' } }],
    ['Reading it.', { tool: 'browser_read', id: true }],
    ['Now the live price from the paper account.', { tool: 'trading_ticker', args: { account: 'paper', symbol: 'BTC/USDT' } }],
    ['Scrolling to the design section.', { tool: 'browser_scroll', id: true, args: { direction: 'down', amount: 1200 } }],
    ['Reading the supply numbers.', { tool: 'browser_read', id: true }],
    ['A bit further to the mining part.', { tool: 'browser_scroll', id: true, args: { direction: 'down', amount: 1400 } }],
    ['And the price history.', { tool: 'browser_scroll', id: true, args: { direction: 'down', amount: 1400 } }],
    ['Writing the numbers down.', { tool: 'note_create', price: true, args: { title: 'Bitcoin: key numbers' } }],
    ['', { text: 'Noted the live BTC price and the key supply numbers.' }],
  ],
};

function nextStep(body) {
  const name = who(body);
  // The clean-up round after a task: close the browser it opened, then a short line.
  // (Another message can arrive in the same round, so look for the request itself.)
  const tidyAt = body.messages.map(m => m.role === 'user' && /Tidy up the canvas/.test(m.content || '')).lastIndexOf(true);
  if (tidyAt >= 0) {
    if (!body.messages.slice(tidyAt + 1).some(m => m.role === 'tool')) {
      const id = (body.messages[tidyAt].content.match(/id=(\S+)/) || [])[1];
      return id ? ['The task is done; this window is not needed any more.', { tool: 'item_close', args: { id } }] : ['', { text: 'Nothing to close.' }];
    }
    return ['', { text: 'Closed the window I used.' }];
  }
  const plan = PLANS[name] || PLANS.Researcher;
  const done = body.messages.filter(m => m.role === 'assistant').length;
  const step = plan[Math.min(done, plan.length - 1)];
  const [think, act] = step;
  const call = { ...act };
  if (act.id) call.args = { ...(act.args || {}), id: myBrowser(body) };
  if (act.price) {
    const t = body.messages.filter(m => m.role === 'tool' && m.name === 'trading_ticker').map(toolJson).pop() || {};
    const price = t.last ? Number(t.last).toLocaleString('en-US', { maximumFractionDigits: 0 }) : 'n/a';
    call.args = { title: 'Bitcoin: key numbers', content: `- Live price: **$${price}** (BTC/USDT)\n- Supply capped at 21 million coins.\n- About 19.9 million mined so far.\n- A block every ~10 minutes.` };
  }
  return [think, call];
}

function startMockModel({ pace = 1 } = {}) {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'officina-demo' }] })); }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    if (!body.stream) { // compression summaries and the like
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Summary.' } }] }));
    }
    const [think, act] = nextStep(body);
    // Thinking time before the answer starts, longer for the helpers so their work can be watched.
    await sleep((who(body) === 'CEO' ? 600 : 1700) * pace);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    // Reasoning appears word by word, like a real model thinking.
    for (const word of (think || '').split(' ').filter(Boolean)) { send({ choices: [{ delta: { reasoning_content: `${word} ` } }] }); await sleep(55 * pace); }
    await sleep(350 * pace);
    if (act.tool) send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, function: { name: act.tool, arguments: JSON.stringify(act.args || {}) } }] } }] });
    else for (const word of act.text.split(' ')) { send({ choices: [{ delta: { content: `${word} ` } }] }); await sleep(30 * pace); }
    send({ choices: [], usage: { prompt_tokens: 2400 + body.messages.length * 380, completion_tokens: 60 + (think || '').length / 4 } });
    res.end('data: [DONE]\n\n');
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

module.exports = { startMockModel };
