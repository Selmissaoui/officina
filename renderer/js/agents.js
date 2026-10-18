// Agents panel: every AI working in the canvas, each in its own colour (the
// same colour as its cursor and its window highlight), with live status,
// what it's doing right now, and per-agent pause / trading permission.
import { h, clear, toast, timeAgo, clock, confirmDialog } from './ui.js';
import { isSimple } from './prefs.js';

const STATUS = { working: 'Working', idle: 'Idle', away: 'Not connected', paused: 'Paused' };
const ACTION_WORDS = {
  browser_read: 'reading a page', browser_click: 'clicking', browser_type: 'typing', browser_navigate: 'opening a page', browser_open: 'opening a browser',
  browser_scroll: 'scrolling', browser_screenshot: 'taking a screenshot', note_create: 'writing a note', note_update: 'updating a note', file_write: 'saving a file',
  trading_place_order: 'placing an order', trading_ticker: 'checking a price', cursor_point: 'pointing something out', ask_user: 'waiting for you',
  workspace_overview: 'looking at the canvas', item_arrange: 'moving a window',
};

export function avatar(a, size = 'md') {
  return h('span', { class: `agent-avatar ${size} ${a.status}`, style: { '--c': a.color }, title: `${a.name}: ${STATUS[a.status] || a.status}` }, a.name.slice(0, 1).toUpperCase());
}

export function agentsPanel(body, ctx) {
  let list = [];
  // The list updates while agents work. Rebuilding it used to throw the reader back to the
  // top and fold open sections, so the scroll position and open sections are kept.
  const render = () => {
    const top = body.scrollTop;
    const open = new Set([...body.querySelectorAll('.agent-card[data-name] details[open]')].map(d => d.closest('.agent-card').dataset.name));
    build();
    for (const card of body.querySelectorAll('.agent-card[data-name]')) if (open.has(card.dataset.name)) card.querySelector('details')?.setAttribute('open', '');
    body.scrollTop = top;
  };
  let pendingRender = null, lastRender = 0;
  const renderSoon = () => {
    if (pendingRender) return;
    const wait = Math.max(0, 1000 - (Date.now() - lastRender));
    pendingRender = setTimeout(() => { pendingRender = null; lastRender = Date.now(); render(); }, wait);
  };
  // One compact row per agent: who, what it is doing, and its switches. Built-in agents
  // and outside apps (connected over the local API) are listed in their own group.
  const row = a => {
    const recent = ctx.state.activity.filter(e => e.agent === a.name).slice(-8).reverse();
    const color = h('input', { type: 'color', class: 'agent-color', value: a.color, title: 'Change colour', onchange: e => window.ac.agentsUpdate(a.name, { color: e.target.value }) });
    const doing = a.status === 'working' || a.itemTitle
      ? h('button', { class: 'agent-now', onclick: () => a.itemId && ctx.canvas.focus(a.itemId), disabled: !a.itemId, title: a.itemId ? 'Show this window' : '' },
        h('span', { class: 'muted' }, a.status === 'working' ? 'Now ' : 'Last: '), ACTION_WORDS[a.lastAction] || (a.lastAction || '').replace(/_/g, ' '), a.itemTitle ? h('strong', {}, ` in “${a.itemTitle}”`) : null)
      : null;
    return h('div', { class: `card agent-card s-${a.status}`, style: { '--c': a.color }, dataset: { name: a.name } },
      h('div', { class: 'agent-row' },
        avatar(a, 'md'),
        h('div', { class: 'agent-main' },
          h('div', { class: 'agent-name' }, h('span', { class: 'agent-name-text' }, a.name), color),
          h('div', { class: 'muted small' }, h('span', { class: `agent-status s-${a.status}` }, STATUS[a.status] || a.status),
            a.lastSeen && a.status !== 'working' ? ` · ${timeAgo(a.lastSeen)}` : '', ` · ${a.actions} action${a.actions === 1 ? '' : 's'}`)),
        h('div', { class: 'agent-acts' },
          a.builtIn ? h('button', { class: 'btn small ghost', onclick: () => ctx.openPanel('chat', { force: true, agentName: a.name }) }, 'Chat') : null,
          h('button', { class: `btn small ${a.paused ? 'primary' : 'ghost'}`, title: a.paused ? 'Let this agent continue' : 'Pause only this agent', onclick: async () => { list = await window.ac.agentsUpdate(a.name, { paused: !a.paused }); toast(`${a.name} ${a.paused ? 'resumed' : 'paused'}`, 'ok'); render(); } }, a.paused ? 'Resume' : 'Pause'))),
      doing,
      h('div', { class: 'agent-foot' },
        h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: a.canTrade, onchange: async e => { list = await window.ac.agentsUpdate(a.name, { canTrade: e.target.checked }); render(); } }), ' May trade'),
        recent.length ? h('details', { class: 'agent-recent' }, h('summary', {}, `Recent actions (${recent.length})`), h('div', { class: 'agent-feed' },
          recent.map(e => h('div', { class: `agent-feed-row ${/failed|rejected/.test(e.action) ? 'bad' : ''}` }, h('span', { class: 'act-time' }, clock(e.time)), h('span', {}, e.action.replace(/_/g, ' ')))))) : h('span', { class: 'muted small' }, 'No actions yet'),
        !a.builtIn ? h('button', { class: 'btn small danger-ghost', onclick: async () => { if (await confirmDialog('Forget this agent?', `${a.name} is removed from the list. If it connects again it shows up as new.`, 'Forget', 'danger')) { list = await window.ac.agentsForget(a.name); render(); } } }, 'Forget') : null));
  };

  const build = () => {
    clear(body);
    const working = list.filter(a => a.status === 'working').length;
    const builtIn = list.filter(a => a.builtIn), outside = list.filter(a => !a.builtIn);
    body.append(
      h('div', { class: 'agents-summary' },
        h('div', { class: 'stat' }, h('strong', {}, String(working)), h('span', {}, 'working')),
        h('div', { class: 'stat' }, h('strong', {}, String(builtIn.length)), h('span', {}, 'built in')),
        h('div', { class: 'stat' }, h('strong', {}, String(outside.filter(a => a.status !== 'away').length)), h('span', {}, 'apps connected'))),
      h('p', { class: 'muted small flush' }, 'Each agent has its own colour: its cursor, the windows it works in and its history. Pause one without stopping the others; the Stop button stops all of them.'),
      h('div', { class: 'row between' }, h('h3', { class: 'flush' }, 'Built-in agents'), h('button', { class: 'btn small ghost', onclick: () => ctx.openPanel('chat', { force: true }) }, 'Manage')),
      ...builtIn.map(row),
      h('div', { class: 'row between' }, h('h3', { class: 'flush' }, isSimple() ? 'Other AI apps' : 'Apps over the local API'),
        h('button', { class: 'btn small primary', onclick: () => ctx.openPanel('agent', { force: true }) }, isSimple() ? 'Connect another AI' : 'Connect an app')),
      ...(outside.length ? outside.map(row) : [h('p', { class: 'muted small flush' }, 'No outside app has connected yet. Claude Code, Codex or any MCP client can work here too.')]));
  };
  window.ac.agentsList().then(l => { list = l; render(); });
  const off = window.ac.on('agents:changed', l => { list = l; if (!body.contains(document.activeElement) || document.activeElement.type !== 'color') renderSoon(); });
  const tick = setInterval(renderSoon, 5000);
  return { refresh: render, dispose() { off(); clearInterval(tick); clearTimeout(pendingRender); } };
}
