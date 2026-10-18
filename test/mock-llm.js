// A tiny scripted model server that speaks both the Ollama API and the
// OpenAI-compatible API, for testing the built-in assistant without a real model.
// Turn 1: ask for note_create. Turn 2 (after the tool result): reply with text.
const http = require('http');

function startMockLlm() {
  const received = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const json = (obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    received.push({ url: req.url, body });
    const last = body.messages?.[body.messages.length - 1];
    const afterTool = last?.role === 'tool';

    if (req.url === '/api/tags') return json({ models: [{ name: 'mock:7b', size: 4e9, details: { parameter_size: '7B' } }] });
    if (req.url === '/api/show') return json({ capabilities: body.model === 'notools:1b' ? ['completion'] : ['completion', 'tools'], model_info: { 'mock.context_length': 32768 } });
    if (req.url === '/api/chat') {
      if (body.model === 'missing:1b') return json({ error: `model "${body.model}" not found, try pulling it first` }, 404);
      if (afterTool) return json({ message: { role: 'assistant', content: 'Done. I wrote the note.' } });
      return json({ message: { role: 'assistant', content: '', thinking: 'The user wants a note.', tool_calls: [{ function: { name: 'note_create', arguments: { title: 'Mock idea', content: 'BTC long above 83k' } } }] } });
    }
    if (req.url === '/v1/models') return json({ data: [{ id: 'mock-oa' }, { id: 'mock-text' }] });
    if (req.url === '/v1/chat/completions') {
      if (afterTool) return json({ choices: [{ message: { role: 'assistant', content: '<think>check</think>All done.' } }] });
      if (body.model === 'mock-text') {
        return json({ choices: [{ message: { role: 'assistant', content: '<tool_call>{"name": "note_create", "arguments": {"title": "Text call", "content": "from text"}}</tool_call>' } }] });
      }
      return json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'note_create', arguments: '{"title":"OA idea","content":"ETH"}' } }] } }] });
    }
    json({ error: 'not found' }, 404);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received })));
}

module.exports = { startMockLlm };
