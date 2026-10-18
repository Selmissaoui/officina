// Side-drawer panels. Each panel is a function(body, ctx, opts) that renders
// into the drawer and returns an optional { refresh, add, dispose }.
// Simple mode keeps every feature but uses plain words and tucks the
// technical knobs behind "More".
import { h, clear, toast, timeAgo, clock, bytes, debounce, confirmDialog, modal, metaLine } from './ui.js';
import { t, isSimple, isGame } from './prefs.js';
import { settingsPanel } from './settings.js';
import { statusPanel } from './game.js';
import { teamPanel } from './team.js';
import { agentsPanel } from './agents.js';
import { connectorsPanel } from './connectors.js';
import { strategiesPanel, tasksPanel, memoryPanel, notificationsPanel, handoffPanel, rulesPanel, spacesPanel, positionsPanel, replayPanel, backupPanel, signalsPanel, comfortsPanel, widgetsPanel, voicePanel } from './roadmap.js';
import { featuresPanel } from './features.js';

const KIND_ICON = { note: 'note', image: 'image', screenshot: 'image', pdf: 'file', text: 'file', other: 'file', download: 'download', trade: 'chart', browser: 'globe' };
const KIND_WORD = { note: 'note', image: 'image', screenshot: 'screenshot', pdf: 'PDF', text: 'text file', other: 'file', download: 'download', trade: 'trade', browser: 'browser' };
const POPULAR_EXCHANGES = ['binance', 'bybit', 'okx', 'kraken', 'coinbase', 'bitvavo', 'kucoin', 'gate', 'bitget', 'mexc', 'htx', 'cryptocom', 'bitstamp', 'bitfinex', 'hyperliquid'];

function whoWord(who) {
  if (who === 'agent') return isSimple() ? 'AI' : isGame() ? 'companion' : 'agent';
  if (who === 'browser') return 'download';
  if (who === 'system') return 'app';
  return 'you';
}

function byBadge(who) {
  return h('span', { class: `by ${who === 'agent' ? 'agent' : who === 'browser' ? 'browser' : ''}` }, whoWord(who));
}

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
}

function more(summary, ...content) {
  return h('details', { class: 'more' }, h('summary', {}, summary), h('div', { class: 'more-body' }, content));
}

// ---------------- Library ----------------
export function libraryPanel(body, ctx, opts = {}) {
  const state = { query: opts.query || '', kind: 'all', createdBy: 'all' };
  const search = h('input', { class: 'input', placeholder: 'Search notes, files, trades…', type: 'search', value: state.query, 'aria-label': 'Search' });
  const kinds = [['all', 'All'], ['note', 'Notes'], ['file', 'Files'], ['screenshot', 'Screenshots'], ['download', 'Downloads'], ['trade', 'Trades'], ['browser', 'Browsers']];
  const chips = h('div', { class: 'chips' }, kinds.map(([k, label]) => h('button', { class: `chip-btn ${k === 'all' ? 'on' : ''}`, dataset: { k }, onclick: () => { state.kind = k; chips.querySelectorAll('.chip-btn').forEach(c => c.classList.toggle('on', c.dataset.k === k)); load(); } }, label)));
  const who = h('select', { class: 'input small', 'aria-label': 'Made by', onchange: () => { state.createdBy = who.value; load(); } },
    h('option', { value: 'all' }, 'Made by anyone'), h('option', { value: 'agent' }, `Made by the ${whoWord('agent')}`), h('option', { value: 'user' }, 'Made by you'));
  const count = h('span', { class: 'muted small' });
  const list = h('div', { class: 'lib-list' });
  body.append(
    h('div', { class: 'panel-tools' }, search, chips, h('div', { class: 'row between' }, who, count)),
    list,
    h('div', { class: 'panel-foot' }, h('button', { class: 'btn ghost', onclick: () => window.ac.openDataFolder() }, 'Open the workspace folder')),
  );

  const open = async e => {
    if (e.kind === 'trade') return ctx.openPanel('trading');
    if (e.itemId) return ctx.canvas.focus(e.itemId);
    if (e.kind === 'note') {
      const it = await window.ac.addItem({ type: 'note', id: e.id, title: e.name });
      return setTimeout(() => ctx.canvas.focus(it.id), 50);
    }
    if (e.kind === 'browser') {
      const it = await window.ac.addItem({ type: 'browser', profile: e.profile, url: e.url, title: e.name.replace(/ \(closed\)$/, '') });
      return setTimeout(() => ctx.canvas.focus(it.id), 50);
    }
    if (e.path) ctx.openFile(e.path);
  };

  const load = async () => {
    const entries = await window.ac.library({ ...state, limit: 400 });
    count.textContent = `${entries.length} item${entries.length === 1 ? '' : 's'}`;
    clear(list);
    if (!entries.length) list.append(h('p', { class: 'empty' }, state.query ? 'Nothing matches that search.' : 'Nothing saved yet. Notes, files, screenshots, downloads and trades will show up here.'));
    for (const e of entries) {
      list.append(h('button', { class: 'lib-row', onclick: () => open(e), title: e.path || e.name },
        h('span', { class: `lib-icon k-${e.kind}` }, h('span', { class: `i i-${KIND_ICON[e.kind] || 'file'}` })),
        h('span', { class: 'lib-main' },
          h('span', { class: 'lib-name' }, e.name),
          metaLine('lib-meta', [byBadge(e.createdBy), KIND_WORD[e.kind] || e.kind, timeAgo(e.updatedAt || e.createdAt), e.size != null ? bytes(e.size) : null, e.itemId ? 'on canvas' : null]),
          e.snippet ? h('span', { class: 'lib-snippet' }, e.snippet) : null)));
    }
  };
  search.addEventListener('input', debounce(() => { state.query = search.value; load(); }, 200));
  load();
  setTimeout(() => search.focus(), 50);
  return { refresh: debounce(load, 300) };
}

// ---------------- API keys ----------------
export function keysPanel(body, ctx, opts = {}) {
  let exchanges = [];
  window.ac.exchanges().then(list => { exchanges = list; });

  const render = () => {
    clear(body);
    const keys = ctx.state.keys;
    body.append(
      h('div', { class: 'callout' }, isSimple()
        ? [h('strong', {}, 'Your keys are locked with your Windows account.'), ' The AI can use an exchange key to trade within your limits, but it can never see the key itself.']
        : [h('strong', {}, ctx.state.keysEncrypted ? 'Encrypted with Windows DPAPI.' : 'Warning: OS encryption is unavailable, keys are stored unencrypted.'), ' Keys stay in this workspace. Agents never receive exchange secrets; they trade through the app, inside the limits you approve.']),
      h('div', { class: 'row between' }, h('h3', {}, `Saved keys (${keys.length})`), h('button', { class: 'btn primary', onclick: () => form() }, '+ Add key')),
    );
    if (!keys.length) body.append(h('p', { class: 'empty' }, isSimple() ? 'No keys yet. Add the key from your exchange to let the AI trade for you, then link it to the browser where that exchange is open.' : 'No keys yet. Add an exchange API key to trade, then link it to the browser where that exchange is open.'));
    for (const k of keys) {
      const linked = (k.linkedBrowsers || []).map(p => ctx.profileLabel(p));
      const kindLine = k.kind === 'exchange'
        ? [k.exchange, k.sandbox ? h('span', { class: 'tag' }, isSimple() ? 'practice' : 'testnet') : h('span', { class: 'tag live' }, isSimple() ? 'real money' : 'live')]
        : ['other service', k.agentReadable ? h('span', { class: 'tag' }, `${whoWord('agent')} can read`) : h('span', { class: 'tag' }, 'private')];
      body.append(h('div', { class: `card key-card ${opts.profile && (k.linkedBrowsers || []).includes(opts.profile) ? 'highlight' : ''}` },
        h('div', { class: 'row between' },
          h('div', {}, h('div', { class: 'card-title' }, k.label), metaLine('muted small key-kind', kindLine)),
          h('div', { class: 'row gap' },
            k.kind === 'exchange' ? h('button', { class: 'btn small', onclick: async ev => { ev.target.disabled = true; ev.target.textContent = 'Testing…'; const r = await window.ac.keysTest(k.id); ev.target.disabled = false; ev.target.textContent = 'Test'; toast(r.message, r.ok ? 'ok' : 'error', 6000); } }, 'Test') : null,
            h('button', { class: 'btn small', onclick: () => form(k) }, 'Edit'),
            h('button', { class: 'btn small danger-ghost', onclick: async () => { if (await confirmDialog('Delete this key?', `“${k.label}” will be removed from the workspace. This cannot be undone.`, 'Delete', 'danger')) { await window.ac.keysDelete(k.id); toast('Key deleted'); } } }, 'Delete'))),
        isSimple() ? null : metaLine('mono small muted', k.kind === 'exchange' ? [`key ${k.apiKeyMasked || 'none'}`, `secret ${k.secretMasked || 'none'}`, k.has_password ? 'passphrase saved' : null] : [`value ${k.valueMasked || 'none'}`]),
        h('div', { class: 'linked' }, h('span', { class: 'muted small' }, 'Linked browsers:'), linked.length ? linked.map(l => h('span', { class: 'tag browser' }, l)) : h('span', { class: 'muted small' }, 'none'))));
    }
  };

  const form = (existing = null) => {
    const isEdit = !!existing;
    const simple = isSimple();
    const kind = h('select', { class: 'input' }, h('option', { value: 'exchange' }, simple ? 'Crypto exchange' : 'Exchange (trading)'), h('option', { value: 'other' }, simple ? 'Another service' : 'Other API key'));
    kind.value = existing?.kind || 'exchange';
    const label = h('input', { class: 'input', value: existing?.label || '', placeholder: 'e.g. Binance main' });
    const exchange = h('input', { class: 'input', value: existing?.exchange || '', placeholder: 'binance', list: 'exchange-list', spellcheck: 'false' });
    const datalist = h('datalist', { id: 'exchange-list' }, [...new Set([...POPULAR_EXCHANGES, ...exchanges])].map(e => h('option', { value: e })));
    const keep = has => (isEdit && has ? 'Leave empty to keep the saved value' : '');
    const apiKey = h('input', { class: 'input mono', placeholder: keep(existing?.has_apiKey), autocomplete: 'off', spellcheck: 'false' });
    const secret = h('input', { class: 'input mono', type: 'password', placeholder: keep(existing?.has_secret), autocomplete: 'off' });
    const password = h('input', { class: 'input mono', type: 'password', placeholder: keep(existing?.has_password) || 'Only some exchanges ask for this (OKX, KuCoin, Bitget)', autocomplete: 'off' });
    const uid = h('input', { class: 'input mono', value: existing?.uid || '', placeholder: 'Only if your exchange needs it' });
    const sandbox = h('input', { type: 'checkbox', checked: existing ? !!existing.sandbox : false });
    const value = h('input', { class: 'input mono', type: 'password', placeholder: keep(existing?.has_value), autocomplete: 'off' });
    const agentReadable = h('input', { type: 'checkbox', checked: !!existing?.agentReadable });
    const profiles = ctx.allProfiles();
    const preselected = new Set(existing?.linkedBrowsers || (opts.profile ? [opts.profile] : []));
    const links = profiles.map(p => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: p.profile, checked: preselected.has(p.profile) }), ` ${p.label}`, p.closed ? h('span', { class: 'muted small' }, ' (closed)') : null));

    const exFields = h('div', { class: 'form' },
      field('Exchange', exchange, simple ? 'Type the name of your exchange, for example binance or kraken.' : 'Any exchange supported by ccxt (100+).'), datalist,
      field(simple ? 'Key' : 'API key', apiKey), field(simple ? 'Secret' : 'API secret', secret),
      simple ? more('More fields', field('Passphrase', password), field('UID', uid)) : [field('Passphrase', password), more('More fields', field('UID', uid))],
      h('label', { class: 'check' }, sandbox, simple ? ' This is a practice (testnet) key' : ' Testnet / sandbox key'),
      h('p', { class: 'hint' }, simple
        ? 'Find this on your exchange website under “API management”. Allow trading only and switch withdrawals off.'
        : 'Create the key with trading permission only, never withdrawals.'));
    const otherFields = h('div', { class: 'form' }, field(simple ? 'Key' : 'Value', value), h('label', { class: 'check' }, agentReadable, ` Let the ${whoWord('agent')} read this key`));
    const sync = () => { exFields.hidden = kind.value !== 'exchange'; otherFields.hidden = kind.value === 'exchange'; };
    kind.onchange = sync; sync();

    const bodyEl = h('div', { class: 'form' },
      field(simple ? 'What is this key for?' : 'Type', kind), field('Name', label), exFields, otherFields,
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Link to browsers'),
        links.length ? h('div', { class: 'checks' }, links) : h('span', { class: 'muted small' }, 'Open a browser first to link it.'),
        h('span', { class: 'hint' }, `Linked keys show on that browser window, so the ${whoWord('agent')} knows which account belongs to which site.`)));

    modal({
      title: isEdit ? `Edit ${existing.label}` : 'Add a key', body: bodyEl, wide: true,
      actions: [{ label: 'Cancel', value: false }, {
        label: isEdit ? 'Save' : 'Add key', kind: 'primary', onClick: async () => {
          const entry = { id: existing?.id, kind: kind.value, label: label.value.trim(), linkedBrowsers: links.map(l => l.querySelector('input')).filter(c => c.checked).map(c => c.value) };
          if (kind.value === 'exchange') {
            const ex = exchange.value.trim().toLowerCase();
            if (!ex) { toast('Choose an exchange', 'warn'); return false; }
            if (exchanges.length && !exchanges.includes(ex)) { toast(`“${exchange.value}” is not a supported exchange`, 'warn'); return false; }
            if (!isEdit && (!apiKey.value.trim() || !secret.value.trim())) { toast('The key and the secret are both needed', 'warn'); return false; }
            Object.assign(entry, { exchange: ex, apiKey: apiKey.value, secret: secret.value, password: password.value, uid: uid.value.trim(), sandbox: sandbox.checked });
          } else {
            if (!isEdit && !value.value.trim()) { toast('Paste the key first', 'warn'); return false; }
            Object.assign(entry, { value: value.value, agentReadable: agentReadable.checked });
          }
          await window.ac.keysSave(entry);
          toast(isEdit ? 'Key saved' : 'Key added', 'ok');
          return true;
        },
      }],
    });
  };

  render();
  if (opts.create) form();
  return { refresh: render };
}

// ---------------- Trading ----------------
export function tradingPanel(body, ctx) {
  let selected = 'paper';

  const render = () => {
    const tr = ctx.state.trading;
    const m = tr.mandate;
    const simple = isSimple();
    clear(body);

    const maxOrder = h('input', { class: 'input', type: 'number', min: '1', step: '1', value: m.maxOrderUsd });
    const maxDay = h('input', { class: 'input', type: 'number', min: '1', step: '1', value: m.maxDailyUsd });
    const maxCount = h('input', { class: 'input', type: 'number', min: '1', step: '1', value: m.maxOrdersPerDay });
    const symbols = h('input', { class: 'input', value: m.allowedSymbols, placeholder: 'Leave empty for any coin, or e.g. BTC/USDT, ETH/USDT' });
    const expiry = h('select', { class: 'input' }, [['', 'Never'], ['24', 'After 24 hours'], ['168', 'After 7 days'], ['720', 'After 30 days']].map(([v, l]) => h('option', { value: v }, l)));
    const accLabel = a => (a.exchange === 'paper' ? (simple ? 'practice money' : 'simulated') : a.live ? (simple ? 'real money' : 'LIVE') : (simple ? 'practice' : 'testnet'));
    const accChecks = tr.accounts.map(a => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: a.id, checked: m.accounts.includes(a.id) }), ` ${a.label} `, h('span', { class: `tag ${a.live ? 'live' : ''}` }, accLabel(a))));
    const collect = () => ({
      maxOrderUsd: Number(maxOrder.value), maxDailyUsd: Number(maxDay.value), maxOrdersPerDay: Number(maxCount.value), allowedSymbols: symbols.value,
      accounts: accChecks.map(l => l.querySelector('input')).filter(c => c.checked).map(c => c.value),
      expiresAt: expiry.value ? new Date(Date.now() + Number(expiry.value) * 3600e3).toISOString() : null,
    });

    const approve = async () => {
      const p = collect();
      if (!p.accounts.length) return toast('Tick at least one account', 'warn');
      const live = p.accounts.filter(id => tr.accounts.find(a => a.id === id)?.live);
      const ok = await confirmDialog(simple ? 'Let the AI trade for you?' : 'Approve auto-trading',
        h('div', {}, h('p', {}, simple ? 'From now on the AI can buy and sell without asking you first, but only within these limits:' : 'Agents will place orders automatically, without asking each time, within these limits:'),
          h('ul', {}, h('li', {}, `At most $${p.maxOrderUsd} per trade and $${p.maxDailyUsd} per day (${p.maxOrdersPerDay} trades a day)`),
            h('li', {}, `Coins: ${p.allowedSymbols || 'any'}`), h('li', {}, `Accounts: ${p.accounts.map(id => tr.accounts.find(a => a.id === id)?.label).join(', ')}`),
            h('li', {}, `Ends: ${p.expiresAt ? new Date(p.expiresAt).toLocaleString() : 'only when you turn it off'}`)),
          live.length ? h('p', { class: 'warn-text' }, 'This includes accounts with real money. You can switch it off at any time, and the stop button halts trading instantly.') : null),
        simple ? 'Yes, allow it' : 'Approve', live.length ? 'danger' : 'primary');
      if (!ok) return;
      try { await window.ac.setMandate({ ...p, enabled: true }); toast(simple ? 'The AI may now trade within your limits' : 'Auto-trading approved', 'ok'); } catch (e) { toast(e.message, 'error'); }
    };

    const extraLimits = [field('Max trades per day', maxCount), field('Allowed coins', symbols), field('Approval ends', expiry)];
    body.append(h('div', { class: `card mandate ${m.enabled ? 'on' : ''}` },
      h('div', { class: 'row between' }, h('h3', {}, simple ? 'Automatic trading' : 'Auto-trading approval'), h('span', { class: `status-pill ${m.enabled && !tr.halted ? 'on' : ''}` }, m.enabled ? (tr.halted ? 'Paused' : 'On') : 'Off')),
      h('p', { class: 'muted small' }, m.enabled
        ? `Approved ${timeAgo(m.approvedAt)}. ${simple ? 'The AI trades on its own within these limits.' : 'Agents trade automatically within these limits.'}`
        : (simple ? 'Allow it once and the AI can trade on its own, never above the limits you set here.' : 'Approve once and agents can trade automatically within your limits. No prompt per trade.')),
      h('div', { class: 'grid2' }, field(simple ? 'Max per trade ($)' : 'Max per order (USD)', maxOrder), field(simple ? 'Max per day ($)' : 'Max per day (USD)', maxDay)),
      simple ? more('More limits', ...extraLimits) : h('div', { class: 'grid2' }, extraLimits),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, simple ? 'Which accounts may it use?' : 'Accounts agents may trade'), h('div', { class: 'checks' }, accChecks),
        h('span', { class: 'hint' }, `Add exchange accounts under ${t('keys')}.`)),
      h('div', { class: 'usage' }, `Today: ${tr.usage.orders} ${simple ? 'AI trades' : 'agent orders'}, $${tr.usage.notionalUsd.toFixed(2)} of $${m.maxDailyUsd} used`),
      h('div', { class: 'row gap' }, m.enabled
        ? [h('button', { class: 'btn primary', onclick: async () => { try { await window.ac.setMandate(collect()); toast('Limits saved', 'ok'); } catch (e) { toast(e.message, 'error'); } } }, 'Save limits'),
          h('button', { class: 'btn danger-ghost', onclick: async () => { await window.ac.setMandate({ enabled: false }); toast(simple ? 'Automatic trading is off' : 'Auto-trading revoked'); } }, simple ? 'Turn off' : 'Revoke')]
        : h('button', { class: 'btn primary', onclick: approve }, simple ? 'Allow automatic trading' : 'Approve auto-trading'))));

    const accSel = h('select', { class: 'input', 'aria-label': 'Account' }, tr.accounts.map(a => h('option', { value: a.id, selected: a.id === selected }, `${a.label}${a.exchange !== 'paper' ? ` (${a.exchange}, ${accLabel(a)})` : ''}`)));
    const balBox = h('div', { class: 'bal' }, h('p', { class: 'muted small' }, 'Loading…'));
    const ordBox = h('div', { class: 'orders' });
    const loadAccount = async () => {
      clear(balBox).append(h('p', { class: 'muted small' }, 'Loading…'));
      const [b, o] = await Promise.all([window.ac.balance(selected), window.ac.openOrders(selected)]);
      clear(balBox);
      if (!b.ok) balBox.append(h('p', { class: 'error-text' }, b.message));
      else if (!Object.keys(b.result).length) balBox.append(h('p', { class: 'muted small' }, 'No balance.'));
      else balBox.append(h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, simple ? 'Coin' : 'Asset'), h('th', {}, 'Total'), h('th', {}, simple ? 'Available' : 'Free')),
        Object.entries(b.result).map(([c, v]) => h('tr', {}, h('td', {}, c), h('td', { class: 'num' }, fmtNum(v.total)), h('td', { class: 'num' }, fmtNum(v.free))))));
      clear(ordBox);
      if (o.ok && o.result.length) {
        ordBox.append(h('h4', {}, simple ? 'Waiting orders' : 'Open orders'), h('table', { class: 'tbl' }, o.result.map(x => h('tr', {}, h('td', {}, `${x.side} ${x.amount} ${x.symbol}`), h('td', { class: 'num' }, `at ${x.price}`),
          h('td', {}, h('button', { class: 'btn small danger-ghost', onclick: async () => { const r = await window.ac.cancelOrder({ accountId: selected, orderId: x.id, symbol: x.symbol }); toast(r.ok ? 'Order cancelled' : r.message, r.ok ? 'ok' : 'error'); loadAccount(); } }, 'Cancel'))))));
      }
    };
    accSel.onchange = () => { selected = accSel.value; loadAccount(); };

    const sym = h('input', { class: 'input', value: 'BTC/USDT', spellcheck: 'false' });
    const side = h('select', { class: 'input' }, h('option', { value: 'buy' }, 'Buy'), h('option', { value: 'sell' }, 'Sell'));
    const type = h('select', { class: 'input' }, h('option', { value: 'market' }, simple ? 'Now, at the current price' : 'Market'), h('option', { value: 'limit' }, simple ? 'Only at my price' : 'Limit'));
    const amount = h('input', { class: 'input', type: 'number', step: 'any', placeholder: simple ? 'e.g. 0.001' : 'Amount (base)' });
    const price = h('input', { class: 'input', type: 'number', step: 'any', placeholder: 'Your price', disabled: true });
    const quote = h('span', { class: 'muted small' });
    type.onchange = () => { price.disabled = type.value !== 'limit'; };
    const getQuote = async () => { const r = await window.ac.ticker(selected, sym.value.trim().toUpperCase()); quote.textContent = r.ok ? `Last ${fmtNum(r.result.last)}, bid ${fmtNum(r.result.bid)}, ask ${fmtNum(r.result.ask)}` : r.message; };
    const place = async ev => {
      const live = tr.accounts.find(a => a.id === selected)?.live;
      if (live && !(await confirmDialog('Real-money order', `${side.value === 'buy' ? 'Buy' : 'Sell'} ${amount.value} ${sym.value} on a real-money account?`, 'Place order', 'danger'))) return;
      ev.target.disabled = true;
      const r = await window.ac.placeOrder({ accountId: selected, symbol: sym.value.trim(), side: side.value, type: type.value, amount: amount.value, price: price.value || undefined, reason: 'manual' });
      ev.target.disabled = false;
      toast(r.ok ? `Order ${r.result.status}: ${r.result.side} ${r.result.amount} ${r.result.symbol}` : r.message, r.ok ? 'ok' : 'error', 6000);
      loadAccount();
    };

    const accountActions = selected === 'paper' ? h('button', { class: 'btn small', onclick: async () => { if (await confirmDialog('Reset practice account', 'Set the practice account back to 10,000 USDT?', 'Reset')) { await window.ac.paperReset(10000); loadAccount(); } } }, simple ? 'Reset practice money' : 'Reset paper') : null;
    const orderForm = [
      h('div', { class: 'grid2' }, field(simple ? 'Coin pair' : 'Symbol', sym), field('Buy or sell', side), field(simple ? 'When' : 'Type', type), field(simple ? 'How much' : 'Amount', amount), field(simple ? 'Your price' : 'Price', price)),
      h('div', { class: 'row gap' }, h('button', { class: 'btn', onclick: getQuote }, 'Get price'), h('button', { class: 'btn primary', onclick: place }, 'Place order')), quote,
    ];
    body.append(h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h3', {}, simple ? 'Your account' : 'Account'), h('div', { class: 'row gap' }, accountActions, h('button', { class: 'btn small', onclick: loadAccount }, 'Refresh'))),
      accSel, balBox, ordBox,
      simple ? more('Place an order yourself', ...orderForm) : [h('h4', {}, 'Manual order'), ...orderForm]));

    const log = h('div', { class: 'card' }, h('h3', {}, simple ? 'Recent trades' : 'Trade log'));
    if (!tr.history.length) log.append(h('p', { class: 'muted small' }, 'No trades yet.'));
    for (const r of tr.history) {
      log.append(h('div', { class: `trade-row s-${r.status}` },
        h('div', { class: 'row between' }, h('span', { class: 'trade-what' }, byBadge(r.actor), `${r.side === 'sell' ? 'Sell' : 'Buy'} ${r.amount} ${r.symbol}`), h('span', { class: `status s-${r.status}` }, statusWord(r.status))),
        metaLine('muted small', [r.accountLabel || r.account, clock(r.time), r.notionalUsd ? `about $${r.notionalUsd}` : null, r.price ? `at ${fmtNum(r.price)}` : null]),
        r.error ? h('div', { class: 'error-text small' }, r.error) : null,
        r.reason && r.reason !== 'manual' ? h('div', { class: 'small reason' }, r.reason) : null));
    }
    body.append(log);
    loadAccount();
  };

  render();
  return {
    refresh: () => {
      // Don't wipe a form the user is typing in; only re-render when idle.
      if (body.contains(document.activeElement) && document.activeElement.matches('input, select')) return;
      render();
    },
  };
}

function statusWord(s) {
  if (!isSimple()) return s;
  return { filled: 'done', rejected: 'blocked by your limits', error: 'failed', open: 'waiting', submitted: 'sent' }[s] || s;
}

function fmtNum(n) {
  if (n == null || n === '') return 'n/a';
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  return Math.abs(x) >= 1000 ? x.toLocaleString(undefined, { maximumFractionDigits: 2 }) : Number(x.toPrecision(8)).toString();
}

// ---------------- Activity ----------------
const HUMAN = {
  browser_open: 'opened a browser', browser_navigate: 'went to a page', browser_read: 'read a page', browser_find: 'searched a page',
  browser_click: 'clicked on a page', browser_type: 'typed text', browser_key: 'pressed a key', browser_scroll: 'scrolled a page',
  browser_screenshot: 'took a screenshot', browser_wait: 'waited for a page', note_create: 'wrote a note', note_update: 'updated a note',
  file_write: 'saved a file', item_arrange: 'moved a window', item_close: 'closed a window', item_focus: 'showed you a window',
  trading_cancel_order: 'cancelled an order', key_get_value: 'used a key', 'trade.filled': 'trade done', 'trade.open': 'order waiting',
  'trade.rejected': 'trade blocked by your limits', 'trade.error': 'trade failed', 'trade.cancel': 'order cancelled',
  'mandate.approved': 'allowed automatic trading', 'mandate.updated': 'changed trading limits', 'agent.stopped': 'stopped the AI',
  'agent.resumed': 'let the AI continue', 'download.started': 'download started', 'download.completed': 'downloaded a file',
  'download.failed': 'download failed', 'files.import': 'added files', 'folder.import': 'added a folder', 'file.export': 'exported a file',
  'key.saved': 'saved a key', 'item.close': 'closed a window', 'disclaimer.accepted': 'accepted the disclaimer',
  'sessions.restored': 'restored browser logins', 'browser.logout': 'logged out of a browser', 'workspace.reset': 'reset the space', 'paper.reset': 'reset practice money',
};

function humanDetail(e) {
  try {
    const a = JSON.parse(e.detail);
    if (a.url) return a.url;
    if (a.title) return a.title;
    if (a.path) return a.path;
    if (a.symbol) return `${a.side || ''} ${a.amount || ''} ${a.symbol}`.trim();
    return '';
  } catch {
    return e.action.startsWith('trade.') || e.action.startsWith('download') ? e.detail : '';
  }
}

export function activityPanel(body, ctx) {
  let filter = 'all';
  const list = h('div', { class: 'act-list' });
  const sel = h('select', { class: 'input small', 'aria-label': 'Filter', onchange: () => { filter = sel.value; render(); } },
    h('option', { value: 'all' }, 'Everyone'), h('option', { value: 'agent' }, `Only the ${whoWord('agent')}`), h('option', { value: 'user' }, 'Only you'), h('option', { value: 'system' }, 'App and downloads'));
  body.append(h('div', { class: 'panel-tools row between' }, h('span', { class: 'muted small' }, isSimple() ? 'Everything the AI does shows up here.' : 'Every agent action is logged here and in activity.jsonl.'), sel), list);
  const row = e => {
    const failed = /failed|rejected|error/.test(e.action);
    if (isSimple()) {
      const base = e.action.replace(/ failed$/, '');
      const words = HUMAN[base] || base.replace(/[_.]/g, ' ');
      const detail = humanDetail(e);
      return h('div', { class: `act-row simple a-${e.actor} ${failed ? 'bad' : ''}` },
        h('span', { class: 'act-time' }, clock(e.time)), agentBadge(e, ctx) || byBadge(e.actor),
        h('span', { class: 'act-action' }, e.action.endsWith(' failed') ? `${words} (didn’t work)` : words),
        detail ? h('span', { class: 'act-detail' }, detail) : null);
    }
    return h('div', { class: `act-row a-${e.actor} ${failed ? 'bad' : ''}` },
      h('span', { class: 'act-time mono' }, clock(e.time)), agentBadge(e, ctx) || byBadge(e.actor), h('span', { class: 'act-action' }, e.action), h('span', { class: 'act-detail' }, e.detail));
  };
  const match = e => filter === 'all' || (filter === 'system' ? ['system', 'browser'].includes(e.actor) : e.actor === filter);
  const render = () => {
    const top = body.scrollTop; // a rebuild keeps the reader where they were
    clear(list);
    const items = ctx.state.activity.filter(match).slice(-300).reverse();
    if (!items.length) list.append(h('p', { class: 'empty' }, isSimple() ? 'Nothing yet. Connect your AI assistant to get started.' : 'No activity yet. Connect an agent from the Agent panel.'));
    list.append(...items.map(row));
    body.scrollTop = top;
  };
  render();
  return { add: e => { if (match(e)) { list.querySelector('.empty')?.remove(); list.prepend(row(e)); } }, refresh: render };
}

// ---------------- Agent / MCP ----------------
function agentBadge(e, ctx) {
  if (!e.agent) return null;
  const a = (ctx.state.agents || []).find(x => x.name === e.agent);
  return h('span', { class: 'by agent named', style: a ? { background: a.color, color: '#fff' } : null }, e.agent);
}

// Live list of every tool the local API offers, grouped by area.
function apiReference() {
  const box = h('div', { class: 'api-ref' }, h('p', { class: 'muted small' }, 'Loading…'));
  window.ac.mcpTools().then(tools => {
    const groups = {};
    for (const t of tools) (groups[t.name.split('_')[0]] ||= []).push(t);
    const names = { browser: 'Browsers', trading: 'Trading', note: 'Notes', file: 'Files', item: 'Windows', memory: 'Memory', keys: 'Keys', key: 'Keys', cursor: 'Cursor', workspace: 'Canvas', canvas: 'Canvas', library: 'Library', ask: 'Ask the user' };
    clear(box).append(h('p', { class: 'muted small' }, `${tools.length} tools. Send MCP requests (JSON-RPC over HTTP POST) to the address above with the header Authorization: Bearer <token>.`),
      ...Object.entries(groups).map(([g, list]) => h('details', { class: 'more' }, h('summary', {}, `${names[g] || g} (${list.length})`),
        h('div', { class: 'api-list' }, list.map(t => h('div', { class: 'api-tool' }, h('code', {}, t.name), t.readOnly ? h('span', { class: 'tag' }, 'read only') : null, h('p', {}, t.description), t.params.length ? h('span', { class: 'muted small mono' }, t.params.join(', ')) : null))))));
  });
  return box;
}

function technicalAgent(ctx, render, state) {
  const s = ctx.state.mcp;
  const token = state.reveal ? s.token : '•'.repeat(24);
  const claudeCmd = `claude mcp add --transport http officina ${s.url} --header "Authorization: Bearer ${s.token}"`;
  const json = JSON.stringify({ mcpServers: { 'officina': { type: 'http', url: s.url, headers: { Authorization: `Bearer ${s.token}` } } } }, null, 2);
  const stdio = JSON.stringify({ mcpServers: { 'officina': { command: 'npx', args: ['-y', 'mcp-remote', s.url, '--header', `Authorization: Bearer ${s.token}`] } } }, null, 2);
  const copyBtn = (text, label = 'Copy') => h('button', { class: 'btn small', onclick: () => { window.ac.copy(text); toast('Copied', 'ok'); } }, label);
  const port = h('input', { class: 'input small', type: 'number', value: s.port, min: '1024', max: '65535', 'aria-label': 'Port' });
  return [
    h('div', { class: `card ${s.running ? 'ok-card' : 'bad-card'}` },
      h('div', { class: 'row between' }, h('h3', {}, 'Local API (MCP)'), h('span', { class: `status-pill ${s.running ? 'on' : ''}` }, s.running ? 'Running' : (s.enabled ? 'Error' : 'Off'))),
      h('p', { class: 'muted small' }, 'Officina has its own API. Any AI app that speaks MCP (Claude Code, Cursor, Codex, local models through a bridge) connects to this address with the token below. It only accepts connections from this computer. Each app shows up under Agents with its own colour.'),
      s.error ? h('p', { class: 'error-text' }, s.error) : null,
      h('div', { class: 'kv' }, h('span', {}, 'URL'), h('code', {}, s.url), copyBtn(s.url)),
      h('div', { class: 'kv' }, h('span', {}, 'Token'), h('code', {}, token), h('div', { class: 'row gap' },
        h('button', { class: 'btn small', onclick: () => { state.reveal = !state.reveal; render(); } }, state.reveal ? 'Hide' : 'Show'), copyBtn(s.token))),
      h('div', { class: 'row gap' },
        h('label', { class: 'field inline' }, h('span', { class: 'field-label' }, 'Port'), port),
        h('button', { class: 'btn small', onclick: async () => { try { ctx.state.mcp = await window.ac.mcpConfigure({ port: Number(port.value) }); render(); } catch (e) { toast(e.message, 'error'); } } }, 'Apply'),
        h('button', { class: 'btn small', onclick: async () => { ctx.state.mcp = await window.ac.mcpConfigure({ enabled: !s.enabled }); render(); } }, s.enabled ? 'Turn off' : 'Turn on'),
        h('button', { class: 'btn small danger-ghost', onclick: async () => { if (await confirmDialog('New token', 'Connected agents will need the new token. Continue?', 'Make a new token')) { ctx.state.mcp = await window.ac.mcpRegenerate(); render(); } } }, 'New token')),
      s.lastCall ? h('p', { class: 'muted small' }, `Last agent call ${timeAgo(s.lastCall)}`) : null),
    h('div', { class: 'card' }, h('h3', {}, 'API reference'), apiReference()),
    h('div', { class: 'card' }, h('h3', {}, 'Connect Claude Code'), h('p', { class: 'muted small' }, 'Run this once in a terminal:'), h('pre', { class: 'code' }, claudeCmd), copyBtn(claudeCmd, 'Copy command')),
    h('div', { class: 'card' }, h('h3', {}, 'Other MCP clients (HTTP)'), h('pre', { class: 'code' }, json), copyBtn(json, 'Copy JSON')),
    h('div', { class: 'card' }, h('h3', {}, 'Clients that only support stdio'), h('p', { class: 'muted small' }, 'Bridge through mcp-remote (needs Node.js):'), h('pre', { class: 'code' }, stdio), copyBtn(stdio, 'Copy JSON')),
  ];
}

export function agentPanel(body, ctx) {
  const state = { reveal: false };
  const render = () => {
    clear(body);
    if (!isSimple()) { body.append(...technicalAgent(ctx, render, state)); return; }
    const s = ctx.state.mcp;
    const claudeCmd = `claude mcp add --transport http officina ${s.url} --header "Authorization: Bearer ${s.token}"`;
    const connected = s.lastCall && Date.now() - Date.parse(s.lastCall) < 10 * 60e3;
    body.append(
      h('div', { class: `card ${s.running ? 'ok-card' : 'bad-card'}` },
        h('div', { class: 'row between' }, h('h3', {}, 'Your AI assistant'),
          h('span', { class: `status-pill ${s.running ? 'on' : ''}` }, !s.running ? 'Not ready' : connected ? 'Working' : 'Ready')),
        h('p', {}, !s.running
          ? 'The connection is switched off or blocked. Open the technical details below to fix it.'
          : connected ? `Your assistant was active ${timeAgo(s.lastCall)}.` : s.lastCall ? `Last active ${timeAgo(s.lastCall)}.` : 'Ready. No assistant has connected yet.')),
      h('div', { class: 'card steps' },
        h('h3', {}, 'Connect in two steps'),
        h('ol', {},
          h('li', {}, 'Copy the setup line below.', h('div', { class: 'row gap step-btns' }, h('button', { class: 'btn primary', onclick: () => { window.ac.copy(claudeCmd); toast('Setup line copied', 'ok'); } }, 'Copy setup line'))),
          h('li', {}, 'Paste it into Claude Code and press Enter. After that, just ask it to work in Officina, for example: “open x.com and write down three trade ideas as notes”.'))),
      more('Technical details', ...technicalAgent(ctx, render, state)),
    );
  };
  render();
  return { refresh: render };
}

export const PANELS = {
 strategies:{word:'Paper strategies',render:strategiesPanel},
 tasks: {word:'Tasks', render:tasksPanel}, memory:{word:'Memory',render:memoryPanel}, notifications:{word:'Notifications',render:notificationsPanel}, handoff:{word:'AI needs you',render:handoffPanel}, rules:{word:'Browser rules',render:rulesPanel}, spaces:{word:'Spaces',render:spacesPanel}, positions:{word:'Positions & protection',render:positionsPanel}, replay:{word:'Replay',render:replayPanel}, backup:{word:'Backup',render:backupPanel}, signals:{word:'Signals & phone',render:signalsPanel}, comforts:{word:'Browser tools',render:comfortsPanel}, widgets:{word:'Widgets',render:widgetsPanel}, voice:{word:'Voice',render:voicePanel},
  library: { word: 'library', render: libraryPanel },
  keys: { word: 'keys', render: keysPanel },
  trading: { word: 'trading', render: tradingPanel },
  activity: { word: 'activity', render: activityPanel },
  agent: { word: 'agent', render: agentPanel },
  agents: { word: 'agents', render: agentsPanel },
  connectors: { word: 'connectors', render: connectorsPanel },
  settings: { word: 'settings', render: settingsPanel },
  chat: { word: 'chat', render: teamPanel },
  features: { word: 'features', render: featuresPanel },
  status: { word: 'status', render: statusPanel },
};
