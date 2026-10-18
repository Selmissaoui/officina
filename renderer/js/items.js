// Views for the four kinds of canvas items. Every item shares one frame
// (header to drag, corner to resize); the body differs per type.
import { h, clear, debounce, wsUrl, bytes, toast } from './ui.js';
import { renderMarkdown } from './md.js';
import { isSimple, isGame } from './prefs.js';
import { closeMenu } from './menu.js';

const NOTE_COLORS = ['yellow', 'blue', 'green', 'pink', 'purple', 'gray'];
const GRID = 8;

const agentWord = () => (isSimple() ? 'AI working' : isGame() ? 'Companion' : 'Agent');

function frame(item, ctx, { headContent, body, extraClass = '' }) {
  const lockIcon = h('span', { class: 'lock-icon', title: 'Position locked (right-click to unlock)', hidden: !item.locked }, h('span', { class: 'i i-lock' }));
  const agentChip = h('span', { class: 'agent-chip', hidden: true });
  const closeBtn = h('button', { class: 'item-x', title: 'Close (Del). Contents stay in the Library.', onclick: () => ctx.actions.close(item.id) }, '×');
  // A dedicated grip, so a crowded header (browser buttons, tabs, URL bar) always has a place to grab.
  const grip = h('span', { class: 'item-grip', title: 'Drag to move', 'aria-hidden': 'true' });
  const head = h('div', { class: 'item-head' }, grip, headContent, agentChip, lockIcon, closeBtn);
  const resize = h('div', { class: 'item-resize', title: 'Drag to resize' });
  const el = h('div', { class: `item item-${item.type} ${extraClass}`, dataset: { id: item.id } }, head, h('div', { class: 'item-body' }, body), resize);

  const view = {
    item, el, head,
    place(it) {
      el.style.left = `${it.x}px`; el.style.top = `${it.y}px`;
      el.style.width = `${it.w}px`; el.style.height = `${it.h}px`;
      el.style.zIndex = it.z || 1;
      el.classList.toggle('locked', !!it.locked);
      lockIcon.hidden = !it.locked;
    },
    select(on) { el.classList.toggle('selected', on); },
    flash() {
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    },
    agentTouch(agent) {
      el.classList.add('agent-glow');
      agentChip.textContent = agent?.name && agent.name !== 'Agent' ? agent.name : agentWord();
      el.style.setProperty('--agent-color', agent?.color || '');
      agentChip.style.background = agent?.color || '';
      agentChip.hidden = false;
      clearTimeout(view._glow);
      view._glow = setTimeout(() => { el.classList.remove('agent-glow'); agentChip.hidden = true; }, 2200);
    },
  };
  view.place(item);

  el.addEventListener('pointerdown', () => {
    ctx.select(item.id);
    const top = Math.max(0, ...[...ctx.canvas.views.values()].map(v => v.item.z || 0));
    if ((view.item.z || 0) < top) window.ac.updateItem(item.id, { raise: true });
  }, true);

  el.addEventListener('contextmenu', e => {
    if (e.target.closest('input, textarea') && document.activeElement === e.target) return; // keep text-editing menu
    e.preventDefault();
    e.stopPropagation();
    ctx.actions.showItemMenu(item.id, e.clientX, e.clientY);
  });

  const drag = (e, mode) => {
    if (e.button !== 0) return;
    // Header inputs (note title, URL bar) still drag the window when you move
    // more than a few pixels; a plain click focuses them as usual.
    let field = null;
    if (mode === 'move') {
      if (e.target.closest('button, select')) return;
      field = e.target.closest('input, textarea');
      if (field && document.activeElement === field) return;
    }
    if (view.item.locked) {
      if (!field) toast('This window is locked. Right-click it to unlock.', 'warn');
      if (field) field.focus();
      return;
    }
    e.preventDefault();
    const s = ctx.canvas.v.scale;
    const start = { x: e.clientX, y: e.clientY, ix: view.item.x, iy: view.item.y, iw: view.item.w, ih: view.item.h };
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    let started = !field;
    // Webviews swallow the mouse as soon as it passes over them, so switch them off
    // right away, not only once the drag threshold is crossed.
    document.body.classList.add('dragging');
    const begin = () => { started = true; el.classList.add('moving'); closeMenu(); };
    if (started) begin();
    // Snap to an 8px grid; hold Alt for free placement.
    const snap = (v, ev) => (ev.altKey ? Math.round(v) : Math.round(v / GRID) * GRID);
    const move = ev => {
      if (!started) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
        begin();
      }
      const dx = (ev.clientX - start.x) / s, dy = (ev.clientY - start.y) / s;
      if (mode === 'move') { view.item.x = snap(start.ix + dx, ev); view.item.y = snap(start.iy + dy, ev); }
      else { view.item.w = Math.max(220, snap(start.iw + dx, ev)); view.item.h = Math.max(140, snap(start.ih + dy, ev)); }
      view.place(view.item);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      document.body.classList.remove('dragging');
      if (!started) { field.focus(); return; }
      el.classList.remove('moving');
      const { x, y, w, h: hh } = view.item;
      window.ac.updateItem(item.id, { x, y, w, h: hh });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };
  head.addEventListener('pointerdown', e => drag(e, 'move'));
  resize.addEventListener('pointerdown', e => drag(e, 'resize'));
  head.addEventListener('dblclick', e => { if (!e.target.closest('button, input, textarea')) ctx.canvas.focus(item.id); });
  return view;
}

// ---------------- browser ----------------
function browserView(item, ctx) {
  const url = h('input', { class: 'url', value: item.url || '', spellcheck: 'false', title: item.url, 'aria-label': 'Address' });
  const back = h('button', { class: 'nav', title: 'Back' }, '‹');
  const fwd = h('button', { class: 'nav', title: 'Forward' }, '›');
  const reload = h('button', { class: 'nav', title: 'Reload' }, '⟳');
  const keyBadge = h('button', { class: 'key-badge', title: 'Linked keys. Click to manage.', onclick: () => ctx.openPanel('keys', { profile: item.profile }) });
  // Ad and cookie blocking for this browser: the shield shows what was blocked on this page.
  const adCount = h('span', { class: 'ad-count' });
  const adBtn = h('button', { class: 'nav ad-btn', onclick: async () => {
    const on = !ctx.adblockOn(item.profile);
    await ctx.setBrowserAdblock(item.profile, on);
    if (ok()) webview.reload();
    toast(on ? 'Ads and cookie banners are blocked in this browser again' : 'Ad blocking is off for this browser', 'ok');
  } }, h('span', { class: 'i i-shield' }), adCount);
  const renderAd = () => {
    const on = ctx.adblockOn(item.profile);
    adBtn.classList.toggle('off', !on);
    adBtn.title = on ? `Ads, trackers and cookie banners are blocked (${adCount.textContent || 0} on this page). Click to turn off for this browser.` : 'Ad blocking is off for this browser. Click to turn it on.';
  };
  const linkBtn = h('button', { class: 'nav link-btn', title: 'Link a key to this browser', onclick: () => ctx.openPanel('keys', { profile: item.profile, create: true }) }, h('span', { class: 'i i-key' }));
  const tabs = [...(item.tabs || [item.url || 'about:blank'])];
  let activeTab = Math.min(item.activeTab || 0, tabs.length - 1);
  const tabSelect = h('select', {class:'browser-tabs',title:'Tabs','aria-label':'Browser tabs'});
  const renderTabs = () => { clear(tabSelect); tabs.forEach((u,i)=>{let label;try{label=new URL(u).hostname||u;}catch{label=u;}tabSelect.append(h('option',{value:i,selected:i===activeTab},(i+1)+': '+label));}); };
  renderTabs();
  const saveTabs = () => window.ac.updateItem(item.id,{tabs:[...tabs],activeTab});
  tabSelect.onchange = () => {activeTab=Number(tabSelect.value);webview.src=tabs[activeTab];saveTabs();};
  const plusTab = h('button',{class:'nav',title:'New tab',onclick:()=>{tabs.push('https://duckduckgo.com');activeTab=tabs.length-1;renderTabs();webview.src=tabs[activeTab];saveTabs();}},'+');
  const closeTab = h('button',{class:'nav',title:'Close tab',onclick:()=>{if(tabs.length<2)return;tabs.splice(activeTab,1);activeTab=Math.min(activeTab,tabs.length-1);renderTabs();webview.src=tabs[activeTab];saveTabs();}},'−');
  const progress = h('div', { class: 'progress' });
  const webview = document.createElement('webview');
  webview.setAttribute('partition', `persist:ac-${item.profile}`);
  webview.setAttribute('allowpopups', '');
  webview.setAttribute('src', tabs[activeTab]);
  const crashed = h('div', { class: 'crashed', hidden: true }, h('p', {}, 'This page stopped responding.'), h('button', { class: 'btn', onclick: () => { crashed.hidden = true; webview.reload(); } }, 'Reload'));

  const view = frame(item, ctx, {
    headContent: [h('div', { class: 'nav-group' }, back, fwd, reload), tabSelect, plusTab, closeTab, url, adBtn, keyBadge, linkBtn, progress],
    body: [webview, crashed],
  });

  let ready = false;
  const persistUrl = debounce(u => { if (u && u !== 'about:blank') window.ac.updateItem(item.id, { url: u }); }, 600);
  const persistTitle = debounce(t => { if (!view.item.renamed) window.ac.updateItem(item.id, { title: t }); }, 600);

  webview.addEventListener('dom-ready', () => {
    webview.setZoomFactor(view.item.zoom || 1);
    webview.setAudioMuted(!!view.item.muted);
    if (!ready) {
      ready = true;
      window.ac.browserAttached(item.id, webview.getWebContentsId());
    }
  });
  const onNav = e => {
    if (e.isMainFrame === false) return;
    const u = webview.getURL();
    if (document.activeElement !== url) url.value = u;
    url.title = u;
    persistUrl(u);
    tabs[activeTab]=u; renderTabs(); saveTabs();
    back.disabled = !webview.canGoBack();
    fwd.disabled = !webview.canGoForward();
  };
  webview.addEventListener('did-navigate', onNav);
  webview.addEventListener('did-navigate-in-page', onNav);
  webview.addEventListener('page-title-updated', e => persistTitle(e.title));
  webview.addEventListener('did-start-loading', () => view.el.classList.add('loading'));
  webview.addEventListener('did-stop-loading', () => view.el.classList.remove('loading'));
  webview.addEventListener('render-process-gone', () => { crashed.hidden = false; });
  webview.addEventListener('focus', () => { closeMenu(); ctx.select(item.id); window.ac.updateItem(item.id, { raise: true }); });

  back.onclick = () => webview.canGoBack() && webview.goBack();
  fwd.onclick = () => webview.canGoForward() && webview.goForward();
  reload.onclick = () => webview.reload();
  url.addEventListener('focus', () => url.select());
  url.addEventListener('keydown', e => {
    if (e.key === 'Escape') { url.value = webview.getURL(); url.blur(); return; }
    if (e.key !== 'Enter') return;
    let u = url.value.trim();
    if (!u) return;
    if (!/^[a-z]+:/i.test(u)) u = /\s/.test(u) || !/\./.test(u) ? `https://duckduckgo.com/?q=${encodeURIComponent(u)}` : `https://${u}`;
    if (!/^https?:/i.test(u)) return toast('Only web addresses (http or https) can be opened', 'warn');
    webview.loadURL(u).catch(() => {});
    url.blur();
  });

  const renderKeys = () => {
    const linked = ctx.keysForProfile(item.profile);
    keyBadge.hidden = !linked.length;
    linkBtn.hidden = !!linked.length;
    clear(keyBadge).append(h('span', { class: 'i i-key' }), linked.map(k => k.label).join(', '));
  };
  renderKeys();

  const ok = () => ready && webview.isConnected;
  Object.assign(view, {
    update(it) { view.item = it; view.place(it); },
    refreshKeys: renderKeys,
    refreshAd: renderAd,
    setAdCount: n => { adCount.textContent = n ? String(n) : ''; renderAd(); },
    destroy: () => window.ac.browserDetached(item.id),
    currentUrl: () => (ok() ? webview.getURL() : view.item.url),
    canGoBack: () => ok() && webview.canGoBack(),
    canGoForward: () => ok() && webview.canGoForward(),
    goBack: () => ok() && webview.goBack(),
    goForward: () => ok() && webview.goForward(),
    reload: () => ok() && webview.reload(),
  });
  renderAd();
  return view;
}

// ---------------- Brave browser ----------------
// The tab runs in a Brave process of its own (no window on the desktop). This window shows
// its live picture and passes the mouse and keys on, so it works like any browser window.
const BRAVE_BUTTON = { 0: 'left', 1: 'middle', 2: 'right' };
const keyMods = e => [e.altKey && 'alt', e.ctrlKey && 'control', e.metaKey && 'meta', e.shiftKey && 'shift'].filter(Boolean);

function braveView(item, ctx) {
  const id = item.id;
  const url = h('input', { class: 'url', value: item.url || '', spellcheck: 'false', title: item.url, 'aria-label': 'Address' });
  const back = h('button', { class: 'nav', title: 'Back', disabled: true }, '‹');
  const fwd = h('button', { class: 'nav', title: 'Forward', disabled: true }, '›');
  const reload = h('button', { class: 'nav', title: 'Reload' }, '⟳');
  const shieldCount = h('span', { class: 'ad-count' });
  const shield = h('span', { class: 'nav ad-btn brave-shield', title: 'Brave Shields block ads and trackers on this page' }, h('span', { class: 'i i-shield' }), shieldCount);
  const tag = h('span', { class: 'engine-tag', title: 'This window runs in Brave, inside Officina. Its logins are separate from your own Brave.' }, 'Brave');
  const keyBadge = h('button', { class: 'key-badge', title: 'Linked keys. Click to manage.', onclick: () => ctx.openPanel('keys', { profile: item.profile }) });
  const linkBtn = h('button', { class: 'nav link-btn', title: 'Link a key to this browser', onclick: () => ctx.openPanel('keys', { profile: item.profile, create: true }) }, h('span', { class: 'i i-key' }));
  // Tabs a page opened itself (links to a new tab, login popups). Only shown with two or more.
  const tabStrip = h('div', { class: 'brave-tabs', hidden: true });
  const signIn = h('button', { class: 'nav signin-btn', title: 'Sign in in a normal Brave window. Use this when Google, Apple or another site says this browser is not secure. Your login stays in this browser.', onclick: () => window.ac.braveSignIn(id).catch(e => toast(e.message, 'warn')) }, 'Sign in');
  const progress = h('div', { class: 'progress' });
  const surface = h('canvas', { class: 'brave-surface', tabindex: '0', 'aria-label': 'Web page' });
  const cover = h('div', { class: 'brave-cover' }, h('p', {}, 'Starting Brave…'));
  const dialogBox = h('div', { class: 'brave-dialog', hidden: true });
  const view = frame(item, ctx, {
    headContent: [h('div', { class: 'nav-group' }, back, fwd, reload), url, tag, shield, signIn, keyBadge, linkBtn, progress],
    body: [tabStrip, surface, cover, dialogBox],
    extraClass: 'engine-brave',
  });

  const g = surface.getContext('2d');
  let page = { w: 0, h: 0 };   // page size in CSS pixels (from the picture's metadata)
  let st = { url: item.url, canGoBack: false, canGoForward: false };
  let pending = null, drawing = false;
  const paint = async () => {
    if (drawing || !pending) return;
    drawing = true;
    const { data, meta } = pending;
    pending = null;
    try {
      const bmp = await createImageBitmap(new Blob([data], { type: 'image/png' }));
      if (surface.width !== bmp.width || surface.height !== bmp.height) { surface.width = bmp.width; surface.height = bmp.height; }
      g.drawImage(bmp, 0, 0);
      bmp.close();
      page = meta;
      cover.hidden = true;
    } catch { /* a broken picture: the next one replaces it */ }
    drawing = false;
    if (pending) paint();
  };

  const showCover = (text, button) => {
    cover.hidden = false;
    clear(cover).append(h('p', {}, text), ...(button ? [button] : []));
  };
  const installCover = installing => showCover(installing ? 'Brave is being installed in this space…' : 'Brave is not installed in this space yet.',
    installing ? null : h('button', { class: 'btn small primary', onclick: () => ctx.openPanel('settings', { force: true, tab: 'browsers' }) }, 'Install Brave'));

  const renderKeys = () => {
    const linked = ctx.keysForProfile(item.profile);
    keyBadge.hidden = !linked.length;
    linkBtn.hidden = !!linked.length;
    clear(keyBadge).append(h('span', { class: 'i i-key' }), linked.map(k => k.label).join(', '));
  };
  renderKeys();

  const applyState = patch => {
    Object.assign(st, patch);
    if (patch.url !== undefined && document.activeElement !== url) { url.value = patch.url === 'about:blank' ? '' : patch.url; url.title = patch.url; }
    if (patch.canGoBack !== undefined) back.disabled = !patch.canGoBack;
    if (patch.canGoForward !== undefined) fwd.disabled = !patch.canGoForward;
    if (patch.loading !== undefined) view.el.classList.toggle('loading', !!patch.loading);
    if (patch.blocked !== undefined) { shieldCount.textContent = patch.blocked ? String(patch.blocked) : ''; shield.title = `Brave Shields blocked ${patch.blocked || 0} ads and trackers on this page`; }
    if (patch.cursor !== undefined) surface.style.cursor = /^(pointer|text|default|move|grab|grabbing|crosshair|not-allowed|wait|progress|help|col-resize|row-resize|ew-resize|ns-resize|zoom-in|zoom-out)$/.test(patch.cursor) ? patch.cursor : 'default';
    if (patch.dialog !== undefined) renderDialog(patch.dialog);
    if (patch.url && /accounts\.google\.com\/.*\/rejected/.test(patch.url) && !signIn.classList.contains('pulse')) { signIn.classList.add('pulse'); toast('Google does not accept sign-ins from a remote-controlled browser. Click Sign in at the top of this window to log in in a normal Brave window.', 'warn'); }
    if (patch.tabs) {
      tabStrip.hidden = patch.tabs.length < 2;
      tabStrip.replaceChildren(...patch.tabs.map((t, i) => {
        let label = t.title || t.url || 'New tab';
        if (!t.title) { try { label = new URL(t.url).hostname || label; } catch { /* keep */ } }
        return h('div', { class: `brave-tab${i === patch.activeTab ? ' active' : ''}`, title: t.url, onclick: () => window.ac.braveTab(id, 'switch', i).catch(e => toast(e.message, 'warn')) },
          h('span', { class: 'brave-tab-title' }, label),
          h('button', { class: 'brave-tab-x', title: 'Close tab', 'aria-label': 'Close tab', onclick: e => { e.stopPropagation(); window.ac.braveTab(id, 'close', i).catch(err => toast(err.message, 'warn')); } }, '×'));
      }));
    }
    if (patch.activeTab !== undefined && patch.activeTab !== st.shownTab) { st.shownTab = patch.activeTab; report(true); }
    if (patch.signin === true) { signIn.classList.remove('pulse'); return showCover('Sign in in the Brave window that just opened, then close that window. This window continues with your login.', h('button', { class: 'btn small primary', onclick: () => window.ac.braveSignIn(id, true) }, 'Done')); }
    if (patch.signin === false) { page = { w: 0, h: 0 }; return showCover('Starting Brave…'); }
    if (patch.error) showCover(patch.error, h('button', { class: 'btn small', onclick: () => window.ac.braveReopen(id) }, 'Try again'));
    else if (patch.live === false) showCover('Brave stopped for this window.', h('button', { class: 'btn small primary', onclick: () => { showCover('Starting Brave…'); window.ac.braveReopen(id); } }, 'Reload'));
    else if (patch.live === true && !page.w) { showCover('Loading…'); report(true); }
  };

  const renderDialog = d => {
    dialogBox.hidden = !d;
    if (!d) return;
    const input = d.type === 'prompt' ? h('input', { class: 'input', value: d.defaultPrompt || '' }) : null;
    const answer = ok => { window.ac.braveDialog(id, ok, input?.value || ''); dialogBox.hidden = true; surface.focus(); };
    clear(dialogBox).append(h('div', { class: 'brave-dialog-card' },
      h('p', { class: 'muted small' }, d.type === 'alert' ? 'The page says' : d.type === 'confirm' ? 'The page asks' : 'The page asks for an answer'),
      h('p', {}, d.message), input,
      h('div', { class: 'row gap' }, d.type !== 'alert' ? h('button', { class: 'btn small', onclick: () => answer(false) }, 'Cancel') : null, h('button', { class: 'btn small primary', onclick: () => answer(true) }, 'OK'))));
  };

  // ---------- size, visibility and picture sharpness go to Brave ----------
  let sent = {};
  let visible = false;
  const report = (force = false) => {
    if (!surface.isConnected) return;
    const r = surface.getBoundingClientRect();
    // Ask for a picture a bit larger than it shows on screen (never larger than the page itself):
    // shrinking a sharp picture once looks crisp, stretching a small one looks blurry.
    const scale = Math.min(4, Math.max(1, Math.ceil(devicePixelRatio * r.width / Math.max(1, surface.clientWidth) * 4) / 4));
    const v = { visible, w: surface.clientWidth, h: surface.clientHeight, scale, maxW: Math.ceil(surface.clientWidth * scale), maxH: Math.ceil(surface.clientHeight * scale) };
    const changed = force || v.visible !== sent.visible || v.w !== sent.w || v.h !== sent.h || v.scale !== sent.scale;
    if (!changed || !v.w || !v.h) return;
    sent = v;
    window.ac.braveView(id, v).catch(() => {});
  };
  const ro = new ResizeObserver(() => report());
  ro.observe(surface);
  const io = new IntersectionObserver(entries => { visible = entries.some(e => e.isIntersecting); report(); }, { root: ctx.canvas.viewport, rootMargin: '200px' });
  io.observe(view.el);
  const zoomWatch = setInterval(() => { if (visible) report(); }, 900);

  // ---------- the user's mouse and keys ----------
  const toPage = e => {
    const r = surface.getBoundingClientRect();
    const w = page.w || surface.clientWidth, hh = page.h || surface.clientHeight;
    return { x: Math.max(0, Math.min(w - 1, ((e.clientX - r.left) / r.width) * w)), y: Math.max(0, Math.min(hh - 1, ((e.clientY - r.top) / r.height) * hh)) };
  };
  const input = ev => window.ac.braveInput(id, ev);
  let pressed = 0, moveQueued = null;
  const flushMove = () => { const m = moveQueued; moveQueued = null; if (m) input(m); };
  const onMove = e => {
    const p = toPage(e);
    if (!moveQueued) requestAnimationFrame(flushMove);
    moveQueued = { kind: 'mouse', type: 'move', ...p, buttons: e.buttons, modifiers: keyMods(e) };
  };
  surface.addEventListener('mousedown', e => {
    e.preventDefault();
    surface.focus({ preventScroll: true });
    closeMenu();
    pressed++;
    input({ kind: 'mouse', type: 'down', ...toPage(e), button: BRAVE_BUTTON[e.button] || 'left', buttons: e.buttons, clickCount: e.detail || 1, modifiers: keyMods(e) });
    const up = ev => {
      window.removeEventListener('mouseup', up, true);
      window.removeEventListener('mousemove', onMove, true);
      pressed = Math.max(0, pressed - 1);
      flushMove();
      input({ kind: 'mouse', type: 'up', ...toPage(ev), button: BRAVE_BUTTON[ev.button] || 'left', buttons: ev.buttons, clickCount: ev.detail || 1, modifiers: keyMods(ev) });
    };
    window.addEventListener('mouseup', up, true);
    window.addEventListener('mousemove', onMove, true);
  });
  surface.addEventListener('mousemove', e => { if (!pressed) onMove(e); });
  surface.addEventListener('wheel', e => {
    if (e.ctrlKey) return; // Ctrl+wheel still zooms the canvas
    e.preventDefault();
    e.stopPropagation();
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
    input({ kind: 'wheel', ...toPage(e), deltaX: e.deltaX * k, deltaY: e.deltaY * k, modifiers: keyMods(e) });
  }, { passive: false });
  const onKey = type => e => {
    e.stopPropagation();
    if (type === 'down' && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v') { e.preventDefault(); input({ kind: 'paste' }); return; }
    if (type === 'up' && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v') { e.preventDefault(); return; }
    if (e.key === 'F12' || e.isComposing) return;
    e.preventDefault();
    input({ kind: 'key', type, key: e.key, code: e.code, keyCode: e.keyCode, repeat: e.repeat, location: e.location, modifiers: keyMods(e) });
  };
  surface.addEventListener('keydown', onKey('down'));
  surface.addEventListener('keyup', onKey('up'));
  surface.addEventListener('compositionend', e => { if (e.data) input({ kind: 'text', text: e.data }); });
  surface.addEventListener('focus', () => { ctx.select(id); });

  // ---------- header ----------
  back.onclick = () => window.ac.braveNav(id, 'back').catch(e => toast(e.message, 'warn'));
  fwd.onclick = () => window.ac.braveNav(id, 'forward').catch(e => toast(e.message, 'warn'));
  reload.onclick = () => window.ac.braveNav(id, 'reload').catch(() => window.ac.braveReopen(id));
  url.addEventListener('focus', () => url.select());
  url.addEventListener('keydown', e => {
    if (e.key === 'Escape') { url.value = st.url || ''; url.blur(); return; }
    if (e.key !== 'Enter') return;
    let u = url.value.trim();
    if (!u) return;
    if (!/^[a-z]+:/i.test(u)) u = /\s/.test(u) || !/\./.test(u) ? `https://duckduckgo.com/?q=${encodeURIComponent(u)}` : `https://${u}`;
    if (!/^https?:/i.test(u)) return toast('Only web addresses (http or https) can be opened', 'warn');
    window.ac.braveNav(id, u).catch(err => toast(err.message, 'warn'));
    url.blur();
    surface.focus({ preventScroll: true });
  });

  const hello = async () => {
    const r = await window.ac.braveHello(id).catch(() => null);
    if (!r) return;
    if (!r.installed) return installCover(!!r.installing);
    if (r.state) applyState(r.state);
    else showCover('Starting Brave…');
    if (r.frame) { pending = r.frame; paint(); }
    report(true);
  };
  hello();

  Object.assign(view, {
    update(it) { view.item = it; view.place(it); },
    refreshKeys: renderKeys,
    braveFrame(data, meta) { pending = { data, meta }; paint(); },
    braveState: applyState,
    softwareChanged(list) {
      const b = list.find(x => x.id === 'brave');
      if (b?.installing) installCover(true);
      else if (b?.installed && !page.w) { showCover('Starting Brave…'); setTimeout(hello, 800); }
    },
    destroy() { ro.disconnect(); io.disconnect(); clearInterval(zoomWatch); },
    currentUrl: () => st.url || view.item.url,
    canGoBack: () => !!st.canGoBack,
    canGoForward: () => !!st.canGoForward,
    goBack: () => window.ac.braveNav(id, 'back').catch(() => {}),
    goForward: () => window.ac.braveNav(id, 'forward').catch(() => {}),
    reload: () => window.ac.braveNav(id, 'reload').catch(() => window.ac.braveReopen(id)),
  });
  return view;
}

// ---------------- note ----------------
function noteView(item, ctx) {
  const title = h('input', { class: 'note-title', value: item.title || 'Note', spellcheck: 'false', 'aria-label': 'Note title' });
  const colorBtn = h('button', { class: 'color-dot', title: 'Change colour' });
  const modeBtn = h('button', { class: 'nav', title: 'Edit / preview' }, '✎');
  const rendered = h('div', { class: 'note-md scrollable', title: 'Double-click to edit' });
  const editor = h('textarea', { class: 'note-edit scrollable', spellcheck: 'true', hidden: true, placeholder: 'Write here. Markdown works: # heading, **bold**, - list' });
  const by = h('span', { class: 'by agent', hidden: item.createdBy !== 'agent' }, isSimple() ? 'AI' : 'agent');

  const view = frame(item, ctx, { headContent: [colorBtn, title, by, modeBtn], body: [rendered, editor], extraClass: `note-${item.color || 'yellow'}` });
  let content = '';
  const show = () => { rendered.innerHTML = renderMarkdown(content) || '<p class="muted">Empty note. Double-click to write.</p>'; };
  const save = debounce(() => window.ac.noteWrite(item.id, content), 400);
  const setEditing = on => {
    editor.hidden = !on; rendered.hidden = on;
    if (on) { editor.value = content; editor.focus(); } else show();
    modeBtn.textContent = on ? '✓' : '✎';
  };
  window.ac.noteRead(item.id).then(c => { content = c; show(); if (!c && item.createdBy !== 'agent') setEditing(true); });

  editor.addEventListener('input', () => { content = editor.value; save(); });
  editor.addEventListener('blur', () => setEditing(false));
  editor.addEventListener('keydown', e => { if (e.key === 'Escape') editor.blur(); });
  rendered.addEventListener('dblclick', () => setEditing(true));
  modeBtn.onclick = () => setEditing(editor.hidden);
  title.addEventListener('change', () => window.ac.updateItem(item.id, { title: title.value.trim() || 'Note' }));
  title.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') title.blur(); });
  colorBtn.onclick = () => {
    const next = NOTE_COLORS[(NOTE_COLORS.indexOf(view.item.color || 'yellow') + 1) % NOTE_COLORS.length];
    window.ac.updateItem(item.id, { color: next });
  };

  Object.assign(view, {
    update(it) {
      view.item = it;
      view.place(it);
      if (document.activeElement !== title) title.value = it.title || 'Note';
      for (const c of NOTE_COLORS) view.el.classList.toggle(`note-${c}`, (it.color || 'yellow') === c);
    },
    noteChanged(c) {
      content = c;
      if (editor.hidden) show(); else if (document.activeElement !== editor) editor.value = c;
      view.agentTouch();
    },
    edit: () => setEditing(true),
  });
  return view;
}

// ---------------- file ----------------
function fileView(item, ctx) {
  const name = item.path.split('/').pop();
  const exportBtn = h('button', { class: 'nav', title: 'Export a copy out of the workspace', onclick: () => window.ac.exportFile(item.path) }, '⇩');
  const titleEl = h('span', { class: 'item-title', title: item.path }, item.title || name);
  const body = h('div', { class: 'file-body' });
  const kind = previewKind(item.path);
  const view = frame(item, ctx, {
    headContent: [h('span', { class: `i i-${kind === 'image' ? 'image' : 'file'}` }), titleEl, exportBtn],
    body,
  });

  const load = () => {
    clear(body);
    const src = `${wsUrl(item.path)}?t=${Date.now()}`;
    if (kind === 'image') body.append(h('div', { class: 'img-wrap' }, h('img', { src, alt: name, draggable: 'false' })));
    else if (kind === 'pdf') body.append(h('iframe', { src, class: 'pdf', title: name }));
    else if (kind === 'text') {
      const pre = h('pre', { class: 'file-text scrollable' }, 'Loading…');
      body.append(pre);
      window.ac.readText(item.path).then(t => { pre.textContent = t; }).catch(e => { pre.textContent = e.message; });
    } else {
      body.append(h('div', { class: 'file-other' }, h('span', { class: 'i i-file big' }), h('p', {}, name), h('p', { class: 'muted' }, 'This file type has no preview.'), h('button', { class: 'btn', onclick: () => window.ac.exportFile(item.path) }, 'Export a copy…')));
    }
  };
  load();
  Object.assign(view, {
    update(it) { view.item = it; view.place(it); titleEl.textContent = it.title || name; },
    fileChanged(rel) { if (rel === item.path) { load(); view.agentTouch(); } },
  });
  return view;
}

// ---------------- folder ----------------
function folderView(item, ctx) {
  const tree = h('div', { class: 'tree scrollable' });
  const refreshBtn = h('button', { class: 'nav', title: 'Refresh' }, '⟳');
  const titleEl = h('span', { class: 'item-title', title: item.path }, item.title || item.path.split('/').pop() || 'Workspace files');
  const view = frame(item, ctx, { headContent: [h('span', { class: 'i i-folder' }), titleEl, refreshBtn], body: tree });
  const open = new Set();
  const renderDir = async (rel, container, depth) => {
    const entries = await window.ac.listDir(rel);
    if (!entries.length && depth === 0) container.append(h('p', { class: 'muted pad' }, 'This folder is empty'));
    for (const e of entries) {
      const row = h('div', { class: `tree-row ${e.dir ? 'dir' : ''}`, style: { paddingLeft: `${10 + depth * 16}px` }, title: e.path },
        h('span', { class: `i i-${e.dir ? (open.has(e.path) ? 'folder-open' : 'folder') : (e.kind === 'image' ? 'image' : 'file')}` }),
        h('span', { class: 'tree-name' }, e.name),
        e.dir ? null : h('span', { class: 'muted small' }, bytes(e.size)));
      const kids = h('div');
      row.onclick = () => {
        if (e.dir) { if (open.has(e.path)) open.delete(e.path); else open.add(e.path); render(); }
        else ctx.openFile(e.path, view.item);
      };
      container.append(row, kids);
      if (e.dir && open.has(e.path)) await renderDir(e.path, kids, depth + 1);
    }
  };
  const render = async () => {
    const frag = h('div');
    await renderDir(item.path, frag, 0).catch(err => frag.append(h('p', { class: 'muted pad' }, err.message)));
    clear(tree).append(frag);
  };
  refreshBtn.onclick = render;
  render();
  Object.assign(view, {
    update(it) { view.item = it; view.place(it); titleEl.textContent = it.title || item.path.split('/').pop() || 'Workspace files'; },
    fileChanged(rel) { if (!item.path || rel.startsWith(item.path + '/')) render(); },
    refresh: render,
  });
  return view;
}

export function previewKind(rel) {
  const ext = (rel.match(/\.[^./]+$/) || [''])[0].toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.js', '.ts', '.py', '.html', '.css', '.xml', '.yaml', '.yml', '.ini', '.toml', '.sql', '.sh', '.bat', '.ps1'].includes(ext)) return 'text';
  return 'other';
}

export function createItemView(item, ctx) {
  switch (item.type) {
    case 'frame': return groupView(item, ctx);
    case 'widget': return widgetView(item, ctx);
    case 'browser': return item.engine === 'brave' ? braveView(item, ctx) : browserView(item, ctx);
    case 'note': return noteView(item, ctx);
    case 'file': return fileView(item, ctx);
    case 'folder': return folderView(item, ctx);
    default: throw new Error(`Unknown item type ${item.type}`);
  }
}

function groupView(item,ctx) {
 const title=h('input',{class:'note-title',value:item.title,'aria-label':'Frame label',onchange:e=>window.ac.updateItem(item.id,{title:e.target.value})});
 const view=frame(item,ctx,{headContent:[title],body:h('div',{})});
 const place=view.place;view.place=it=>{place(it);view.el.style.zIndex=0;};view.place(item);
 view.update=it=>{view.item=it;title.value=it.title;view.place(it);};view.dispose=()=>{};return view;
}
function parseCsv(text) {
 const rows=[];let row=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell='';}else if(c==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';if(rows.length>=200)break;}else cell+=c;}
 if(cell||row.length){row.push(cell);rows.push(row);}return rows;
}
function widgetView(item,ctx) {
 const body=h('div',{class:'widget-body'}),title=h('span',{},item.title);let disposed=false,loading=false;
 const view=frame(item,ctx,{headContent:[title],body});
 const render=async()=>{if(loading||disposed)return;loading=true;try{let content;
 if(view.item.widget==='price'){const r=await window.ac.ticker(view.item.accountId||'paper',view.item.symbol||'BTC/USDT');if(!r.ok)throw new Error(r.message);content=[h('strong',{},view.item.symbol),h('div',{class:'widget-price'},Number(r.result.last).toLocaleString()),h('small',{},'Updated '+new Date().toLocaleTimeString())];}
 else if(view.item.widget==='portfolio'){const r=await window.ac.balance(view.item.accountId||'paper');if(!r.ok)throw new Error(r.message);content=Object.entries(r.result).map(([asset,value])=>h('p',{},asset+': '+JSON.stringify(value)));}
 else {const text=await window.ac.readText(view.item.path);content=[h('table',{},parseCsv(text).map(row=>h('tr',{},row.map(cell=>h('td',{},cell))))),h('small',{},'Up to 200 rows')];}
 if(!disposed)clear(body).append(...content);
 }catch(e){if(!disposed)clear(body).append(h('p',{class:'muted'},e.message));}finally{loading=false;}};
 const timer=setInterval(render,30000);render();view.update=it=>{view.item=it;view.place(it);title.textContent=it.title;};view.dispose=()=>{disposed=true;clearInterval(timer);};return view;
}
