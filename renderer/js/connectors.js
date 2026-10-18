// Connectors panel: talk to your agents from Telegram or Discord. Each service gets one
// card: setup steps until a bot token is saved, then status, which agent answers, the
// linked chats and a pairing code to link another chat.
import { h, clear, toast, confirmDialog } from './ui.js';

const cleanError = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const GUIDE = {
  telegram: {
    color: '#2aabee',
    steps: () => [
      ['In Telegram, open ', h('strong', {}, '@BotFather'), ' and send ', h('code', {}, '/newbot'), '.'],
      ['Give it a name and a username ending in "bot". BotFather replies with a token like ', h('code', {}, '123456:ABC-…'), '.'],
      ['Paste that token below. It is stored encrypted on this computer.'],
    ],
    pairHow: (code, bot) => ['Open ', h('strong', {}, bot || 'your bot'), ' in Telegram and send ', h('code', { class: 'pair-cmd' }, `/pair ${code}`)],
  },
  discord: {
    color: '#5865f2',
    steps: () => [
      ['Go to ', h('strong', {}, 'discord.com/developers/applications'), ' and click New Application.'],
      ['Open the Bot page: click Reset Token and copy it. Turn on ', h('strong', {}, 'Message Content Intent'), ' on the same page.'],
      ['Paste the token below, then invite the bot with the link that appears (or just send it a direct message).'],
    ],
    pairHow: (code, bot) => ['Send ', h('strong', {}, bot || 'the bot'), ' a direct message: ', h('code', { class: 'pair-cmd' }, `pair ${code}`)],
  },
};

const STATE = { off: 'Off', connecting: 'Connecting…', online: 'Online', error: 'Problem' };

export function connectorsPanel(body) {
  let list = [], team = [];
  const run = async fn => { try { return await fn(); } catch (e) { toast(cleanError(e), 'error', 7000); return null; } };

  const agentSelect = (value, onChange, allowDefault) => h('select', { class: 'input small', onchange: e => onChange(e.target.value) },
    allowDefault ? h('option', { value: '', selected: !value }, 'Default for this bot') : null,
    team.map(a => h('option', { value: a.id, selected: value ? value === a.id : !allowDefault && a.id === team[0]?.id }, a.name)));

  const card = s => {
    const g = GUIDE[s.id];
    const pill = h('span', { class: `status-pill conn-${s.state}` }, s.state === 'online' && s.botName ? `Online as ${s.botName}` : STATE[s.state] || s.state);
    const head = h('div', { class: 'conn-head' },
      h('span', { class: 'conn-logo', style: { background: g.color } }, s.name[0]),
      h('div', { class: 'conn-title' }, h('strong', {}, s.name), h('span', { class: 'muted small' }, s.links.length ? `${s.links.length} linked chat${s.links.length === 1 ? '' : 's'}` : 'No chats linked yet')),
      pill);
    const el = h('section', { class: `card conn-card s-${s.state}` }, head);

    if (!s.hasToken) {
      const token = h('input', { class: 'input', type: 'password', placeholder: 'Bot token', autocomplete: 'off', spellcheck: 'false', 'aria-label': `${s.name} bot token` });
      const connect = async () => {
        if (!token.value.trim()) return token.focus();
        const r = await run(() => window.ac.connectorsConfigure(s.id, { token: token.value.trim(), enabled: true }));
        if (r) { token.value = ''; await run(() => window.ac.connectorsPair(s.id)); toast(`${s.name} bot saved. Link your chat with the code.`, 'ok'); }
      };
      token.addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
      el.append(
        h('ol', { class: 'conn-steps' }, g.steps().map(step => h('li', {}, ...step))),
        h('div', { class: 'row gap' }, token, h('button', { class: 'btn primary', onclick: connect }, 'Connect')));
      return el;
    }

    if (s.error) el.append(h('p', { class: 'conn-error' }, s.error));

    // pairing: the code proves the chat belongs to whoever sits at this screen
    const pair = h('div', { class: 'conn-pair' });
    if (s.pairCode) {
      const mins = Math.max(1, Math.round((s.pairExpires - Date.now()) / 60000));
      pair.append(
        h('div', { class: 'pair-code', title: 'Pairing code' }, s.pairCode),
        h('p', { class: 'small' }, ...g.pairHow(s.pairCode, s.botName)),
        h('p', { class: 'hint' }, `The code works once and expires in about ${mins} minute${mins === 1 ? '' : 's'}.`));
    } else {
      pair.append(h('button', { class: 'btn small', disabled: s.state !== 'online', title: s.state !== 'online' ? 'The bot has to be online first' : '', onclick: () => run(() => window.ac.connectorsPair(s.id)) }, s.links.length ? 'Link another chat' : 'Link a chat'));
    }
    if (s.id === 'discord' && s.appId) {
      const invite = `https://discord.com/oauth2/authorize?client_id=${s.appId}&scope=bot&permissions=3072`;
      pair.append(h('div', { class: 'row gap' }, h('button', { class: 'btn small ghost', onclick: () => { window.ac.copy(invite); toast('Invite link copied: open it in your browser to add the bot to a server', 'ok', 6000); } }, 'Copy invite link for a server')));
    }

    const links = s.links.length ? h('div', { class: 'conn-links' }, s.links.map(l => h('div', { class: 'conn-link' },
      h('div', { class: 'conn-link-name' }, h('strong', {}, l.name), h('span', { class: 'muted small' }, `linked ${new Date(l.linkedAt).toLocaleDateString()}`)),
      agentSelect(l.agentId, v => run(() => window.ac.connectorsLinkAgent(s.id, l.chatId, v)), true),
      h('button', { class: 'btn small danger-ghost', onclick: async () => { if (await confirmDialog('Unlink this chat?', `${l.name} can no longer talk to your agents.`, 'Unlink', 'danger')) run(() => window.ac.connectorsUnlink(s.id, l.chatId)); } }, 'Unlink')))) : null;

    el.append(
      h('label', { class: 'toggle-row' }, h('span', { class: 'toggle-text' }, h('span', {}, 'Bot is on'), h('span', { class: 'hint' }, 'Off: the bot stops reading messages; links stay.')),
        h('input', { type: 'checkbox', class: 'switch', checked: s.enabled, onchange: e => run(() => window.ac.connectorsConfigure(s.id, { enabled: e.target.checked })) })),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Messages go to'), agentSelect(s.agentId, v => run(() => window.ac.connectorsConfigure(s.id, { agentId: v })), false)),
      h('label', { class: 'toggle-row' }, h('span', { class: 'toggle-text' }, h('span', {}, 'Send notifications here'), h('span', { class: 'hint' }, 'When an agent needs you, a task finishes or a trade happens.')),
        h('input', { type: 'checkbox', class: 'switch', checked: s.notify, onchange: e => run(() => window.ac.connectorsConfigure(s.id, { notify: e.target.checked })) })),
      links || h('p', { class: 'muted small' }, 'No chat is linked yet.'),
      pair,
      h('div', { class: 'row between conn-foot' },
        h('button', { class: 'btn small ghost', disabled: !s.links.length, onclick: async () => { const r = await run(() => window.ac.connectorsTest()); if (r) toast(r.sent ? `Test sent to ${r.sent} chat${r.sent === 1 ? '' : 's'}` : 'Nothing sent: no bot with notifications on has a linked chat', r.sent ? 'ok' : 'warn'); } }, 'Send a test message'),
        h('button', { class: 'btn small danger-ghost', onclick: async () => { if (await confirmDialog(`Remove the ${s.name} bot?`, 'The token and every linked chat are removed from Officina. The bot itself keeps existing in your account.', 'Remove', 'danger')) run(() => window.ac.connectorsConfigure(s.id, { removeToken: true })); } }, 'Remove bot')));
    return el;
  };

  const render = () => {
    const top = body.scrollTop;
    clear(body).append(
      h('div', { class: 'callout' }, h('strong', {}, 'Talk to your agents from your phone.'),
        ' Message your own bot: the text goes to an agent, its answer comes back in the chat. Alerts (an agent needs you, a task is done) arrive there too. Only chats you link with a code from this screen can use it.'),
      ...list.map(card),
      h('details', { class: 'more' }, h('summary', {}, 'Commands in a linked chat'),
        h('table', { class: 'tbl keys-tbl' }, [
          ['/status', 'What the agents are doing, and anything waiting for you'],
          ['/use <name>', 'Choose which agent answers in this chat'],
          ['/roundoff', 'Working agents finish and report'],
          ['/stop, /resume', 'Pause every agent and auto-trading, or let them go on'],
          ['/new', 'Fresh conversation with your agent'],
          ['/done, /cancel', 'Answer an agent that waits for you'],
        ].map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d))))),
      h('p', { class: 'hint' }, 'WhatsApp follows later.'));
    body.scrollTop = top;
  };

  const load = async () => { [list, team] = await Promise.all([window.ac.connectorsStatus(), window.ac.teamList()]); render(); };
  load();
  const off = window.ac.on('connectors:status', s => { list = s; if (!body.contains(document.activeElement) || document.activeElement.tagName !== 'INPUT') render(); });
  const tick = setInterval(() => { if (list.some(s => s.pairCode)) render(); }, 30000);
  return { refresh: load, dispose() { off(); clearInterval(tick); } };
}
