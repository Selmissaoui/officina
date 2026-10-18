// "Features" panel: every feature in one list, each with a short explanation
// and, where possible, a button that takes you straight to it.
import { h, clear } from './ui.js';
import { t } from './prefs.js';
import { openMenu } from './menu.js';

export const FEATURES = [
  { group: 'Canvas', items: [
    ['Infinite canvas', 'Drag the background to move, scroll to zoom, Fit shows everything.', { label: 'Show all', run: c => c.canvas.fitAll() }],
    ['Right-click menus', 'Duplicate, rename, resize, lock, colour and more on any window or the canvas.', { label: 'Show menu', run: c => { const r = document.getElementById('viewport').getBoundingClientRect(); openMenu(r.left + r.width / 2, r.top + r.height / 3, c.actions.backgroundMenu(c.canvas.center())); } }],
    ['Paste anything', 'Ctrl+V turns a link into a browser, text into a note and an image into a file.', { label: 'Paste now', run: c => c.actions.paste(c.canvas.center()) }],
    ['Undo close', 'Closing a window shows an Undo button.', { label: 'Shortcuts', run: c => c.openPanel('settings', { force: true }) }],
    ['Frames', 'Labelled areas to group windows on the canvas.', { label: 'Add a frame', run: c => c.addFrame?.() }],
    ['Spaces', 'Separate canvases, for example Research and Trading.', { label: 'Open spaces', run: c => c.openPanel('spaces', { force: true }) }],
  ] },
  { group: 'Browsers', items: [
    ['Live browsers side by side', 'Each browser keeps its own login, also after a restart.', { label: 'New browser', run: c => c.newBrowser() }],
    ['Find on page', 'Search text in any browser.', { label: 'Open', run: c => c.openPanel('comforts', { force: true }) }],
    ['Browser tools', 'Find, zoom, mute, PDF, downloads and separate windows.', {label:'Open',run:c=>c.openPanel('comforts',{force:true})}],
    ['Logged-out warning', 'You get a notice when a browser shows a login form again.', { label: 'Status', run: c => c.openPanel('rules', { force: true }) }],
  ] },
  { group: 'Saving', items: [
    ['Notes and files', 'Markdown notes, drag-and-drop files, PDF and image previews.', { label: 'New note', run: c => c.actions.newNoteAt(c.canvas.center()) }],
    ['Library', 'Everything saved in one searchable list.', { label: 'Open', run: c => c.openPanel('library', { force: true }) }],
    ['Backup and restore', 'Save the whole workspace to one file and bring it back later.', { label: 'Open settings', run: c => c.openPanel('backup', { force: true }) }],
  ] },
  { group: 'AI', items: [
    ['AI cursor', 'See every move, click and keystroke the AI makes. Turn it on or off.', { label: 'Options', run: () => document.getElementById('cursor-btn').click() }],
    ['Built-in assistant', 'Chat with a local model (Ollama, LM Studio, llama.cpp and more).', { label: 'Open', run: c => c.openPanel('chat', { force: true }) }],
    ['Agent memory', 'A note the AI always reads: your rules and preferences.', { label: 'Open memory', run: c => c.openMemory?.() }],
    ['Saved tasks and schedules', 'Reusable tasks you can run with one click or on a timer.', { label: 'Open tasks', run: c => c.openPanel('tasks', { force: true }) }],
    ['AI asks you', 'Take over a browser for a login, code or decision.', {label:'Requests',run:c=>c.openPanel('handoff',{force:true})}],
    ['Browser access rules', 'Per browser access, allowed sites and action confirmations.', {label:'Configure',run:c=>c.openPanel('rules',{force:true})}],
    ['Replay', 'A timeline of what the AI did, with screenshots.', { label: 'Open replay', run: c => c.openPanel('replay', { force: true }) }],
    ['Several agents at once', 'Every connected AI app and the assistant get their own coloured cursor with their name.', { label: 'Agents', run: c => c.openPanel('agents', { force: true }) }],
    ['Local API (MCP)', 'Officina has its own API at http://127.0.0.1:4780/mcp. Connect Claude Code or any MCP app; the panel shows the token and every tool.', { label: 'Open', run: c => c.openPanel('agent', { force: true }) }],
    ['Agents panel', 'See every AI at work in its own colour, pause one, or keep it away from trading.', { label: 'Open', run: c => c.openPanel('agents', { force: true }) }],
  ] },
  { group: 'Trading', items: [
    ['One-time approval with limits', 'Allow automatic trading once, within limits you set.', { label: 'Open', run: c => c.openPanel('trading', { force: true }) }],
    ['Protective orders', 'Stop-loss, take-profit and trailing exits, placed on the exchange where supported so they hold with the app closed. Risk limits, positions and close-all.', { label: 'Open', run: c => c.openPanel('positions', { force: true }) }],
    ['Practice account', 'Real prices, fake money.', { label: 'Open', run: c => c.openPanel('trading', { force: true }) }],
    ['Futures with a leverage cap', 'Off by default. When allowed, the agent cannot go above your maximum leverage.', { label: 'Open', run: c => c.openPanel('positions', { force: true }) }],
    ['API keys', 'Encrypted, linked to browsers.', { label: 'Open', run: c => c.openPanel('keys', { force: true }) }],
  ] },
  { group: 'Safety and app', items: [
    ['Stop button', 'Pauses every AI action and automatic trading instantly.', { label: 'Stop now', run: () => document.getElementById('stop-btn').click() }],
    ['Notifications', 'Desktop notifications and optional Telegram.', {label:'Configure',run:c=>c.openPanel('notifications',{force:true})}],
    ['Activity log', 'Everything the AI did.', { label: 'Open', run: c => c.openPanel('activity', { force: true }) }],
    ['Themes and modes', 'Professional or Gamified, Simple or Technical.', { label: 'Open settings', run: c => c.openPanel('settings', { force: true }) }],
    ['Reset space', 'Start over with an empty workspace (asks twice).', { label: 'Open settings', run: c => c.openPanel('settings', { force: true }) }],
  ] },
 {group:'More tools',items:[
 ['DCA and grid backtests','Simulate closing-price strategies with fees; no live orders.',{label:'Open',run:c=>c.openPanel('strategies',{force:true})}],
 ['Signals and phone companion','Authenticated webhook tasks, live canvas view and phone STOP.',{label:'Configure',run:c=>c.openPanel('signals',{force:true})}],
 ['Canvas widgets','Price cards, portfolio cards and CSV tables.',{label:'Add',run:c=>c.openPanel('widgets',{force:true})}],
 ['Voice input','Dictate and review a prompt; Windows voice typing fallback.',{label:'Open',run:c=>c.openPanel('voice',{force:true})}],
 ]},
];

export function featuresPanel(body, ctx) {
  const render = () => {
    clear(body);
    body.append(h('p', { class: 'muted small' }, 'Everything Officina can do. Press a button to go straight to it.'));
    for (const g of FEATURES) {
      body.append(h('section', { class: 'feat-group' },
        h('h3', {}, g.group),
        g.items.map(([name, desc, act]) => h('div', { class: 'feat' },
          h('div', { class: 'feat-text' }, h('strong', {}, name), h('span', {}, desc)),
          act ? h('button', { class: 'btn small', onclick: () => act.run(ctx) }, act.label) : null))));
    }
  };
  render();
  return { refresh: render };
}

export const FEATURES_WORD = () => t('features');
