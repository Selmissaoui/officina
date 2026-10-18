'use strict';
// Drives the live <webview> browsers on the canvas for agents. Page reading
// runs in an isolated JavaScript world, so element references live outside
// the page's own scripts (a hostile page can't tamper with them), and input
// is delivered as real input events, the same path as the user's own clicks.
// Every pointer action first moves the visible AI cursor (see cursor.js).
const { webContents } = require('electron');
const { agentUrl } = require('./search');
const botcheck = require('./botcheck');

const WORLD = 1077;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const COLLECT = `
  const queryAll = (selector, root = document) => { const out = [...root.querySelectorAll(selector)]; for (const el of root.querySelectorAll('*')) if (el.shadowRoot) out.push(...queryAll(selector, el.shadowRoot)); return out; };
  const vis = (el, viewportOnly) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el); if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
    return viewportOnly ? (r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) : true; };
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=option],[role=combobox],[role=textbox],[role=slider],[contenteditable=""],[contenteditable=true],summary,[onclick],[tabindex]:not([tabindex="-1"])';
  const label = el => el.type === 'password' ? '[password hidden]' : (el.getAttribute('aria-label') || ((el.labels && el.labels[0]) ? el.labels[0].innerText : '') || el.innerText || el.value || el.getAttribute('placeholder') || el.title || el.getAttribute('alt') || el.name || '').replace(/\\s+/g, ' ').trim().slice(0, 90);
  const describe = (el, i) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'input' ? 'input:' + (el.type || 'text') : tag);
    let line = '[' + i + '] ' + role + ' "' + label(el) + '"';
    if (tag === 'a' && el.href) line += ' -> ' + el.href.slice(0, 120);
    if ((tag === 'input' || tag === 'textarea') && el.value && el.type !== 'password') line += ' value="' + el.value.slice(0, 60) + '"';
    if (el.disabled) line += ' (disabled)';
    return line;
  };`;

const READ_SCRIPT = (maxChars, onlyViewport) => `(() => {${COLLECT}
  const refs = [], lines = [], boxes = [], seen = new Set();
  for (const el of queryAll(SEL)) {
    if (el.type === 'password') continue;
    if (refs.length >= 250) break;
    if (seen.has(el) || !vis(el, ${onlyViewport})) continue;
    seen.add(el);
    const i = refs.push(el) - 1;
    lines.push(describe(el, i));
    const r = el.getBoundingClientRect();
    boxes.push({ i, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  }
  window.__acRefs = refs;
  const shadowText = queryAll('*').filter(e => e.shadowRoot).map(e => e.shadowRoot.textContent || '').join('\\n');
  const text = ((document.body ? document.body.innerText : '') + '\\n' + shadowText).replace(/\\n{3,}/g, '\\n\\n');
  return { url: location.href, title: document.title, text: text.slice(0, ${maxChars}), truncated: text.length > ${maxChars},
    elements: lines, boxes, viewport: { w: innerWidth, h: innerHeight },
    scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight } };
})()`;

const FIND_SCRIPT = query => `(() => {
  const queryAll = (selector, root = document) => { const out = [...root.querySelectorAll(selector)]; for (const el of root.querySelectorAll('*')) if (el.shadowRoot) out.push(...queryAll(selector, el.shadowRoot)); return out; };
  const q = ${JSON.stringify(String(query).toLowerCase())};
  const SEL = 'a,button,input,select,textarea,[role],[contenteditable],summary,label,[onclick],h1,h2,h3,h4,span,div,li,td,p';
  window.__acRefs = window.__acRefs || [];
  const out = [];
  const score = el => { const t = el.tagName; return /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(t) || el.getAttribute('role') ? 0 : 1; };
  const hits = [];
  for (const el of queryAll(SEL)) {
    if (el.type === 'password') continue;
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
    const own = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || el.title || '').toLowerCase();
    const txt = (el.innerText || '').toLowerCase();
    if (!(own.includes(q) || (txt.includes(q) && txt.length < q.length + 120))) continue;
    hits.push(el);
    if (hits.length > 400) break;
  }
  // Prefer the innermost match: drop elements that contain another match.
  const inner = hits.filter(el => !hits.some(o => o !== el && el.contains(o)));
  hits.length = 0; hits.push(...inner);
  // Prefer clickable elements; for text inside a link/button, use the clickable ancestor.
  const norm = hits.map(el => el.closest('a,button,[role=button],[role=link],[role=tab],[role=menuitem],summary,label') || el);
  const uniq = [...new Set(norm)].sort((a, b) => score(a) - score(b));
  for (const el of uniq.slice(0, 25)) {
    let i = window.__acRefs.indexOf(el); if (i < 0) i = window.__acRefs.push(el) - 1;
    out.push({ ref: i, line: '[' + i + '] ' + (el.getAttribute('role') || el.tagName.toLowerCase()) + ' "' + (el.getAttribute('aria-label') || ((el.labels && el.labels[0]) ? el.labels[0].innerText : '') || el.innerText || el.value || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 90) + '"' });
  }
  return out;
})()`;

const POINT_SCRIPT = ref => `(() => {
  const el = (window.__acRefs || [])[${Number(ref)}];
  if (!el || !el.isConnected) return { error: 'stale' };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const x = r.left + Math.min(r.width / 2, Math.max(4, r.width - 4)), y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  if (el.type === 'password') return { error: 'password' };
  const name = (el.getAttribute('aria-label') || ((el.labels && el.labels[0]) ? el.labels[0].innerText : '') || el.innerText || el.value || el.getAttribute('placeholder') || el.title || el.tagName.toLowerCase()).replace(/\\s+/g, ' ').trim().slice(0, 40);
  return { x: Math.round(x), y: Math.round(y), covered: !!hit && hit !== el && !el.contains(hit) && !hit.contains(el),
    editable: el.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(el.tagName), tag: el.tagName.toLowerCase(),
    password: el.type === 'password', name, options: el.tagName === 'SELECT' ? [...el.options].map(o => o.text) : null };
})()`;

const LINKS_SCRIPT = (filter, limit) => `(() => {
  const queryAll = (selector, root = document) => { const out = [...root.querySelectorAll(selector)]; for (const el of root.querySelectorAll('*')) if (el.shadowRoot) out.push(...queryAll(selector, el.shadowRoot)); return out; };
  const f = ${JSON.stringify(String(filter || '').toLowerCase())};
  const seen = new Set(), out = [];
  for (const a of queryAll('a[href]')) {
    const href = a.href; if (!/^https?:/.test(href) || seen.has(href)) continue;
    const text = (a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    if (f && !(href.toLowerCase().includes(f) || text.toLowerCase().includes(f))) continue;
    seen.add(href); out.push({ text, href });
    if (out.length >= ${Number(limit) || 200}) break;
  }
  return out;
})()`;

const KEY_MAP = {
  enter: 'Return', return: 'Return', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete',
  arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End', space: 'Space',
};

class BrowserControl {
  constructor() {
    this.wcByItem = new Map();
    this.waiters = new Map();
    this.cursor = null;
    this.logs = new Map();
    this.dialogs = new Map();
    this.mouse = new Map(); // last pointer position per browser (page coordinates)
    this.lastNav = new Map();   // host -> time of the last page load, to keep our pace civil
    this.botChecks = new Map(); // itemId -> label of a bot check the user still has to clear
    this.onBotCheck = null;     // set by extensions: hands the browser to the user
    this.external = null;       // Brave engine: its tabs answer the same calls as a webContents
  }

  setCursor(cursor) {
    this.cursor = cursor;
  }

  attach(itemId, wcId) {
    this.wcByItem.set(itemId, wcId);
    const wc=this.wc(itemId);
    if(!wc.__acDebug) {
      wc.__acDebug=true;
      try {
        if(!wc.debugger.isAttached())wc.debugger.attach('1.3');
        wc.debugger.on('message',(_e,method,params)=>{
          if(method==='Page.javascriptDialogOpening')this.dialogs.set(itemId,{type:params.type,message:params.message});
          if(method==='Page.javascriptDialogClosed')this.dialogs.delete(itemId);
          if(method==='Page.frameNavigated'&&!params.frame.parentId)this.botChecks.delete(itemId);
          let entry;
          if(method==='Runtime.consoleAPICalled')entry={type:'console',level:params.type,text:(params.args||[]).map(a=>a.value===undefined?a.type:String(a.value)).join(' ').slice(0,500)};
          if(method==='Network.responseReceived'){let url=params.response.url;try{const u=new URL(url);url=u.origin+u.pathname;}catch{}entry={type:'network',status:params.response.status,url};}
          if(entry){const log=this.logs.get(itemId)||[];log.push({time:Date.now(),...entry});this.logs.set(itemId,log.slice(-200));}
        });
        for(const method of ['Page.enable','Runtime.enable','Network.enable'])wc.debugger.sendCommand(method).catch(()=>{});
      }catch{}
    }
    for (const fn of this.waiters.get(itemId) || []) fn(wcId);
    this.waiters.delete(itemId);
  }

  detach(itemId) {
    this.wcByItem.delete(itemId);
    this.logs.delete(itemId);
    this.dialogs.delete(itemId);
    this.mouse.delete(itemId);
  }

  wc(itemId) {
    const page = this.external?.page(itemId);
    if (page) {
      if (page.isDestroyed()) throw new Error(`Browser "${itemId}" is not running (Brave stopped). Reload it in the canvas or open a new one.`);
      return page;
    }
    const id = this.wcByItem.get(itemId);
    const wc = id != null ? webContents.fromId(id) : null;
    if (!wc || wc.isDestroyed()) throw new Error(`Browser "${itemId}" is not live yet. Wait a moment or check workspace_overview.`);
    return wc;
  }

  waitForAttach(itemId, timeout = 15000) {
    if (this.wcByItem.has(itemId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Browser did not start in time')), timeout);
      const list = this.waiters.get(itemId) || [];
      list.push(() => { clearTimeout(t); resolve(); });
      this.waiters.set(itemId, list);
    });
  }

  async waitForLoad(itemId, timeout = 15000) {
    const wc = this.wc(itemId);
    if (!wc.isLoading()) return;
    await new Promise(resolve => {
      const t = setTimeout(done, timeout);
      function done() { clearTimeout(t); wc.removeListener('did-stop-loading', done); resolve(); }
      wc.once('did-stop-loading', done);
    });
  }

  async debug(itemId, method, args = {}) {
    const wc=this.wc(itemId);
    if(!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    return wc.debugger.sendCommand(method,args);
  }
  async frames(itemId) {
    await this.guard?.check(itemId,'frames');
    const {frameTree}=await this.debug(itemId,'Page.getFrameTree');
    const out=[];const visit=node=>{out.push({id:node.frame.id,url:node.frame.url,name:node.frame.name||''});for(const child of node.childFrames||[])visit(child);};visit(frameTree);return out;
  }
  async frameRun(itemId, frameId, code) {
    const frames=await this.frames(itemId), f=frames.find(f=>f.id===frameId);
    if(!f)throw new Error('Frame no longer exists; list frames again');
    const {allowedSite,rulesFor}=require('./guardrails');
    if(this.guard && !allowedSite(f.url,rulesFor(this.guard.ws,itemId).sites))throw new Error('Frame site is outside the allowlist');
    const {executionContextId}=await this.debug(itemId,'Page.createIsolatedWorld',{frameId,worldName:'officina-frame'});
    const result=await this.debug(itemId,'Runtime.evaluate',{expression:code,contextId:executionContextId,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return result.result.value;
  }
  async frameRead(itemId, frameId) { await this.guard?.check(itemId,'read');return this.frameRun(itemId,frameId,READ_SCRIPT(12000,false)); }
  async frameAct(itemId, frameId, ref, action, value) {
    await this.guard?.check(itemId,action);
    if(!['click','type'].includes(action))throw new Error('Use click or type');
    return this.frameRun(itemId,frameId,`(()=>{const el=window.__acRefs?.[${Number(ref)}];if(!el?.isConnected)throw new Error('Read the frame again');if(el.type==='password')throw new Error('Password fields are reserved for the user');el.scrollIntoView({block:'center'});if(${JSON.stringify(action)}==='click'){el.click();return 'Clicked';}if(!['INPUT','TEXTAREA','SELECT'].includes(el.tagName))throw new Error('Not a form field');const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value')?.set;if(!setter)throw new Error('Unsupported field');setter.call(el,${JSON.stringify(String(value||''))});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return 'Filled';})()`);
  }
  async upload(itemId, selector, file) {
    await this.guard?.check(itemId,'upload');
    const {root}=await this.debug(itemId,'DOM.getDocument',{depth:0});
    const {nodeId}=await this.debug(itemId,'DOM.querySelector',{nodeId:root.nodeId,selector});
    if(!nodeId)throw new Error('File input not found');
    const {node}=await this.debug(itemId,'DOM.describeNode',{nodeId});
    const attrs=node.attributes||[], map={};for(let i=0;i<attrs.length;i+=2)map[attrs[i]]=attrs[i+1];
    if(node.nodeName!=='INPUT'||map.type!=='file')throw new Error('Select an input[type=file] field');
    await this.debug(itemId,'DOM.setFileInputFiles',{nodeId,files:[file]});return {uploaded:true};
  }
  async dialog(itemId, accept, promptText='') {
    await this.guard?.check(itemId,'dialog');
    await this.debug(itemId,'Page.handleJavaScriptDialog',{accept:!!accept,promptText:String(promptText)});return {handled:true};
  }
  run(itemId, code) {
    return this.wc(itemId).executeJavaScriptInIsolatedWorld(WORLD, [{ code }]);
  }

  // ---------- pointer plumbing ----------

  // Glide the AI cursor (and the page's mouse) to a page point. Intermediate
  // mouseMove events go to the page too, so hover menus react the same way
  // they would to a person moving the mouse there.
  async _pointerTo(itemId, x, y, caption, modifiers = []) {
    const wc = this.wc(itemId);
    const from = this.mouse.get(itemId);
    const ms = this.cursor ? this.cursor.move(this.cursor.pageToWorld(itemId, x, y), { caption, itemId }) : 0;
    const steps = ms && from ? Math.max(2, Math.min(24, Math.round(ms / 35))) : 1;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // same easing as the visual cursor
      const px = from ? Math.round(from.x + (x - from.x) * e) : x;
      const py = from ? Math.round(from.y + (y - from.y) * e) : y;
      wc.sendInputEvent({ type: 'mouseMove', x: px, y: py, modifiers });
      if (ms) await sleep(ms / steps);
    }
    this.mouse.set(itemId, { x, y });
  }

  async _press(wc, x, y, button = 'left', clickCount = 1) {
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount });
    await sleep(55);
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount });
  }

  async _resolve(itemId, { ref, x, y, text }) {
    if (text != null && ref == null) {
      const found = await this.find(itemId, text);
      if (!found.length) throw new Error(`Nothing on the page matches "${text}". Try browser_read or a shorter text.`);
      ref = found[0].ref;
    }
    if (ref != null) {
      const info = await this.run(itemId, POINT_SCRIPT(ref));
      if (info.error) throw new Error(`Element [${ref}] is gone (the page changed). Call browser_read again for fresh refs.`);
      await sleep(80);
      return info;
    }
    if (x == null || y == null) throw new Error('Give a ref (from browser_read/browser_find), a text to click, or x and y page coordinates.');
    const secret = await this.run(itemId, `(() => {let e=document.elementFromPoint(${Number(x)},${Number(y)});while(e?.shadowRoot){const inner=e.shadowRoot.elementFromPoint(${Number(x)},${Number(y)});if(!inner||inner===e)break;e=inner;}return e?.type==='password'||e?.tagName==='IFRAME';})()`);
    if(secret) throw new Error('Use ask_user for passwords; use frame tools for embedded pages');
    return { x: Math.round(x), y: Math.round(y), name: `${Math.round(x)}, ${Math.round(y)}` };
  }

  async assertNotPassword(itemId) {
    const blocked = await this.run(itemId, `(() => { let e = document.activeElement; while(e?.shadowRoot?.activeElement) e = e.shadowRoot.activeElement; return e?.type === 'password' || e?.tagName === 'IFRAME'; })()`);
    if (blocked) throw new Error('Password fields and uninspected embedded fields are reserved for the user; use ask_user');
  }

  // ---------- actions ----------

  async navigate(itemId, url) {
    await this.guard?.check(itemId, 'navigate', { url });
    const wc = this.wc(itemId);
    const label = { back: 'Go back', forward: 'Go forward', reload: 'Reload' }[url];
    if (this.cursor) {
      await this.cursor.moveAndWait(this.cursor.itemPoint(itemId, 'urlbar'), { caption: label || `Go to ${String(url).slice(0, 48)}`, itemId });
      this.cursor.event('click', { button: 'left' });
    }
    if (url === 'back') wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack();
    else if (url === 'forward') wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward();
    else if (url === 'reload') wc.reload();
    else {
      url = agentUrl(url);
      await this.pace(url);
      if (!/^https?:/i.test(url) && url !== 'about:blank') throw new Error('Only http(s) URLs can be opened.');
      wc.loadURL(url).catch(() => {});
    }
    this.mouse.delete(itemId);
    await sleep(300);
    await this.waitForLoad(itemId);
    const handed = await this.handOverIfBotCheck(itemId);
    return { url: wc.getURL(), title: wc.getTitle(), ...(handed ? { note: handed } : {}) };
  }

  // Bot checks belong to the user: spot one, hand the window over, keep the agent out.
  // At most one page load per host per second, so we never flood a site.
  async pace(url, minGap = 1000) {
    let host; try { host = new URL(url).hostname; } catch { return; }
    const wait = minGap - (Date.now() - (this.lastNav.get(host) || 0));
    if (wait > 0) await sleep(Math.min(wait, minGap));
    this.lastNav.set(host, Date.now());
  }

  async botCheck(itemId) {
    const wc = this.wc(itemId);
    let kind = botcheck.fromUrl(wc.getURL());
    if (!kind) { try { kind = await this.run(itemId, botcheck.DETECT_SCRIPT); } catch { kind = null; } }
    if (kind) this.botChecks.set(itemId, kind); else this.botChecks.delete(itemId);
    return kind || null;
  }

  // Returns a line for the agent when the user had to step in, otherwise null.
  async handOverIfBotCheck(itemId) {
    const kind = await this.botCheck(itemId);
    if (!kind) return null;
    const url = this.wc(itemId).getURL();
    if (!this.onBotCheck) return `${kind} on this page. Ask the user to complete it (ask_user); do not try to solve or avoid it.`;
    const result = await this.onBotCheck(itemId, botcheck.message(kind, url));
    this.botChecks.delete(itemId);
    const cleared = await this.botCheck(itemId);
    if (!result?.accepted) return `${kind} not cleared by the user. Stop here and tell them.`;
    if (cleared) return `${kind} is still on the page. Ask the user again or try another site.`;
    return null;
  }

  async read(itemId, { maxChars = 12000, onlyViewport = true } = {}) {
    await this.guard?.check(itemId, "read");
    await this.waitForLoad(itemId, 8000);
    const handed = await this.handOverIfBotCheck(itemId);
    const page = await this.run(itemId, READ_SCRIPT(Math.max(500, Math.min(maxChars, 60000)), !!onlyViewport));
    return handed ? { ...page, note: handed } : page;
  }

  async find(itemId, query) {
    await this.guard?.check(itemId, "find");
    return this.run(itemId, FIND_SCRIPT(query));
  }

  async links(itemId, { filter, limit } = {}) {
    await this.guard?.check(itemId, 'links');
    return this.run(itemId, LINKS_SCRIPT(filter, limit));
  }

  async click(itemId, { ref, x, y, text, button = 'left', double = false }) {
    await this.guard?.check(itemId, "click");
    const wc = this.wc(itemId);
    const info = await this._resolve(itemId, { ref, x, y, text });
    const verb = double ? 'Double-click' : button === 'right' ? 'Right-click' : 'Click';
    await this._pointerTo(itemId, info.x, info.y, `${verb} “${info.name}”`);
    const pause = this.cursor?.event('click', { button, double }) || 0;
    await this._press(wc, info.x, info.y, button, 1);
    if (double) { await sleep(70); await this._press(wc, info.x, info.y, button, 2); }
    if (pause) await sleep(pause);
    await sleep(300);
    // A link or button that opens a new tab or popup: in Brave it becomes the shown tab of
    // this same window, so the next read and click already work in it. Say so explicitly.
    await this.external?.tabSettled?.(itemId);
    const now = this.wc(itemId);
    await this.waitForLoad(itemId, 8000);
    const tabs = now !== wc ? this.external.tabList(itemId) : null;
    const notes = [info.covered && 'Another element was on top of the target; the click may have hit an overlay.',
      tabs && `This opened a new tab (${tabs.tabs.length} tabs now). You are in it: id ${itemId} now shows ${now.getURL()}. When it closes by itself (a login popup), the window goes back to the previous tab; browser_tabs lists, switches or closes tabs.`].filter(Boolean);
    return { clicked: { x: info.x, y: info.y, target: info.name }, covered: !!info.covered, url: now.getURL(), newTab: !!tabs || undefined, note: notes.join(' ') || undefined };
  }

  async hover(itemId, { ref, x, y, text }) {
    await this.guard?.check(itemId, "hover");
    const info = await this._resolve(itemId, { ref, x, y, text });
    await this._pointerTo(itemId, info.x, info.y, `Hover “${info.name}”`);
    await sleep(400);
    return { hovering: { x: info.x, y: info.y, target: info.name } };
  }

  async drag(itemId, { from, to }) {
    await this.guard?.check(itemId, "drag");
    const wc = this.wc(itemId);
    const a = await this._resolve(itemId, from || {});
    await this._pointerTo(itemId, a.x, a.y, `Drag from “${a.name}”`);
    wc.sendInputEvent({ type: 'mouseDown', x: a.x, y: a.y, button: 'left', clickCount: 1 });
    this.cursor?.event('drag', { phase: 'start' });
    await sleep(120);
    const b = to.ref != null || to.text != null ? await this._resolve(itemId, to) : { x: Math.round(to.x), y: Math.round(to.y), name: `${Math.round(to.x)}, ${Math.round(to.y)}` };
    await this._pointerTo(itemId, b.x, b.y, `Drop on “${b.name}”`, ['leftButtonDown']);
    if (!this.cursor?.enabled) {
      // Without the animation, still pass through a few points so drag handlers fire.
      for (let i = 1; i <= 8; i++) { wc.sendInputEvent({ type: 'mouseMove', x: Math.round(a.x + (b.x - a.x) * i / 8), y: Math.round(a.y + (b.y - a.y) * i / 8), modifiers: ['leftButtonDown'] }); await sleep(16); }
    }
    await sleep(80);
    wc.sendInputEvent({ type: 'mouseUp', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    this.cursor?.event('drag', { phase: 'end' });
    await sleep(250);
    return { dragged: { from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y } } };
  }

  async key(itemId, combo, { silent = false } = {}) {
    if (!silent) await this.guard?.check(itemId, 'key');
    await this.assertNotPassword(itemId);
    const wc = this.wc(itemId);
    const parts = String(combo).split('+').map(s => s.trim());
    const keyName = parts.pop();
    const modifiers = parts.map(m => ({ ctrl: 'control', control: 'control', cmd: 'meta', meta: 'meta', alt: 'alt', shift: 'shift' }[m.toLowerCase()])).filter(Boolean);
    const keyCode = KEY_MAP[keyName.toLowerCase()] || keyName;
    if (!silent && this.cursor) {
      const pause = this.cursor.event('key', { label: combo });
      if (pause) await sleep(pause);
    }
    // Editing shortcuts (select all, copy, paste, cut, undo) by name: on a Mac Ctrl+A moves
    // to the line start, and Cmd needs the menu, so call the editing command itself there.
    const edit = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo' }[String(keyCode).toLowerCase()];
    if (process.platform === 'darwin' && edit && modifiers.some(m => m === 'control' || m === 'meta') && !modifiers.includes('alt') && typeof wc[edit] === 'function') {
      await wc[edit]();
      await sleep(150);
      return;
    }
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (!modifiers.some(m => m === 'control' || m === 'meta' || m === 'alt')) {
      if (keyCode === 'Return') wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
      else if (keyCode.length === 1) wc.sendInputEvent({ type: 'char', keyCode, modifiers });
      else if (keyCode === 'Space') wc.sendInputEvent({ type: 'char', keyCode: ' ', modifiers });
    }
    await sleep(30);
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(250);
  }

  async type(itemId, { text, ref, clear = false, submit = false }) {
    await this.guard?.check(itemId, "type");
    const wc = this.wc(itemId);
    let secret = false;
    await this.assertNotPassword(itemId);
    if (ref != null) {
      const info = await this.run(itemId, POINT_SCRIPT(ref));
      if (info.error) throw new Error(`Element [${ref}] is gone. Call browser_read again for fresh refs.`);
      if (info.tag === 'select') {
        await this._pointerTo(itemId, info.x, info.y, `Choose “${String(text).slice(0, 30)}”`);
        this.cursor?.event('click', { button: 'left' });
        const ok = await this.run(itemId, `(() => { const el = window.__acRefs[${Number(ref)}]; const o = [...el.options].find(o => o.text.trim().toLowerCase() === ${JSON.stringify(String(text).toLowerCase())} || o.value === ${JSON.stringify(String(text))}); if (!o) return false; el.value = o.value; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
        if (!ok) throw new Error(`No option "${text}". Options: ${info.options.join(' | ')}`);
        return { selected: text };
      }
      if (info.password) throw new Error('Password fields are reserved for the user');
      secret = info.password;
      await this._pointerTo(itemId, info.x, info.y, `Click “${info.name}”`);
      this.cursor?.event('click', { button: 'left' });
      await this._press(wc, info.x, info.y);
      await sleep(150);
    }
    await this.assertNotPassword(itemId);
    if (clear) {
      await this.key(itemId, 'ctrl+a', { silent: true });
      await this.key(itemId, 'Backspace', { silent: true });
    }
    // Type in short chunks rather than pasting one blob, so sites that
    // listen for per-keystroke input (search boxes, compose fields) react.
    const s = String(text);
    const shown = secret ? '•'.repeat(Math.min(s.length, 12)) : s;
    const watch = this.cursor?.enabled;
    const chunk = watch ? 4 : 12;
    for (let i = 0; i < s.length; i += chunk) {
      await this.assertNotPassword(itemId);
      if (this.guard?.isPaused()) throw new Error('The user pressed STOP');
      wc.insertText(s.slice(i, i + chunk));
      this.cursor?.event('type', { text: shown.slice(0, Math.min(shown.length, i + chunk)), caption: 'Typing' });
      await sleep(watch ? 45 : 25);
    }
    if (submit) await this.key(itemId, 'Enter');
    await sleep(200);
    return { typed: s.length, submitted: !!submit, url: wc.getURL() };
  }

  async scroll(itemId, { direction = 'down', amount = 600, ref, x, y } = {}) {
    await this.guard?.check(itemId, "scroll");
    const wc = this.wc(itemId);
    let px = x, py = y;
    if (ref != null) {
      const info = await this._resolve(itemId, { ref });
      px = info.x; py = info.y;
    }
    if (px == null || py == null) {
      const size = await this.run(itemId, '({ w: innerWidth, h: innerHeight })');
      px = Math.round(size.w / 2); py = Math.round(size.h / 2);
    }
    await this._pointerTo(itemId, px, py, `Scroll ${direction}`);
    const steps = Math.max(1, Math.round(amount / 120));
    const sign = direction === 'up' ? 1 : -1;
    for (let i = 0; i < steps; i++) {
      wc.sendInputEvent({ type: 'mouseWheel', x: px, y: py, deltaX: 0, deltaY: sign * 120, wheelTicksY: sign, canScroll: true });
      if (i % 3 === 0) this.cursor?.event('scroll', { dir: direction });
      await sleep(35);
    }
    await sleep(400);
    return this.run(itemId, '({ y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight })');
  }

  // Chromium stops painting a browser that is completely off-screen, so a
  // capture of it never resolves. If the first try times out, bring the
  // window into the user's view (onHidden) and capture again. The image is
  // scaled to CSS pixels so x/y read off a screenshot can be clicked directly.
  async screenshot(itemId, { onHidden } = {}) {
    await this.guard?.check(itemId, "screenshot");
    const wc = this.wc(itemId);
    const attempt = ms => Promise.race([wc.capturePage(), sleep(ms).then(() => null)]);
    let img = await attempt(2500);
    if ((!img || img.isEmpty()) && onHidden) {
      onHidden();
      await sleep(700);
      img = await attempt(5000);
    }
    if (!img || img.isEmpty()) throw new Error('The browser did not produce a frame (window minimised?). Try item_focus, then retry.');
    const css = await this.run(itemId, '({ w: innerWidth, h: innerHeight })').catch(() => null);
    if (css && img.getSize().width !== css.w) img = img.resize({ width: css.w, height: css.h, quality: 'good' });
    return img;
  }

  async waitFor(itemId, { text, timeoutMs = 10000 }) {
    await this.guard?.check(itemId, "waitFor");
    const end = Date.now() + Math.min(timeoutMs, 60000);
    while (Date.now() < end) {
      const found = await this.run(itemId, `document.body ? document.body.innerText.toLowerCase().includes(${JSON.stringify(String(text).toLowerCase())}) : false`).catch(() => false);
      if (found) return { found: true };
      await sleep(400);
    }
    return { found: false };
  }

  // Point something out to the user without touching the page.
  async point(itemId, { ref, x, y, text, message }) {
    await this.guard?.check(itemId, "point");
    let world;
    if (this.wcByItem.has(itemId) && (ref != null || text != null || (x != null && y != null))) {
      const info = await this._resolve(itemId, { ref, x, y, text });
      world = this.cursor.pageToWorld(itemId, info.x, info.y);
    } else {
      world = this.cursor.itemPoint(itemId, 'center');
    }
    await this.cursor.moveAndWait(world, { itemId });
    this.cursor.event('point', { message: String(message || '').slice(0, 280) });
    return { pointed: true };
  }
}

module.exports = { BrowserControl };
