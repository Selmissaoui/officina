// Everything you can do to a window or the canvas, shared by the right-click
// menus, keyboard shortcuts and the browser's own context menu.
import { openMenu } from './menu.js';
import { toast, promptDialog, confirmDialog } from './ui.js';
import { t, isSimple } from './prefs.js';

const SIZES = {
  browser: { small: [640, 460], medium: [900, 640], large: [1280, 860] },
  note: { small: [260, 220], medium: [340, 300], large: [520, 460] },
  file: { small: [380, 320], medium: [520, 440], large: [820, 640] },
  folder: { small: [280, 320], medium: [340, 420], large: [460, 600] },
};
const COLORS = [['yellow', 'Yellow'], ['blue', 'Blue'], ['green', 'Green'], ['pink', 'Pink'], ['purple', 'Purple'], ['gray', 'Gray']];

export function createActions(ctx) {
  const ac = window.ac;
  const view = id => ctx.canvas.views.get(id);
  const item = id => view(id)?.item;
  const rightOf = it => ({ x: it.x + it.w + 32, y: it.y });
  const label = it => it.title || it.path?.split('/').pop() || it.type;
  let pasteAt = null;

  const A = {
    async duplicate(id) {
      const it = item(id);
      if (!it) return;
      let copy;
      if (it.type === 'browser') copy = await ac.addItem({ type: 'browser', url: view(id).currentUrl?.() || it.url, title: it.title, profile: it.profile, w: it.w, h: it.h, hint: rightOf(it) });
      else if (it.type === 'note') copy = await ac.addItem({ type: 'note', title: `${it.title || 'Note'} (copy)`, content: await ac.noteRead(id), color: it.color, w: it.w, h: it.h, hint: rightOf(it) });
      else if (it.type === 'file') copy = await ac.addItem({ type: 'file', path: await ac.duplicateFile(it.path), w: it.w, h: it.h, hint: rightOf(it) });
      else copy = await ac.addItem({ type: 'folder', path: it.path, w: it.w, h: it.h, hint: rightOf(it) });
      ctx.select(copy.id);
      if (it.type === 'browser') toast('Duplicated. Both windows share the same login.', 'ok');
    },

    resize(id, preset) {
      const it = item(id);
      if (!it) return;
      if (preset === 'fill') {
        const r = ctx.canvas.viewport.getBoundingClientRect();
        const s = ctx.canvas.v.scale;
        const tl = ctx.canvas.toWorld(r.left, r.top);
        ac.updateItem(id, { x: Math.round(tl.x + 24 / s), y: Math.round(tl.y + 24 / s), w: Math.round((r.width - 48) / s), h: Math.round((r.height - 48) / s), raise: true });
        return;
      }
      const [w, h] = SIZES[it.type][preset];
      ac.updateItem(id, { w, h, raise: true });
    },

    close(id) {
      const it = item(id);
      if (!it) return;
      const snapshot = { ...it };
      ac.removeItem(id);
      if (ctx.selected === id) ctx.select(null);
      toast(`Closed “${label(it)}”`, 'info', 6000, { label: 'Undo', onClick: () => ac.addItem(snapshot) });
    },

    front(id) { ac.updateItem(id, { raise: true }); },
    back(id) {
      const minZ = Math.min(...[...ctx.canvas.views.values()].map(v => v.item.z || 0));
      ac.updateItem(id, { z: minZ - 1 });
    },
    lock(id) {
      const it = item(id);
      if (it) ac.updateItem(id, { locked: !it.locked });
    },
    async rename(id) {
      const it = item(id);
      if (!it) return;
      const name = await promptDialog('Rename', 'Name', label(it));
      if (name) ac.updateItem(id, { title: name, renamed: true });
    },
    zoom(id) { ctx.canvas.focus(id); },

    async logout(id) {
      const it = item(id);
      if (!it) return;
      const ok = await confirmDialog('Log out of this browser?', `This clears the saved logins, cookies and site data of “${label(it)}”${ctx.sharedProfileCount(it.profile) > 1 ? ' and the other windows that share its login' : ''}. You will need to sign in again.`, 'Log out', 'danger');
      if (!ok) return;
      await ac.clearBrowserData(it.profile);
      for (const v of ctx.canvas.views.values()) if (v.item.profile === it.profile) v.reload?.();
      toast('Logged out', 'ok');
    },

    async copyText(id) {
      await ac.copy(await ac.noteRead(id));
      toast('Note copied', 'ok');
    },

    async arrange() {
      const views = [...ctx.canvas.views.values()].map(v => v.item).sort((a, b) => (a.y - b.y) || (a.x - b.x));
      if (!views.length) return;
      const r = ctx.canvas.viewport.getBoundingClientRect();
      const maxRow = Math.max(1800, r.width / ctx.canvas.v.scale);
      const gap = 32;
      const x0 = Math.min(...views.map(i => i.x)), y0 = Math.min(...views.map(i => i.y));
      let x = x0, y = y0, rowH = 0;
      for (const it of views) {
        if (x > x0 && x + it.w > x0 + maxRow) { x = x0; y += rowH + gap; rowH = 0; }
        await ac.updateItem(it.id, { x, y });
        x += it.w + gap;
        rowH = Math.max(rowH, it.h);
      }
      setTimeout(() => ctx.canvas.fitAll(), 80);
    },

    // Menu "Paste here": remember the spot, then fire a real paste event.
    paste(at) {
      pasteAt = at || null;
      ac.triggerPaste();
    },

    async pasteData(data) {
      const at = pasteAt || ctx.canvas.center();
      pasteAt = null;
      const hint = { x: Math.round(at.x), y: Math.round(at.y) };
      const image = [...(data?.files || [])].find(f => f.type.startsWith('image/'));
      if (image) {
        const rel = await ac.savePasted(image.name, new Uint8Array(await image.arrayBuffer()));
        const it = await ac.addItem({ type: 'file', path: rel, hint });
        ctx.select(it.id);
        return toast('Image pasted and saved to the workspace', 'ok');
      }
      const text = (data?.getData('text/plain') || '').trim();
      if (!text) return toast('The clipboard is empty', 'warn');
      if (/^https?:\/\/\S+$/i.test(text)) {
        let host = 'Browser';
        try { host = new URL(text).hostname.replace(/^www\./, ''); } catch { /* keep default */ }
        const it = await ac.addItem({ type: 'browser', url: text, title: host, hint });
        return ctx.select(it.id);
      }
      const title = text.split('\n')[0].replace(/^#+\s*/, '').slice(0, 40) || 'Pasted note';
      const it = await ac.addItem({ type: 'note', title, content: text, hint });
      ctx.select(it.id);
    },

    async newNoteAt(pt) {
      const it = await ac.addItem({ type: 'note', title: 'Note', x: Math.round(pt.x - 20), y: Math.round(pt.y - 18) });
      ctx.select(it.id);
    },
  };

  const sizeMenu = id => [
    { label: 'Small', action: () => A.resize(id, 'small') },
    { label: 'Medium', action: () => A.resize(id, 'medium') },
    { label: 'Large', action: () => A.resize(id, 'large') },
    '-',
    { label: 'Fill the screen', action: () => A.resize(id, 'fill') },
  ];

  const arrangeItems = (id, it) => [
    { label: 'Size', submenu: sizeMenu(id) },
    { label: 'Zoom to this window', shortcut: 'Enter', action: () => A.zoom(id) },
    { label: 'Bring to front', action: () => A.front(id) },
    { label: 'Send to back', action: () => A.back(id) },
    { label: 'Lock position', checked: !!it.locked, action: () => A.lock(id) },
  ];

  function itemMenu(id) {
    const it = item(id);
    const v = view(id);
    if (!it) return [];
    const close = { label: 'Close', shortcut: 'Del', action: () => A.close(id) };
    if (it.type === 'browser') {
      return [
        { label: 'Back', disabled: !v.canGoBack?.(), action: () => v.goBack() },
        { label: 'Forward', disabled: !v.canGoForward?.(), action: () => v.goForward() },
        { label: 'Reload', action: () => v.reload() },
        { label: 'Copy page address', action: () => { ac.copy(v.currentUrl()); toast('Address copied', 'ok'); } },
        '-',
        { label: 'Duplicate', shortcut: 'Ctrl+D', action: () => A.duplicate(id) },
        { label: 'Rename', shortcut: 'F2', action: () => A.rename(id) },
        ...arrangeItems(id, it),
        '-',
        ...(() => {
          // Brave windows block with Brave Shields; the built-in browser has its own blocker with a per-site switch.
          if (it.engine === 'brave') return [{ label: 'Open this page in the built-in browser', action: () => ac.openBrowserIn(id, 'builtin') }];
          let host = '';
          try { host = new URL(v.currentUrl()).hostname.replace(/^www\./, ''); } catch { /* no page */ }
          const items = [{ label: 'Open this page in Brave', action: () => ac.openBrowserIn(id, 'brave') }];
          if (!host) return items;
          const allowed = ctx.adblockAllowed(host);
          return [{ label: allowed ? `Block ads on ${host} again` : `Don't block ads on ${host}`, action: async () => { await ctx.allowAdsOn(host, !allowed); v.reload(); toast(allowed ? `Ads are blocked on ${host} again` : `Nothing is blocked on ${host} any more`, 'ok'); } }, ...items];
        })(),
        { label: isSimple() ? 'Link a key…' : 'Link an API key…', action: () => ctx.openPanel('keys', { profile: it.profile, create: true }) },
        { label: 'Log out of this browser…', danger: true, action: () => A.logout(id) },
        '-',
        close,
      ];
    }
    if (it.type === 'note') {
      return [
        { label: 'Edit', action: () => v.edit?.() },
        { label: 'Colour', submenu: COLORS.map(([c, name]) => ({ label: name, checked: (it.color || 'yellow') === c, action: () => ac.updateItem(id, { color: c }) })) },
        { label: 'Copy text', action: () => A.copyText(id) },
        { label: 'Duplicate', shortcut: 'Ctrl+D', action: () => A.duplicate(id) },
        { label: 'Rename', shortcut: 'F2', action: () => A.rename(id) },
        '-',
        ...arrangeItems(id, it),
        '-',
        close,
      ];
    }
    if (it.type === 'file') {
      return [
        { label: 'Export a copy…', action: () => ac.exportFile(it.path) },
        { label: 'Duplicate file', shortcut: 'Ctrl+D', action: () => A.duplicate(id) },
        { label: 'Rename window', shortcut: 'F2', action: () => A.rename(id) },
        { label: `Find in ${t('library')}`, action: () => ctx.openPanel('library', { force: true, query: it.path.split('/').pop() }) },
        '-',
        ...arrangeItems(id, it),
        '-',
        close,
      ];
    }
    return [
      { label: 'Refresh', action: () => v.refresh?.() },
      { label: 'Duplicate view', shortcut: 'Ctrl+D', action: () => A.duplicate(id) },
      '-',
      ...arrangeItems(id, it),
      '-',
      close,
    ];
  }

  function backgroundMenu(pt) {
    const hint = { x: Math.round(pt.x), y: Math.round(pt.y) };
    return [
      { label: 'New browser here', shortcut: 'Ctrl+B', action: () => ctx.newBrowser(hint) },
      { label: 'New note here', shortcut: 'Dbl-click', action: () => A.newNoteAt(pt) },
      { label: 'Paste here', shortcut: 'Ctrl+V', action: () => A.paste(pt) },
      { label: 'Add files…', action: () => ctx.importDialog('files', hint) },
      { label: 'Add a folder…', action: () => ctx.importDialog('folder', hint) },
      '-',
      { label: 'Tidy up windows', shortcut: 'Ctrl+Shift+A', action: () => A.arrange() },
      { label: 'Organise by kind (browsers, notes, files)', shortcut: 'Ctrl+Shift+O', action: () => ctx.organize?.() },
      { label: 'Show everything', shortcut: 'Ctrl+0', action: () => ctx.canvas.fitAll() },
      { label: 'Zoom to 100%', shortcut: 'Ctrl+1', action: () => ctx.zoomReset() },
      '-',
      { label: t('library'), shortcut: 'Ctrl+K', action: () => ctx.openPanel('library', { force: true }) },
      { label: t('settings'), shortcut: 'Ctrl+,', action: () => ctx.openPanel('settings', { force: true }) },
    ];
  }

  function showItemMenu(id, x, y) {
    ctx.select(id);
    openMenu(x, y, itemMenu(id));
  }

  // Keyboard shortcuts that act on the selected window. Returns true if handled.
  function handleKey(e) {
    const sel = ctx.selected && item(ctx.selected) ? ctx.selected : null;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && k.toLowerCase() === 'a') { A.arrange(); return true; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && k.toLowerCase() === 'o') { ctx.organize?.(); return true; }
    if (!sel) return false;
    if (k === 'Delete' || k === 'Backspace') { A.close(sel); return true; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'd') { A.duplicate(sel); return true; }
    if (k === 'F2') { A.rename(sel); return true; }
    if (k === 'Enter') { A.zoom(sel); return true; }
    if (k.startsWith('Arrow') && !e.ctrlKey) {
      const it = item(sel);
      if (it.locked) { toast('This window is locked', 'warn'); return true; }
      const step = e.shiftKey ? 50 : 10;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[k];
      ac.updateItem(sel, { x: it.x + d[0], y: it.y + d[1] });
      return true;
    }
    return false;
  }

  // Actions requested from a browser's own (native) right-click menu.
  function run(id, action) {
    if (action === 'duplicate') A.duplicate(id);
    else if (action === 'zoom') A.zoom(id);
    else if (action === 'lock') A.lock(id);
    else if (action === 'close') A.close(id);
    else if (action.startsWith('size:')) A.resize(id, action.slice(5));
  }

  return { ...A, itemMenu, backgroundMenu, showItemMenu, handleKey, run };
}
