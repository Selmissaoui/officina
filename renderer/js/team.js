// The built-in agents in the chat dock. A tab per agent opens its chat; the Team tab
// shows every agent as a card with its own task box, so several agents can be put to
// work at once. Add, duplicate, rename and remove live on the tabs and the cards.
import { h, clear, toast, promptDialog, confirmDialog } from './ui.js';
import { openMenu } from './menu.js';
import { peekDialog } from './peek.js';
import { chatPanel, STEP_WORDS, stepDetail } from './chat.js';

const cleanError = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const modelName = a => (a.runner === 'builtin' ? a.model.split(/[\\/]/).pop().replace(/\.gguf$/i, '') : a.model) || 'no model yet';

function lastLine(a) {
  const l = a.last;
  if (!l) return 'Nothing yet. Give it a task below.';
  if (l.type === 'tool') return `${STEP_WORDS[l.name] || l.name}${l.status === 'running' ? '…' : ''}`;
  if (l.type === 'user') return `Task: ${l.text}`;
  return l.text;
}

export function teamPanel(body, ctx, opts = {}) {
  let team = [];
  let active = opts.agentId || 'team';
  let wantName = opts.agentName || null;
  let child = null;               // the open agent chat
  const unread = new Set();
  const drafts = new Map();       // agent id -> unsent task text on the Team view
  const cards = new Map();        // agent id -> { el, update(a) }

  const tabs = h('div', { class: 'team-tabs', role: 'tablist', 'aria-label': 'Agents' });
  const content = h('div', { class: 'team-content' });
  body.append(tabs, content);

  const run = async fn => { try { return await fn(); } catch (e) { toast(cleanError(e), 'error', 6000); return null; } };

  const addAgent = async () => { const id = await run(() => window.ac.teamAdd({})); if (id) { await load(); show(id, 'setup'); } };
  const duplicate = async a => { const id = await run(() => window.ac.teamDuplicate(a.id)); if (id) { await load(); toast(`Duplicated ${a.name}`, 'ok'); if (active !== 'team') show(id); } };
  const rename = async a => {
    const name = await promptDialog('Rename agent', 'Name', a.name);
    if (name && name.trim() && name.trim() !== a.name) { await run(() => window.ac.teamUpdate(a.id, { name: name.trim() })); await load(); }
  };
  const remove = async a => {
    if (!(await confirmDialog(`Remove ${a.name}?`, 'Its conversation is deleted. Notes and files it made stay in the Library.', 'Remove', 'danger'))) return;
    const ok = await run(() => window.ac.teamRemove(a.id));
    if (ok) { if (active === a.id) active = 'team'; await load(); render(); }
  };
  const agentMenu = (a, x, y) => openMenu(x, y, [
    { label: 'Open chat', action: () => show(a.id) },
    { label: 'Settings (model, instructions)', action: () => show(a.id, 'setup') },
    { label: 'Rename…', action: () => rename(a) },
    { label: 'Duplicate', action: () => duplicate(a) },
    { label: 'Clear conversation', action: () => window.ac.llmReset(a.id) },
    '-',
    { label: 'Remove…', danger: true, action: () => remove(a) },
  ]);

  // ---------- tabs ----------
  // Chips that wrap onto a second line instead of a strip you have to scroll. Each
  // leader's helpers sit right after it, smaller, so who works for whom is visible.
  const renderTabs = () => {
    clear(tabs);
    const tab = (id, label, extra = {}) => h('button', {
      class: `team-tab ${active === id ? 'on' : ''} ${extra.cls || ''}`, role: 'tab', 'aria-selected': String(active === id), title: extra.title || '',
      onclick: () => show(id), oncontextmenu: extra.menu ? e => { e.preventDefault(); extra.menu(e.clientX, e.clientY); } : null,
      style: extra.color ? { '--c': extra.color } : null,
    }, ...label);
    const chip = a => tab(a.id, [h('span', { class: `agent-dot ${a.busy ? 'busy' : ''}` }), h('span', { class: 'tab-name' }, a.name), unread.has(a.id) ? h('span', { class: 'dot on' }) : null],
      { color: a.color, cls: a.spawnedBy ? 'helper' : '', title: `${a.name}: ${a.busy ? 'working' : 'idle'}, ${modelName(a)}${a.spawnedBy ? `, helper of ${a.spawnedBy}` : ''}. Right-click for more.`, menu: (x, y) => agentMenu(a, x, y) });
    const busy = team.filter(a => a.busy).length;
    tabs.append(tab('team', [h('span', { class: 'i i-grid' }), 'Team', busy ? h('span', { class: 'tab-count', title: `${busy} working` }, String(busy)) : null], { title: 'Every agent at a glance: give tasks, message several at once' }));
    const tops = team.filter(a => !a.spawnedBy || !team.some(l => l.name === a.spawnedBy));
    for (const a of tops) {
      tabs.append(chip(a));
      for (const helper of team.filter(x => x.spawnedBy === a.name)) tabs.append(chip(helper));
    }
    tabs.append(h('button', { class: 'team-tab add', title: 'Add an agent', 'aria-label': 'Add an agent', onclick: addAgent }, '+'));
  };

  // ---------- Team view: one card per agent ----------
  const card = a => {
    const status = h('span', { class: 'card-status' });
    const model = h('span', { class: 'muted small model' });
    const line = h('p', { class: 'card-line' });
    const name = h('button', { class: 'card-name', title: 'Open chat', onclick: () => show(a.id) });
    const task = h('textarea', { class: 'input card-task', rows: '2', placeholder: `Task for ${a.name}…`, 'aria-label': `Task for ${a.name}` }, drafts.get(a.id) || '');
    const go = h('button', { class: 'btn small primary' });
    task.addEventListener('input', () => drafts.set(a.id, task.value));
    const send = async () => {
      const cur = team.find(x => x.id === a.id);
      if (cur?.busy) return run(() => window.ac.llmStop(a.id));
      const text = task.value.trim();
      if (!text) return task.focus();
      await run(() => window.ac.llmSend(a.id, text));
      task.value = ''; drafts.delete(a.id);
    };
    go.onclick = send;
    task.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || !e.shiftKey)) { e.preventDefault(); send(); } });
    const more = h('button', { class: 'btn small ghost', title: 'More', 'aria-label': `More for ${a.name}`, onclick: e => { const r = e.currentTarget.getBoundingClientRect(); agentMenu(team.find(x => x.id === a.id) || a, r.left, r.bottom); } }, '⋯');
    const el = h('div', { class: 'team-card', style: { '--c': a.color } },
      h('div', { class: 'row between' }, h('div', { class: 'card-head' }, h('span', { class: 'agent-dot' }), name), status),
      model, line, task,
      h('div', { class: 'row between' },
        h('div', { class: 'row gap' }, h('button', { class: 'btn small', onclick: () => show(a.id, 'setup') }, 'Model & settings'), h('button', { class: 'btn small ghost', title: 'See what this agent is doing: a picture or a short clip', onclick: () => peekDialog(a.name) }, 'Peek'), h('button', { class: 'btn small ghost', onclick: () => duplicate(team.find(x => x.id === a.id) || a) }, 'Duplicate'), more),
        go));
    const update = x => {
      name.textContent = x.name;
      el.style.setProperty('--c', x.color || '');
      el.classList.toggle('busy', x.busy);
      el.querySelector('.agent-dot').classList.toggle('busy', x.busy);
      status.textContent = x.busy ? 'Working' : x.last?.type === 'error' ? 'Error' : 'Idle';
      status.className = `card-status ${x.busy ? 'busy' : x.last?.type === 'error' ? 'bad' : ''}`;
      model.textContent = `${modelName(x)}${x.spawnedBy ? `, helper of ${x.spawnedBy}` : x.canLead ? ', can lead' : ''}`;
      line.textContent = lastLine(x);
      line.classList.toggle('bad', x.last?.type === 'error');
      go.textContent = x.busy ? 'Stop' : 'Send';
      go.className = `btn small ${x.busy ? 'danger' : 'primary'}`;
      task.placeholder = `Task for ${x.name}…`;
    };
    update(a);
    return { el, update };
  };

  // One message for several agents at once ("tell me your findings so far"). Busy agents
  // read it before their next step; idle agents start on it.
  const picked = new Set();
  let groupDraft = '';
  const groupBox = () => {
    for (const id of [...picked]) if (!team.some(a => a.id === id)) picked.delete(id);
    if (!picked.size) for (const a of team) picked.add(a.id);
    const text = h('textarea', { class: 'input group-text', rows: '2', placeholder: 'Message for the agents you tick, for example: tell me what you found so far', 'aria-label': 'Message for several agents' }, groupDraft);
    text.addEventListener('input', () => { groupDraft = text.value; });
    const who = h('div', { class: 'group-who' }, team.map(a => h('label', { class: 'group-pick', style: { '--c': a.color } },
      h('input', { type: 'checkbox', checked: picked.has(a.id), onchange: e => { if (e.target.checked) picked.add(a.id); else picked.delete(a.id); } }),
      h('span', { class: `agent-dot ${a.busy ? 'busy' : ''}` }), a.name)));
    const sendIt = async () => {
      const t = text.value.trim();
      if (!t) return text.focus();
      if (!picked.size) return toast('Tick at least one agent', 'warn');
      const r = await run(() => window.ac.teamBroadcast([...picked], t));
      if (!r) return;
      groupDraft = ''; text.value = '';
      const during = r.filter(x => x.delivered === 'during its task').length, started = r.filter(x => x.delivered === 'started').length;
      toast([started && `${started} started on it`, during && `${during} read it before their next step`].filter(Boolean).join(', ') || 'Sent', 'ok');
    };
    text.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendIt(); } });
    const busy = team.filter(a => a.busy).length;
    return h('div', { class: 'group-box', dataset: { busy: String(busy) } },
      h('div', { class: 'row between' }, h('strong', { class: 'small' }, 'Message several agents'),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn small ghost', onclick: () => { const all = picked.size === team.length; picked.clear(); if (!all) for (const a of team) picked.add(a.id); renderOverview(); } }, picked.size === team.length ? 'Tick none' : 'Tick all'))),
      who, text,
      h('div', { class: 'row between' },
        h('button', { class: 'btn small', disabled: !busy, title: 'Working agents stop exploring, save what they found and report back', onclick: async () => {
          const r = await run(() => window.ac.teamWrapUp(null));
          if (r) toast(r.asked.length ? `Asked ${r.asked.map(a => a.name).join(', ')} to round off` : 'Nobody is working', 'ok');
        } }, `Round off${busy ? ` (${busy} working)` : ''}`),
        h('button', { class: 'btn small primary', onclick: sendIt }, 'Send to ticked')));
  };

  const renderOverview = () => {
    clear(content);
    cards.clear();
    const grid = h('div', { class: 'team-grid' });
    for (const a of team) { const c = card(a); cards.set(a.id, c); grid.append(c.el); }
    grid.append(h('button', { class: 'team-card add-card', onclick: addAgent }, h('span', { class: 'plus' }, '+'), 'Add agent'));
    const startAll = h('button', { class: 'btn small primary', title: 'Send every typed task at once' }, 'Start all');
    startAll.onclick = async () => {
      const tasks = team.filter(a => !a.busy && (drafts.get(a.id) || '').trim()).map(a => ({ id: a.id, text: drafts.get(a.id) }));
      if (!tasks.length) return toast('Type a task in one or more cards first', 'warn');
      const started = await run(() => window.ac.teamSendMany(tasks));
      for (const id of started || []) drafts.delete(id);
      renderOverview();
      toast(`Started ${started?.length || 0} agent${started?.length === 1 ? '' : 's'}`, 'ok');
    };
    const stopAll = h('button', { class: 'btn small', onclick: () => run(() => window.ac.llmStop(null)) }, 'Stop all');
    content.append(
      groupBox(),
      h('div', { class: 'team-bar' }, h('p', { class: 'muted small' }, 'Or give each agent its own task in its card. Agents on the same built-in model share it, so extra agents cost no extra graphics memory.'),
        h('div', { class: 'row gap' }, startAll, stopAll)),
      grid);
  };

  // ---------- switching ----------
  const render = () => {
    child?.dispose?.();
    child = null;
    clear(content);
    content.className = `team-content ${active === 'team' ? 'overview' : 'panel-chat'}`;
    renderTabs();
    if (active === 'team') renderOverview();
  };

  function show(id, view) {
    active = team.some(a => a.id === id) ? id : 'team';
    unread.delete(active);
    render();
    if (active !== 'team') child = chatPanel(content, ctx, { agentId: active, view }) || null;
  }

  async function load() {
    team = await window.ac.teamList();
    if (wantName) { const a = team.find(x => x.name === wantName); wantName = null; if (a) active = a.id; }
    if (active !== 'team' && !team.some(a => a.id === active)) active = 'team';
  }

  const onTeam = list => {
    const membersChanged = list.length !== team.length || list.some((a, i) => team[i]?.id !== a.id);
    team = list;
    const busyChanged = active === 'team' && content.querySelector('.group-box') && team.filter(a => a.busy).length !== Number(content.querySelector('.group-box').dataset.busy || -1);
    if (active === 'team' && (membersChanged || busyChanged) && !content.contains(document.activeElement)) renderOverview();
    else if (active === 'team') for (const a of team) cards.get(a.id)?.update(a);
    renderTabs();
  };
  const off = window.ac.on('team:changed', onTeam);

  load().then(() => show(team.length === 1 && !team[0].model ? team[0].id : active));

  return {
    event(e) {
      if (active !== 'team' && e.agent === active) return child?.event?.(e);
      if (e.agent && (e.type === 'assistant' || e.type === 'error')) { unread.add(e.agent); renderTabs(); }
    },
    select(name) { const a = team.find(x => x.name === name); if (a) show(a.id); },
    refresh() { load().then(() => (active === 'team' ? render() : child?.refresh?.())); },
    dispose() { off(); child?.dispose?.(); },
  };
}
