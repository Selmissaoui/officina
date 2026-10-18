// Gamified theme: a tower-climbing status window. Progress is derived from
// real work in the workspace (notes, files, pages read, trades, agent actions),
// so nothing here is stored separately and nothing can be "farmed" by clicking.
import { h, clear, toast, debounce } from './ui.js';
import { isGame } from './prefs.js';

const TITLES = [[1, 'Initiate'], [3, 'Climber'], [6, 'Pathfinder'], [10, 'Vanguard'], [15, 'Ascendant'], [25, 'Summit Walker']];
const xpForFloor = f => 60 * (f - 1) * (f - 1);

export function computeStatus(s) {
  const xp = s.notes * 15 + s.files * 6 + s.screenshots * 4 + s.trades * 25 + s.pagesRead.total * 3 + s.agentActions.total * 1 + s.browsers * 10;
  const floor = 1 + Math.floor(Math.sqrt(xp / 60));
  const cur = xpForFloor(floor), next = xpForFloor(floor + 1);
  const title = [...TITLES].reverse().find(([f]) => floor >= f)[1];
  const attrs = [
    { key: 'INSIGHT', hint: 'Notes written', value: s.notes },
    { key: 'REACH', hint: 'Pages read by your companion', value: s.pagesRead.total },
    { key: 'FORTUNE', hint: 'Trades placed', value: s.trades },
    { key: 'CRAFT', hint: 'Files and screenshots saved', value: s.files + s.screenshots },
    { key: 'COMMAND', hint: 'Actions your companion performed', value: s.agentActions.total },
  ];
  const quests = [
    { id: 'scout', name: 'Scout the market', detail: 'Read pages', have: s.pagesRead.today, need: 5 },
    { id: 'record', name: 'Record your findings', detail: 'Write notes', have: s.notesToday, need: 2 },
    { id: 'move', name: 'Make your move', detail: 'Place a trade', have: s.tradesToday, need: 1 },
    { id: 'command', name: 'Lead your companion', detail: 'Companion actions', have: s.agentActions.today, need: 15 },
  ].map(q => ({ ...q, done: q.have >= q.need }));
  return { xp, floor, cur, next, progress: (xp - cur) / (next - cur), title, attrs, quests };
}

function bar(fraction, cls = '') {
  return h('div', { class: `sys-bar ${cls}` }, h('div', { class: 'sys-bar-fill', style: { width: `${Math.max(0, Math.min(1, fraction)) * 100}%` } }));
}

export function statusPanel(body, ctx) {
  const render = async () => {
    const st = computeStatus(await window.ac.stats());
    clear(body).append(
      h('div', { class: 'sys-window' },
        h('div', { class: 'sys-title' }, 'STATUS'),
        h('div', { class: 'sys-grid' },
          h('div', { class: 'sys-kv' }, h('span', {}, 'NAME'), h('strong', {}, ctx.playerName())),
          h('div', { class: 'sys-kv' }, h('span', {}, 'FLOOR'), h('strong', { class: 'sys-big' }, st.floor)),
          h('div', { class: 'sys-kv' }, h('span', {}, 'TITLE'), h('strong', {}, st.title)),
          h('div', { class: 'sys-kv' }, h('span', {}, 'EXP'), h('strong', {}, `${st.xp - st.cur} / ${st.next - st.cur}`))),
        bar(st.progress, 'xp'),
        h('p', { class: 'sys-note' }, `${st.next - st.xp} EXP to floor ${st.floor + 1}`)),
      h('div', { class: 'sys-window' },
        h('div', { class: 'sys-title' }, 'ATTRIBUTES'),
        h('div', { class: 'sys-attrs' }, st.attrs.map(a => h('div', { class: 'sys-attr', title: a.hint }, h('span', {}, a.key), h('strong', {}, a.value))))),
      h('div', { class: 'sys-window' },
        h('div', { class: 'sys-title' }, 'DAILY QUESTS'),
        st.quests.map(q => h('div', { class: `sys-quest ${q.done ? 'done' : ''}` },
          h('div', { class: 'row between' }, h('span', {}, q.name), h('span', { class: 'sys-count' }, q.done ? 'CLEAR' : `${Math.min(q.have, q.need)} / ${q.need}`)),
          h('div', { class: 'sys-quest-detail' }, q.detail),
          bar(q.have / q.need))),
        h('p', { class: 'sys-note' }, 'Quests reset at midnight.')),
    );
  };
  render();
  return { refresh: debounce(render, 400) };
}

// Watches progress and announces floor-ups and cleared quests (gamified theme only).
export function createProgressWatcher() {
  let last = null;
  const day = () => new Date().toDateString();
  const seenKey = () => `ac.quests.${day()}`;
  const readSeen = () => { try { return new Set(JSON.parse(localStorage.getItem(seenKey()) || '[]')); } catch { return new Set(); } };
  const writeSeen = s => { try { localStorage.setItem(seenKey(), JSON.stringify([...s])); } catch { /* storage unavailable */ } };

  const check = debounce(async () => {
    const st = computeStatus(await window.ac.stats());
    if (last && isGame()) {
      if (st.floor > last.floor) toast(`Floor ${st.floor} reached. Title: ${st.title}.`, 'system', 5000);
      const seen = readSeen();
      for (const q of st.quests) {
        if (q.done && !seen.has(q.id)) { toast(`Quest cleared: ${q.name}`, 'system', 4500); seen.add(q.id); }
      }
      writeSeen(seen);
    } else {
      // First run: mark already-cleared quests as seen, so we don't announce old progress.
      const seen = readSeen();
      st.quests.filter(q => q.done).forEach(q => seen.add(q.id));
      writeSeen(seen);
    }
    last = st;
  }, 1500);
  check();
  return { check };
}
