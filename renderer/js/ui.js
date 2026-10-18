// Tiny DOM helpers shared by the renderer modules.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) { if (p.startsWith('--')) el.style.setProperty(p, val); else el.style[p] = val; }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (['value', 'checked', 'selected', 'disabled', 'textContent', 'innerHTML', 'hidden'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

// toast(msg, kind, ms, { label, onClick }) The optional action renders a button, for example Undo.
export function toast(message, kind = 'info', ms = 3200, action = null) {
  const t = h('div', { class: `toast ${kind}` }, h('span', { class: 'toast-msg' }, message));
  if (action) {
    ms = Math.max(ms, 6000);
    t.append(h('button', { class: 'toast-action', onclick: () => { action.onClick(); dismiss(); } }, action.label));
  }
  const dismiss = () => { t.classList.add('out'); setTimeout(() => t.remove(), 350); };
  document.getElementById('toasts').append(t);
  setTimeout(dismiss, ms);
  return dismiss;
}

// Actions: { label, kind, value, onClick, id, disabled }.
// A button with onClick closes the dialog unless onClick returns false;
// the dialog resolves with `value` (or onClick's result, or true).
export function modal({ title, body, actions = [], dismissable = true, wide = false, onReady }) {
  const root = document.getElementById('modal-root');
  return new Promise(resolve => {
    let done = false;
    const close = value => { if (done) return; done = true; wrap.remove(); resolve(value); };
    const buttons = actions.map(a => h('button', {
      class: `btn ${a.kind || ''}`, disabled: a.disabled, 'data-action': a.id || '', type: 'button',
      onclick: async () => {
        let result;
        if (a.onClick) {
          result = await a.onClick();
          if (result === false) return;
        }
        close(a.value !== undefined ? a.value : (result === undefined ? true : result));
      },
    }, a.label));
    const box = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', {}, title),
      h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-actions' }, buttons));
    const wrap = h('div', { class: 'modal-wrap', onmousedown: e => { if (dismissable && e.target === wrap) close(null); } }, box);
    wrap.addEventListener('keydown', e => {
      if (e.key === 'Escape' && dismissable) { e.stopPropagation(); close(null); }
      // Enter in a single-line field submits with the primary button.
      if (e.key === 'Enter' && e.target.matches('input:not([type=checkbox]):not([type=radio])')) {
        const primary = buttons.find(b => b.classList.contains('primary') || b.classList.contains('danger'));
        if (primary && !primary.disabled) { e.preventDefault(); primary.click(); }
      }
    });
    root.append(wrap);
    onReady?.({ buttons, close, box });
    (box.querySelector('input:not([type=checkbox]), select, textarea') || buttons.find(b => b.classList.contains('primary')) || buttons[0])?.focus();
  });
}

export function confirmDialog(title, message, okLabel = 'OK', kind = 'primary') {
  return modal({ title, body: typeof message === 'string' ? h('p', {}, message) : message, actions: [{ label: 'Cancel', value: false }, { label: okLabel, kind, value: true }] });
}

export async function promptDialog(title, label, value = '') {
  const input = h('input', { class: 'input', value });
  const ok = await modal({ title, body: h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input), actions: [{ label: 'Cancel', value: false }, { label: 'Save', kind: 'primary', value: true }] });
  return ok ? input.value.trim() : null;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function clock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function bytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function wsUrl(rel) {
  return 'ac://ws/' + rel.split('/').map(encodeURIComponent).join('/');
}

// Meta line made of separate parts, laid out with spacing instead of glyph separators.
export function metaLine(cls, parts) {
  return h('span', { class: cls }, parts.filter(p => p != null && p !== '' && p !== false).map(p => h('span', { class: 'meta-part' }, p)));
}
