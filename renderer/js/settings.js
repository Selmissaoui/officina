// Settings drawer: theme, appearance, mode, shortcuts, workspace and Reset space.
import { h, clear, toast, modal, confirmDialog } from './ui.js';
import { prefs, setPrefs, isSimple } from './prefs.js';

export const SHORTCUTS = [
  ['Ctrl+B', 'New browser'], ['Ctrl+N', 'New note'], ['Double-click canvas', 'New note at that spot'],
  ['Ctrl+V', 'Paste a link, text or image onto the canvas'], ['Ctrl+K', 'Search the Library'], ['Ctrl+J', 'Chat with a local AI'],
  ['Ctrl+0', 'Show everything'], ['Ctrl+1', 'Zoom to 100%'], ['Ctrl + / Ctrl −', 'Zoom in / out'],
  ['Ctrl+Shift+A', 'Tidy up windows'], ['Ctrl+Shift+O', 'Organise by kind: browsers, notes and files in their own blocks'], ['Del', 'Close the selected window (with Undo)'], ['Ctrl+D', 'Duplicate the selected window'],
  ['F2', 'Rename the selected window'], ['Enter', 'Zoom to the selected window'], ['Arrow keys', 'Nudge the selected window (Shift = bigger steps)'],
  ['Alt while dragging', 'Move freely without snapping'], ['Ctrl+Shift+C', 'Show or hide the AI cursor'], ['Right-click', 'Actions for a window or the canvas'], ['Ctrl+,', 'Settings'], ['Esc', 'Close panel or menu'],
];

function toggle(label, on, onChange, hint) {
  return h('label', { class: 'toggle-row' },
    h('span', { class: 'toggle-text' }, h('span', {}, label), hint ? h('span', { class: 'hint' }, hint) : null),
    h('input', { type: 'checkbox', class: 'switch', checked: on, onchange: e => onChange(e.target.checked) }));
}

function choice(name, options, current, onPick) {
  return h('div', { class: 'choices', role: 'radiogroup' }, options.map(o => h('label', { class: `choice ${current === o.value ? 'on' : ''}` },
    h('input', { type: 'radio', name, value: o.value, checked: current === o.value, onchange: () => onPick(o.value) }),
    o.swatch ? h('span', { class: `swatch swatch-${o.value}` }) : null,
    h('span', { class: 'choice-text' }, h('strong', {}, o.label), o.desc ? h('span', {}, o.desc) : null))));
}

// Programs installed into the space (Officina-Data/software), never onto the computer itself.
// Brave is the standard browser for new windows; the built-in browser stays available.
function softwareSection() {
  const sec = h('section', { class: 'set-section' }, h('h3', {}, 'Software in this space'), h('p', { class: 'muted small' }, 'Loading…'));
  const mb = n => `${Math.round(n / 1048576)} MB`;
  const render = async () => {
    const { list, browserEngine } = await window.ac.softwareStatus();
    const brave = list.find(x => x.id === 'brave');
    const card = s => {
      const pct = s.installing?.total ? Math.round((s.installing.done / s.installing.total) * 100) : 0;
      const act = async (fn, okText) => { try { const r = await fn(); if (r && r.ok === false) toast(r.message, 'error', 8000); else if (okText) toast(okText, 'ok'); } catch (e) { toast(e.message, 'error'); } render(); };
      return h('div', { class: 'card soft-card' },
        h('div', { class: 'row between' },
          h('strong', {}, s.name),
          h('span', { class: `status-pill ${s.installed ? 'on' : ''}` }, s.installing ? 'Installing' : s.installed ? `Installed ${s.installed.version}` : 'Not installed')),
        h('p', { class: 'muted small' }, s.description),
        s.installing ? [h('progress', { class: 'engine-progress', max: '100', value: String(pct) }), h('p', { class: 'hint' }, `${s.installing.step}… ${s.installing.total ? `${mb(s.installing.done)} of ${mb(s.installing.total)}` : ''}`)] : null,
        s.error ? h('p', { class: 'hint bad' }, s.error) : null,
        s.installing ? null : h('div', { class: 'row gap' },
          !s.installed ? h('button', { class: 'btn small primary', onclick: () => act(() => window.ac.softwareInstall(s.id), `${s.name} is installed`) }, `Install ${s.name}`) : null,
          s.update ? h('button', { class: 'btn small primary', onclick: () => act(() => window.ac.softwareInstall(s.id), `${s.name} is up to date`) }, `Update to ${s.latest}`) : null,
          s.installed ? h('button', { class: 'btn small danger-ghost', onclick: async () => { if (await confirmDialog(`Remove ${s.name}?`, 'Brave windows on the canvas stop until it is installed again. Their logins stay.', 'Remove', 'danger')) act(() => window.ac.softwareRemove(s.id)); } }, 'Remove') : null));
    };
    sec.replaceChildren(
      h('h3', {}, 'Software in this space'),
      h('p', { class: 'muted small' }, 'Programs Officina downloads into its own folder and runs from there. They are not installed on your computer and share nothing with your own copies: Brave here has its own logins, history and settings. Downloads are checked against the publisher’s checksum.'),
      ...list.map(card),
      h('h4', {}, 'Browser for new windows'),
      choice('engine', [
        { value: 'brave', label: 'Brave (standard)', desc: brave?.installed ? 'Brave Shields block ads, so sites that detect ad blockers rarely get in the way.' : 'Installs Brave first (about 250 MB). Until then new windows use the built-in browser.' },
        { value: 'builtin', label: 'Built-in browser', desc: 'The browser inside Officina, with its own ad and cookie blocker.' },
      ], browserEngine, async v => { await window.ac.setBrowserEngine(v); if (v === 'brave' && !brave?.installed && !brave?.installing) window.ac.softwareInstall('brave').then(r => { if (!r.ok) toast(r.message, 'error', 8000); }); render(); }),
      h('p', { class: 'hint' }, 'Windows that are already open keep their browser, because a login lives in that browser. Right-click a window to open the same page in the other browser.'));
  };
  render();
  const off = window.ac.on('software:status', () => { if (!sec.isConnected) return off(); render(); });
  return sec;
}

// Ad, tracker and cookie-banner blocking: on for every browser unless switched off.
function adblockSection(ctx) {
  const sec = h('section', { class: 'set-section' }, h('h3', {}, 'Ad and cookie blocking'), h('p', { class: 'muted small' }, 'Loading…'));
  window.ac.adblockStatus().then(s => {
    const allow = h('textarea', { class: 'input', rows: '3', placeholder: 'One site per line, for example example.com' }, s.allow.join('\n'));
    const save = async patch => { const next = await window.ac.adblockConfigure(patch); ctx.setAdblockState?.(next); return next; };
    sec.replaceChildren(
      h('h3', {}, 'Ad and cookie blocking'),
      h('p', { class: 'muted small' }, 'Blocks ads, trackers and cookie banners in every browser, with the filter lists uBlock Origin and Brave use. Pages load faster and agents read less clutter. ' + (s.ready ? 'Lists are loaded and refreshed every week.' : s.error || 'Lists are loading.')),
      toggle('Block ads and cookie banners', s.enabled, v => save({ enabled: v }), 'Each browser also has a shield button to switch it off just there.'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Sites where nothing is blocked'), allow),
      h('button', { class: 'btn small', onclick: async () => { await save({ allow: allow.value.split(/[\n,]+/) }); toast('Saved. Reload a page to see the change.', 'ok'); } }, 'Save sites'));
  });
  return sec;
}

const TABS = [['general', 'General'], ['browsers', 'Browsers'], ['appearance', 'Appearance'], ['workspace', 'Workspace']];
let lastTab = 'general';

// Agent behaviour that is the same for every agent.
function agentsSection() {
  const sec = h('section', { class: 'set-section' }, h('h3', {}, 'Agents'));
  window.ac.agentPrefs().then(p => {
    sec.append(toggle('Tidy up after a task', p.tidy, async v => { await window.ac.setAgentPrefs({ tidy: v }); toast(v ? 'Agents close windows they opened and no longer need' : 'Agents leave their windows open', 'ok'); },
      'An agent closes browser windows it opened and no longer needs. When it is not sure you still want one, it leaves it open.'),
    h('p', { class: 'hint' }, 'Agents have no step limit: they work as long as they keep finding something new, check themselves when they stop making progress, and round off when they stay stuck.'));
  });
  return sec;
}

export function settingsPanel(body, ctx, opts = {}) {
  let tab = opts.tab || lastTab;
  const render = () => {
    clear(body);
    lastTab = tab;
    const rerender = async patch => { await setPrefs(patch); render(); };
    const tabs = h('div', { class: 'set-tabs', role: 'tablist' }, TABS.map(([id, label]) => h('button', { class: `set-tab ${tab === id ? 'on' : ''}`, role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; render(); body.scrollTop = 0; } }, label)));
    const sections = {
      general: () => [
        h('section', { class: 'set-section' },
          h('h3', {}, 'Mode'),
          choice('mode', [
            { value: 'simple', label: 'Simple', desc: 'Plain language and fewer technical details. Everything still works; extra options sit behind “More”.' },
            { value: 'technical', label: 'Technical', desc: 'Shows everything: MCP details, tokens, ports, raw activity and every trading limit.' },
          ], prefs.mode, v => rerender({ mode: v }))),
        agentsSection(),
        h('section', { class: 'set-section' },
          h('h3', {}, isSimple() ? 'Watch the AI' : 'AI cursor'),
          h('p', { class: 'muted small' }, 'The AI has its own cursor on the canvas, separate from your mouse. You see it move, click, type and scroll.'),
          toggle('Show the AI cursor', prefs.cursor.show, v => rerender({ cursor: { ...prefs.cursor, show: v } }), 'When off, the AI works without the animation, which is faster.'),
          toggle('Follow the AI around the canvas', prefs.cursor.follow, v => rerender({ cursor: { ...prefs.cursor, follow: v } }), 'Moves your view to the window the AI is working in.'),
          toggle('Show what it is doing', prefs.cursor.captions, v => rerender({ cursor: { ...prefs.cursor, captions: v } }), 'Short captions next to the cursor, like “Click Log in”.'),
          h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Cursor speed' }, [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']].map(([v, l]) =>
            h('button', { class: `seg-btn ${prefs.cursor.speed === v ? 'on' : ''}`, onclick: () => rerender({ cursor: { ...prefs.cursor, speed: v } }) }, l)))),
      ],
      browsers: () => [softwareSection(), adblockSection(ctx)],
      appearance: () => [
        h('section', { class: 'set-section' },
        h('h3', {}, 'Theme'),
        choice('theme', [
          { value: 'pro', label: 'Professional', desc: 'Calm and clean, with light and dark versions.', swatch: true },
          { value: 'game', label: 'Gamified', desc: 'Tower-climbing status windows. Your work earns floors and clears daily quests.', swatch: true },
        ], prefs.theme, v => rerender({ theme: v })),
        prefs.theme === 'pro'
          ? h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Appearance' }, [['light', 'Light'], ['dark', 'Dark'], ['system', 'Match Windows']].map(([v, l]) =>
            h('button', { class: `seg-btn ${prefs.appearance === v ? 'on' : ''}`, onclick: () => rerender({ appearance: v }) }, l)))
          : h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Your name on the status screen'),
            h('input', { class: 'input', value: ctx.playerName(), maxlength: '24', onchange: e => { ctx.setPlayerName(e.target.value.trim() || 'Climber'); toast('Name saved', 'ok'); } }))),
        h('section', { class: 'set-section' },
          h('h3', {}, 'Keyboard shortcuts'),
          h('table', { class: 'tbl keys-tbl' }, SHORTCUTS.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d))))),
      ],
      workspace: () => [
      h('section', { class: 'set-section' },
        h('h3', {}, 'Workspace'),
        h('p', { class: 'muted small' }, isSimple() ? 'Everything you save in Officina is kept in one folder next to the app.' : ctx.dataDir),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn small', onclick: () => window.ac.openDataFolder() }, 'Open folder'),
          h('button', { class: 'btn small', onclick: () => ctx.showDisclaimer(false) }, 'Read the disclaimer again'))),

      h('section', { class: 'set-section danger-zone' },
        h('h3', {}, 'Reset space'),
        h('p', { class: 'muted small' }, 'Start over with an empty workspace. This deletes every window, note, file, key, login and trade record.'),
        h('button', { class: 'btn danger-ghost', onclick: () => confirmReset() }, 'Reset space…')),
      ],
    };
    body.append(tabs, ...sections[tab]());
  };

  render();
  return { refresh: render };
}

async function confirmReset() {
  const word = h('input', { class: 'input', placeholder: 'RESET', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Type RESET to confirm' });
  const agree = h('input', { type: 'checkbox' });
  let resetBtn;
  const sync = () => { resetBtn.disabled = !(agree.checked && word.value.trim() === 'RESET'); };
  word.addEventListener('input', sync);
  agree.addEventListener('change', sync);

  const go = await modal({
    title: 'Reset the whole space?',
    body: h('div', { class: 'form' },
      h('p', {}, 'This permanently deletes:'),
      h('ul', {},
        h('li', {}, 'every window on the canvas and every note'),
        h('li', {}, 'all files, screenshots and downloads in the workspace'),
        h('li', {}, 'all saved logins in the browsers (you will be signed out everywhere)'),
        h('li', {}, 'all API keys, the auto-trading approval, the trade log and the history'),
        h('li', {}, 'every agent except the first one, all chats and the token count (the first agent keeps its model)')),
      h('p', { class: 'muted small' }, 'Your theme, mode, AI assistant connection and installed software (Brave) stay as they are. Files you exported earlier are not affected.'),
      h('label', { class: 'check' }, agree, ' I understand this cannot be undone'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Type RESET to confirm'), word)),
    actions: [{ label: 'Cancel', value: false }, { label: 'Delete everything', kind: 'danger', id: 'reset', disabled: true, value: true }],
    onReady: ({ buttons }) => { resetBtn = buttons.find(b => b.dataset.action === 'reset'); },
  });
  if (!go) return;
  try {
    await window.ac.resetWorkspace(word.value.trim());
  } catch (e) {
    toast(e.message, 'error');
  }
}
