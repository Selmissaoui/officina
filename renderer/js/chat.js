// Assistant panel: chat with a local model (Ollama, LM Studio, llama.cpp, ...)
// that works in the canvas through the same tools as external agents.
import { h, clear, toast, debounce } from './ui.js';
import { renderMarkdown } from './md.js';
import { isSimple, isGame } from './prefs.js';

export const STEP_WORDS = {
  workspace_overview: 'Looked at the canvas', browser_open: 'Opened a browser', browser_navigate: 'Went to a page', browser_read: 'Read the page',
  browser_find: 'Searched the page', browser_click: 'Clicked', browser_type: 'Typed', browser_key: 'Pressed a key', browser_scroll: 'Scrolled',
  browser_hover: 'Hovered', browser_drag: 'Dragged', browser_links: 'Listed links', browser_batch: 'Ran several steps', browser_screenshot: 'Took a screenshot',
  browser_wait: 'Waited for the page', note_create: 'Wrote a note', note_update: 'Updated a note', note_read: 'Read a note', file_write: 'Saved a file',
  file_read: 'Read a file', file_list: 'Listed files', library_search: 'Searched the Library', cursor_point: 'Pointed something out', item_arrange: 'Moved a window',
  item_focus: 'Showed you a window', item_close: 'Closed a window', trading_status: 'Checked trading limits', trading_ticker: 'Checked a price',
  trading_balance: 'Checked the balance', trading_place_order: 'Placed an order', trading_open_orders: 'Checked open orders', trading_cancel_order: 'Cancelled an order',
  trading_history: 'Checked the trade log', keys_list: 'Checked saved keys',
  team_spawn: 'Created a helper', team_assign: 'Gave a helper a task', team_wait: 'Waited for helpers', team_result: "Read a helper's answer",
  team_list: 'Checked the team', team_remove: 'Removed a helper', team_message: 'Messaged the team', canvas_organize: 'Organised the canvas',
};

const SUGGESTIONS = [
  'Create a note called My first task with a short checklist for today',
  'Search the web for three places to visit in Amsterdam and save a note with links',
  'Read the page in my browser and summarise it',
  'Tidy up my windows side by side',
];

export function stepDetail(name, a = {}) {
  if (a.url) return a.url;
  if (a.text && name === 'browser_type') return `“${String(a.text).slice(0, 40)}”`;
  if (a.text) return `“${String(a.text).slice(0, 40)}”`;
  if (a.ref != null) return `element ${a.ref}`;
  if (a.title) return a.title;
  if (a.symbol) return `${a.side || ''} ${a.amount || ''} ${a.symbol}`.trim();
  if (a.key) return a.key;
  if (a.message) return `“${String(a.message).slice(0, 50)}”`;
  if (name.startsWith('team_') && (a.name || a.task)) return a.name || `“${String(a.task).slice(0, 50)}”`;
  if (a.query) return `“${a.query}”`;
  return '';
}

// One agent's chat. opts.agentId picks the agent; without it, the first agent.
export function chatPanel(body, ctx, opts = {}) {
  const agentId = opts.agentId || null;
  let st = null;          // { log, busy, config }
  let view = opts.view === 'setup' ? 'setup' : 'chat';
  let logEl = null, sendBtn = null, input = null;

  const who = () => (isGame() ? 'Companion' : isSimple() ? 'AI' : 'Assistant');

  const renderEntry = e => {
    if (e.type === 'user') return h('div', { class: `msg user ${e.during ? 'during' : ''}`, dataset: { id: e.id } },
      e.during || e.from ? h('div', { class: 'msg-who' }, e.from ? `From ${e.from}${e.during ? ', while it works' : ''}` : 'While it works: read before its next step') : null,
      h('div', { class: 'bubble' }, e.text));
    if (e.type === 'assistant') return h('div', { class: 'msg ai', dataset: { id: e.id } }, h('div', { class: 'msg-who' }, who()), h('div', { class: 'bubble md', innerHTML: renderMarkdown(e.text) }));
    if (e.type === 'thinking') return renderThinking(e);
    if (e.type === 'compact') {
      const k = n => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n || 0));
      return h('details', { class: 'msg compact', dataset: { id: e.id } },
        h('summary', {}, `Chat compressed: about ${k(e.before)} → ${k(e.after)} tokens. Click to read the summary.`),
        h('div', { class: 'think-text' }, e.text));
    }
    if (e.type === 'tool') {
      const row = h('details', { class: `step s-${e.status}`, dataset: { id: e.id } },
        h('summary', {}, h('span', { class: 'step-icon' }), h('span', { class: 'step-name' }, STEP_WORDS[e.name] || e.name), h('span', { class: 'step-detail' }, stepDetail(e.name, e.args))),
        h('div', { class: 'step-body' }, isSimple() ? null : h('code', { class: 'step-args' }, `${e.name} ${JSON.stringify(e.args || {})}`), h('pre', { class: 'step-result' }, e.result || '')));
      return row;
    }
    if (e.type === 'error') return h('div', { class: 'msg notice error', dataset: { id: e.id } }, e.text);
    return h('div', { class: 'msg notice', dataset: { id: e.id } }, e.text);
  };

  const thinkingSummary = e => {
    if (e.live) return 'Thinking…';
    const first = String(e.text || '').trim().split(/\n/)[0] || '';
    return first ? `Thinking: ${first.length > 90 ? `${first.slice(0, 90)}…` : first}` : 'Thinking';
  };
  function renderThinking(e) {
    const el = h('details', { class: `msg thinking ${e.live ? 'live' : ''}`, dataset: { id: e.id }, open: !!e.live },
      h('summary', {}, thinkingSummary(e)),
      h('div', { class: 'think-text' }, e.text || ''),
      e.live && e.preview ? h('div', { class: 'think-preview' }, e.preview) : null);
    el.querySelector('summary').addEventListener('click', () => { el.dataset.userOpen = el.open ? '0' : '1'; });
    return el;
  }
  // Updates a thinking block in place, so the reader keeps their scroll position and open state.
  const updateThinking = (entry, done) => {
    const el = logEl?.querySelector(`[data-id="${entry.id}"]`);
    if (!el) return;
    const wasOpenByUser = el.dataset.userOpen === '1';
    el.classList.toggle('live', !done);
    el.querySelector('summary').textContent = thinkingSummary(entry);
    const body = el.querySelector('.think-text');
    body.textContent = entry.text || '';
    let prev = el.querySelector('.think-preview');
    if (!done && entry.preview) { if (!prev) { prev = h('div', { class: 'think-preview' }); el.append(prev); } prev.textContent = entry.preview; } else prev?.remove();
    if (!done) body.scrollTop = body.scrollHeight;
    if (done && !wasOpenByUser) el.open = false;
  };

  // Follow new messages only while the reader is at the bottom; scrolled up, the view stays put.
  const atBottom = () => !logEl || logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 90;
  const scrollDown = () => { if (logEl) logEl.scrollTop = logEl.scrollHeight; };
  let stopBtn = null, roundBtn = null;

  const setBusy = busy => {
    st.busy = busy;
    if (!sendBtn) return;
    sendBtn.title = busy ? 'It reads your message before its next step' : 'Send (Enter)';
    if (stopBtn) stopBtn.hidden = !busy;
    if (roundBtn) roundBtn.hidden = !busy;
    if (input) input.placeholder = busy ? 'Message while it works: it reads this before its next step…' : 'Ask for something… (Enter to send, Shift+Enter for a new line)';
    logEl?.classList.toggle('working', busy);
  };

  // ---------- chat view ----------
  const renderChat = () => {
    clear(body);
    const c = st.config;
    const runner = c.runners.find(r => r.id === c.runner);
    logEl = h('div', { class: 'chat-log' });
    if (!st.log.length) {
      logEl.append(h('div', { class: 'chat-empty' },
        h('p', {}, `Ask ${isGame() ? 'your companion' : 'the AI'} to do something in your canvas. You can watch its cursor while it works.`),
        h('div', { class: 'suggest' }, SUGGESTIONS.map(s => h('button', { class: 'chip-btn', onclick: () => { input.value = s; input.focus(); } }, s)))));
    } else {
      for (const e of st.log) logEl.append(renderEntry(e));
    }
    logEl.append(h('div', { class: 'typing-dots', 'aria-label': 'Working' }, h('i'), h('i'), h('i')));

    input = h('textarea', { class: 'chat-input', rows: '2', placeholder: 'Ask for something… (Enter to send, Shift+Enter for a new line)', 'aria-label': 'Message' });
    sendBtn = h('button', { class: 'btn primary send' }, 'Send');
    stopBtn = h('button', { class: 'btn danger send', title: 'Stop this agent now', hidden: true, onclick: () => window.ac.llmStop(st.config.id) }, 'Stop');
    const submit = async () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      try { await window.ac.llmSend(st.config.id, text); scrollDown(); } catch (e) { toast(e.message, 'error'); }
    };
    sendBtn.onclick = submit;
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });

    roundBtn = h('button', { class: 'btn small', hidden: true, title: 'Stop exploring, save what it found and report back', onclick: async () => { await window.ac.teamWrapUp([st.config.id]); toast(`Asked ${st.config.name} to round off`, 'ok'); } }, 'Round off');
    const modelLabel = c.runner === 'builtin' ? c.model.split(/[\\/]/).pop().replace(/\.gguf$/i, '') : c.model;
    body.append(
      h('div', { class: 'chat-bar' },
        h('button', { class: 'chat-model model-picker', title: `${runner?.label || c.runner}: ${modelLabel}. Click to change model.`, onclick: () => { view = 'setup'; render(); } }, h('span', {}, 'Model'), h('strong', {}, modelLabel), '▾'),
        h('div', { class: 'chat-actions' },
          roundBtn,
          h('button', { class: 'btn small', title: 'Change model, engine or instructions', onclick: () => { view = 'setup'; render(); } }, 'Agent settings'),
          h('button', { class: 'btn small ghost', title: 'Start a new conversation (stops the current task)', onclick: async () => {
            try { await window.ac.llmReset(st.config.id); } catch (e) { return toast(e.message, 'error'); }
            st.log = []; st.busy = false; render();
          } }, 'New chat'))),
      logEl,
      h('div', { class: 'composer' }, input, h('div', { class: 'composer-btns' }, stopBtn, sendBtn)),
    );
    setBusy(st.busy);
    scrollDown();
    setTimeout(() => input.focus(), 50);
  };

  // ---------- setup view ----------
  const renderSetup = async () => {
    clear(body);
    const c = st.config;
    const wrap = h('div', { class: 'setup' });
    body.append(wrap);
    const list = h('div', { class: 'runner-list' }, h('p', { class: 'muted small' }, 'Looking for local AI on this computer…'));
    const pick = { runner: c.runner, baseUrl: c.baseUrl, model: c.model };
    const warn = h('div', { class: 'model-warn', hidden: true });
    const vision = h('input', { type: 'checkbox', class: 'switch', checked: !!c.vision });
    const numCtx = h('select', { class: 'input' }, [8192, 16384, 32768, 65536, 131072].map(n => h('option', { value: n, selected: Number(c.numCtx) === n }, `${n / 1024}K tokens`)));
    const temp = h('input', { class: 'input', type: 'number', min: '0', max: '2', step: '0.1', value: c.temperature });
    const toolset = h('select', { class: 'input' }, h('option', { value: 'essential', selected: c.toolset !== 'all' }, 'Essential (best for small models)'), h('option', { value: 'all', selected: c.toolset === 'all' }, 'All tools'));
    const customUrl = h('input', { class: 'input', value: c.runner === 'custom' ? c.baseUrl : '', placeholder: 'http://127.0.0.1:8080/v1' });
    const apiKey = h('input', { class: 'input', type: 'password', placeholder: c.hasApiKey ? 'Saved. Leave empty to keep it.' : 'Only if the server needs one', autocomplete: 'off' });
    const saveBtn = h('button', { class: 'btn primary', disabled: !c.model }, c.model ? 'Save and return to chat' : 'Start chatting');
    const agentName = h('input', { class: 'input', value: c.name || '', maxlength: '24', 'aria-label': 'Agent name' });
    const canLead = h('input', { type: 'checkbox', class: 'switch', checked: !!c.canLead, disabled: !!c.spawnedBy });
    const role = h('textarea', { class: 'input', rows: '3', placeholder: 'What this agent is for, for example: "You research competitors and write one note per company."' }, c.role || '');

    const checkModel = async () => {
      saveBtn.disabled = !pick.model;
      warn.hidden = true;
      if (!pick.model) return;
      const info = await window.ac.llmModelInfo(pick.runner, pick.baseUrl, pick.model);
      const notes = [];
      if (info.tools === false) notes.push(`This model can't use tools, so it can't work in the canvas. Pick qwen3, qwen2.5, llama3.1, mistral-nemo or another model with tool support.`);
      if (info.vision === true) { vision.checked = true; notes.push('This model can see images, so screenshots are switched on.'); }
      if (info.vision === false) vision.checked = false;
      if (info.context && info.context < Number(numCtx.value)) notes.push(`The model supports up to ${Math.round(info.context / 1024)}K tokens of context.`);
      if (notes.length) { warn.hidden = false; warn.className = `model-warn ${info.tools === false ? 'bad' : ''}`; clear(warn).append(...notes.map(n => h('p', {}, n))); }
    };

    const runnerCard = r => {
      const sel = h('select', { class: 'input small', 'aria-label': `${r.label} model`, onchange: () => { Object.assign(pick, { runner: r.id, baseUrl: r.baseUrl, model: sel.value }); markPicked(); checkModel(); } },
        h('option', { value: '' }, r.models.length ? 'Choose a model…' : 'No models installed'),
        r.models.map(m => h('option', { value: m.id, selected: pick.runner === r.id && pick.model === m.id }, `${m.id}${m.params ? `  (${m.params})` : ''}`)));
      return h('div', { class: `runner ${r.running ? 'up' : 'down'}`, dataset: { id: r.id } },
        h('div', { class: 'row between' },
          h('span', { class: 'runner-name' }, h('span', { class: `dot ${r.running ? 'ok' : ''}` }), r.label),
          h('span', { class: 'muted small' }, r.running ? `${r.models.length} model${r.models.length === 1 ? '' : 's'}` : 'not running')),
        r.running ? sel : null,
        r.running && !r.models.length && r.id === 'ollama' ? h('p', { class: 'hint' }, 'Download a model first, e.g. in a terminal: ollama pull qwen3:8b') : null,
        !r.running && !isSimple() ? h('p', { class: 'hint' }, `Expected at ${r.baseUrl}`) : null);
    };
    const markPicked = () => wrap.querySelectorAll('.runner').forEach(el => el.classList.toggle('picked', el.dataset.id === pick.runner && !!pick.model));

    // ---------- built-in engine: models run inside Officina ----------
    const builtin = h('div', { class: 'runner builtin', dataset: { id: 'builtin' } });
    let engine = null;
    const gb = bytes => `${(bytes / 1e9).toFixed(1)} GB`;
    const install = async variant => {
      const r = await window.ac.engineInstall(variant);
      if (!r.ok) toast(r.message, 'error', 8000); else toast('Engine installed', 'ok');
      renderBuiltin();
    };
    const renderBuiltin = async status => {
      engine = status || await window.ac.engineStatus();
      clear(builtin);
      const s = engine;
      const title = h('div', { class: 'row between' },
        h('span', { class: 'runner-name' }, h('span', { class: `dot ${s.installed ? 'ok' : ''}` }), 'Built-in'),
        h('span', { class: 'muted small' }, s.installed ? (s.gpu ? s.gpu.name : s.installed.label) : 'no other app needed'));
      builtin.append(title);
      if (s.installing) {
        const pct = s.installing.total ? Math.round((s.installing.done / s.installing.total) * 100) : 0;
        builtin.append(h('progress', { class: 'engine-progress', max: '100', value: String(pct) }), h('p', { class: 'hint' }, `${s.installing.step}… ${pct}%`));
        return;
      }
      if (s.error) builtin.append(h('p', { class: 'hint bad' }, s.error));
      if (!s.installed) {
        builtin.append(
          h('p', { class: 'hint' }, 'Run your models right here, without LM Studio or Ollama open. Your LM Studio and Ollama models are found automatically.'),
          h('div', { class: 'row gap' },
            s.platform === 'darwin'
              ? h('button', { class: 'btn small primary', onclick: () => install(s.defaultVariant) }, s.defaultVariant === 'metal' ? 'Install engine (Metal, Apple Silicon)' : 'Install engine (Intel Mac)')
              : [h('button', { class: 'btn small primary', onclick: () => install('vulkan') }, 'Install engine (33 MB)'),
                h('button', { class: 'btn small', title: 'Faster on NVIDIA cards, but a much bigger download', onclick: () => install('cuda') }, 'NVIDIA: CUDA (about 580 MB)')]));
        return;
      }
      const r = await window.ac.llmModels('builtin');
      const models = r.ok ? r.models : [];
      const vramBytes = s.gpu ? (s.gpu.freeMiB ?? s.gpu.totalMiB) * 1048576 : 0;
      const fits = m => !vramBytes || m.size < vramBytes * 0.85;
      const sel = h('select', { class: 'input small', 'aria-label': 'Built-in model', onchange: () => { Object.assign(pick, { runner: 'builtin', baseUrl: '', model: sel.value }); markPicked(); checkModel(); } },
        h('option', { value: '' }, models.length ? 'Choose a model…' : 'No models found'),
        [...new Set(models.map(m => m.source))].map(source => h('optgroup', { label: source },
          models.filter(m => m.source === source).map(m => h('option', { value: m.id, selected: pick.runner === 'builtin' && pick.model === m.id },
            `${m.label}  (${gb(m.size)}${m.vision ? ', sees images' : ''}${fits(m) ? '' : ', partly on CPU: slower'})`)))));
      builtin.append(sel);
      builtin.append(h('p', { class: 'hint' }, 'Start with a smaller instruction model that supports tools. Q4 models use less memory than Q8. Leave room for the conversation; a model fitting on disk does not guarantee it fits in graphics memory. Close other model apps to free memory.'));
      if (!models.length) builtin.append(h('p', { class: 'hint' }, 'No models found yet. Download a tool-capable GGUF model using LM Studio, or copy a GGUF file into the models folder below. Then click Refresh models.'));
      builtin.append(h('div', { class: 'row gap' },
        h('button', { class: 'btn small', onclick: () => window.ac.openModelsFolder() }, 'Open models folder'),
        h('button', { class: 'btn small', onclick: () => renderBuiltin() }, 'Refresh models')));
      builtin.append(h('div', { class: 'row gap' },
        h('button', { class: 'btn small', title: 'Get the newest llama.cpp, needed for brand-new model types', onclick: () => install(s.installed.variant) }, 'Update engine'),
        s.platform === 'darwin' ? null : h('button', { class: 'btn small', onclick: () => install(s.installed.variant === 'cuda' ? 'vulkan' : 'cuda') }, s.installed.variant === 'cuda' ? 'Switch to Vulkan' : 'Switch to CUDA'),
        s.running ? h('button', { class: 'btn small', title: 'Frees the graphics memory', onclick: async () => { await window.ac.engineStop(); renderBuiltin(); } }, 'Unload model') : null));
      markPicked();
    };
    // Show download progress live, without rebuilding the model list on every status change.
    const offEngine = window.ac.on('engine:status', s => {
      if (!builtin.isConnected) return offEngine();
      if (s.installing || engine?.installing || !!s.installed !== !!engine?.installed) renderBuiltin(s);
    });

    const scan = async () => {
      clear(list).append(h('p', { class: 'muted small' }, 'Looking for local AI on this computer…'));
      const found = await window.ac.llmDetect();
      clear(list);
      const up = found.filter(r => r.running), down = found.filter(r => !r.running && r.id !== 'custom');
      if (!up.length) {
        list.append(h('p', { class: 'muted small' }, 'No other model app is running. That is fine: the built-in engine above works without one.'));
      }
      list.append(...up.map(runnerCard));
      if (down.length) list.append(h('details', { class: 'more' }, h('summary', {}, `Not running (${down.length})`), h('div', { class: 'more-body' }, down.map(runnerCard))));
      markPicked();
    };

    const custom = h('div', { class: 'form' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Server address (OpenAI-compatible)'), customUrl),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'API key'), apiKey),
      h('button', { class: 'btn small', onclick: async () => {
        const url = customUrl.value.trim();
        if (!url) return toast('Enter the server address', 'warn');
        const r = await window.ac.llmModels('custom', url, apiKey.value.trim());
        if (!r.ok) return toast(`Couldn't connect: ${r.message}`, 'error', 6000);
        const card = runnerCard({ id: 'custom', label: 'Other server', baseUrl: url, running: true, models: r.models });
        list.querySelector('.runner[data-id="custom"]')?.remove();
        list.prepend(card);
        toast(`Found ${r.models.length} model${r.models.length === 1 ? '' : 's'}`, 'ok');
      } }, 'Connect'));

    const advanced = [
      h('div', { class: 'grid2' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Context size'), numCtx), h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Temperature'), temp),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Tools'), toolset)),
      h('p', { class: 'hint' }, 'No step limit, but no endless work either: an agent keeps going as long as its steps turn up something new. When it finds nothing new for a while it is asked to check its own progress; if it stays stuck it rounds off and answers. On long tasks it also checks in with itself now and then (after 40, 80, 160 steps and so on). You can ask it to round off or send it a message any time. With the built-in engine the context is fitted to free graphics memory, at least 16K per agent when it fits.'),
      h('label', { class: 'toggle-row' }, h('span', { class: 'toggle-text' }, h('span', {}, 'Model can see images'), h('span', { class: 'hint' }, 'Only for vision models such as qwen2.5vl, gemma3 or llava.')), vision),
    ];

    saveBtn.onclick = async () => {
      if (!pick.model) return;
      const patch = { runner: pick.runner, baseUrl: pick.baseUrl, model: pick.model, numCtx: Number(numCtx.value), temperature: Number(temp.value), toolset: toolset.value, vision: vision.checked };
      if (apiKey.value.trim()) patch.apiKey = apiKey.value.trim();
      patch.role = role.value;
      patch.canLead = canLead.checked;
      if (agentName.value.trim() && agentName.value.trim() !== c.name) {
        try { await window.ac.teamUpdate(c.id, { name: agentName.value.trim() }); } catch (e) { return toast(e.message.replace(/^.*Error: /, ''), 'error'); }
      }
      st.config = await window.ac.llmSetConfig(c.id, patch);
      view = 'chat';
      render();
      toast(`Saved. ${st.config.name} uses ${pick.model.split(/[\\/]/).pop().replace(/\.gguf$/i, '')}`, 'ok');
    };

    wrap.append(
      h('h3', {}, c.model ? 'Agent settings' : 'Set up your first agent'),
      h('p', { class: 'hint' }, '1. Name your agent. 2. Install the engine and choose a model. 3. Save, then try a small task. You can change your model any time from the Model button above your chat.'),
      h('h4', { class: 'flush' }, '1 · Your agent'),
      h('div', { class: 'form' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), agentName),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Instructions for this agent'), role),
        h('label', { class: 'toggle-row' }, h('span', { class: 'toggle-text' }, h('span', {}, 'Can lead other agents'), h('span', { class: 'hint' }, c.spawnedBy ? `This agent is a helper of ${c.spawnedBy}; helpers cannot lead.` : 'It may create helper agents for big tasks, give each a part, wait for them and combine the answers. Helpers share its model, cannot make helpers themselves and cannot trade.')), canLead)),
      h('h3', {}, '2 · Engine and model'),
      h('p', { class: 'muted small' }, 'Recommended: use the built-in engine. The engine runs the AI; the model is a separate download. Install the engine below, then pick a model. If you already use a local model app, expand Other apps instead.'),
      builtin, warn,
      h('details', { class: 'more', open: !!c.model && c.runner !== 'builtin' }, h('summary', {}, 'Other apps on this computer'), h('div', { class: 'more-body' }, h('button', { class: 'btn small', onclick: scan }, 'Look again'), list)),
      h('details', { class: 'more' }, h('summary', {}, 'Use another server'), h('div', { class: 'more-body' }, custom)),
      h('details', { class: 'more' }, h('summary', {}, 'Advanced model settings'), h('div', { class: 'more-body' }, advanced)),
      h('h4', { class: 'flush' }, '3 · Try your agent'),
      h('p', { class: 'hint' }, 'Save your choice, then ask: “Create a note with a checklist for today.” The first message loads the model and can take a little longer. Use Stop if you want to interrupt it.'),
      h('div', { class: 'row gap setup-actions' }, saveBtn, c.model ? h('button', { class: 'btn', onclick: () => { view = 'chat'; render(); } }, 'Cancel') : null),
    );
    renderBuiltin();
    scan().then(() => { if (pick.model) checkModel(); });
  };

  const render = () => (view === 'setup' || !st.config.model ? renderSetup() : renderChat());

  window.ac.llmState(agentId).then(s => { st = s; render(); });

  return {
    event(e) {
      if (!st || (e.agent && e.agent !== st.config.id)) return;
      if (e.type === 'reset') { st.log = []; if (view === 'chat') render(); return; }
      if (e.type === 'busy') { setBusy(e.busy); return; }
      if (e.type === 'stream') {
        const entry = st.log.find(x => x.id === e.id);
        if (!entry) return;
        Object.assign(entry, { text: e.text, preview: e.preview, live: !e.done });
        if (view === 'chat') { const stick = atBottom(); updateThinking(entry, e.done); if (!e.done && stick) scrollDown(); }
        return;
      }
      if (e.type === 'remove') {
        st.log = st.log.filter(x => x.id !== e.id);
        logEl?.querySelector(`[data-id="${e.id}"]`)?.remove();
        return;
      }
      if (e.type === 'tool-update') {
        const entry = st.log.find(x => x.id === e.id);
        if (entry) Object.assign(entry, { status: e.status, result: e.result });
        const el = logEl?.querySelector(`[data-id="${e.id}"]`);
        const stick = atBottom();
        if (el && entry) el.replaceWith(renderEntry(entry));
        if (stick) scrollDown();
        return;
      }
      st.log.push(e);
      if (view !== 'chat' || !logEl) return;
      const stick = atBottom() || e.type === 'user';
      logEl.querySelector('.chat-empty')?.remove();
      logEl.insertBefore(renderEntry(e), logEl.querySelector('.typing-dots'));
      if (stick) scrollDown();
    },
    refresh: debounce(() => { if (st) render(); }, 50),
  };
}
