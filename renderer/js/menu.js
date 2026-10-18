// Custom right-click menu. Entries: { label, action, shortcut, disabled, danger,
// checked, submenu: [...] } or '-' for a separator. Keyboard: arrows, Enter, Esc.
import { h } from './ui.js';

let current = null;

export function closeMenu() {
  if (!current) return;
  current.remove();
  current = null;
  document.removeEventListener('pointerdown', onOutside, true);
  window.removeEventListener('blur', closeMenu);
  window.removeEventListener('resize', closeMenu);
  document.removeEventListener('keydown', onKey, true);
}

function onOutside(e) {
  if (current && !current.contains(e.target) && !e.target.closest?.('.ctx-menu')) closeMenu();
}

function build(items, level = 0) {
  const menu = h('div', { class: 'ctx-menu', role: 'menu', dataset: { level } });
  for (const it of items.filter(Boolean)) {
    if (it === '-') { menu.append(h('div', { class: 'ctx-sep', role: 'separator' })); continue; }
    if (it.heading) { menu.append(h('div', { class: 'ctx-heading' }, it.heading)); continue; }
    const row = h('button', {
      class: `ctx-item${it.danger ? ' danger' : ''}${it.submenu ? ' has-sub' : ''}`, role: 'menuitem', type: 'button', disabled: it.disabled,
    },
    h('span', { class: 'ctx-check' }, it.checked ? '✓' : ''),
    h('span', { class: 'ctx-label' }, it.label),
    it.shortcut ? h('span', { class: 'ctx-key' }, it.shortcut) : null,
    it.submenu ? h('span', { class: 'ctx-arrow' }, '›') : null);
    if (it.submenu) {
      let sub = null;
      const openSub = () => {
        menu.querySelectorAll(':scope > .ctx-menu').forEach(m => m.remove());
        sub = build(it.submenu, level + 1);
        menu.append(sub);
        const r = row.getBoundingClientRect();
        const mw = sub.offsetWidth, mh = sub.offsetHeight;
        let x = r.right - 4, y = r.top - 5;
        if (x + mw > innerWidth - 8) x = r.left - mw + 4;
        if (y + mh > innerHeight - 8) y = innerHeight - mh - 8;
        Object.assign(sub.style, { left: `${x}px`, top: `${y}px` });
      };
      row.addEventListener('mouseenter', openSub);
      row.addEventListener('click', openSub);
      row._openSub = openSub;
    } else {
      row.addEventListener('mouseenter', () => menu.querySelectorAll(':scope > .ctx-menu').forEach(m => m.remove()));
      row.addEventListener('click', () => { closeMenu(); it.action?.(); });
    }
    menu.append(row);
  }
  return menu;
}

function onKey(e) {
  if (!current) return;
  const menus = [...document.querySelectorAll('.ctx-menu')];
  const active = menus[menus.length - 1];
  const rows = [...active.querySelectorAll(':scope > .ctx-item:not(:disabled)')];
  const idx = rows.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (menus.length > 1) { active.remove(); } else closeMenu(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); rows[(idx + 1) % rows.length]?.focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); rows[(idx - 1 + rows.length) % rows.length]?.focus(); }
  else if (e.key === 'ArrowRight' && document.activeElement?._openSub) { e.preventDefault(); document.activeElement._openSub(); document.querySelector('.ctx-menu .ctx-menu .ctx-item')?.focus(); }
  else if (e.key === 'ArrowLeft' && menus.length > 1) { e.preventDefault(); active.remove(); }
}

export function openMenu(x, y, items) {
  closeMenu();
  current = build(items);
  document.body.append(current);
  const mw = current.offsetWidth, mh = current.offsetHeight;
  Object.assign(current.style, { left: `${Math.min(x, innerWidth - mw - 8)}px`, top: `${Math.min(y, innerHeight - mh - 8)}px` });
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
    document.addEventListener('keydown', onKey, true);
  });
}
