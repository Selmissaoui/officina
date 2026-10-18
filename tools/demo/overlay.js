// Injected into the Officina window while recording the demo video: title cards, captions,
// a visible "user" cursor that moves and clicks, typing and a spotlight. Pure presentation:
// every click still goes through the real interface.
module.exports = `(() => {
  if (window.__ad) return true;
  const css = document.createElement('style');
  css.textContent = \`
    .ad-layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; font-family: var(--font-display, "Segoe UI", system-ui); }
    .ad-card { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 22px; text-align: center; color: #fff;
      background: radial-gradient(1200px 600px at 50% 40%, rgba(61,181,162,.28), transparent 60%), radial-gradient(900px 500px at 80% 90%, rgba(140,120,255,.22), transparent 60%), #0b0d10;
      opacity: 0; transition: opacity .6s ease; }
    .ad-card.on { opacity: 1; }
    .ad-card .ad-logo { display: grid; grid-template-columns: 34px 34px; grid-template-rows: 34px 34px; gap: 8px; transform: scale(.9); transition: transform 1.2s cubic-bezier(.2,.8,.2,1); }
    .ad-card.on .ad-logo { transform: scale(1); }
    .ad-logo i { border-radius: 9px; background: #3db5a2; } .ad-logo i:nth-child(2) { background: #b58cff; } .ad-logo i:nth-child(3) { background: #f4cf5f; } .ad-logo i:nth-child(4) { background: #7d9cff; }
    .ad-card h1 { margin: 0; font-size: 76px; font-weight: 700; letter-spacing: -.02em; line-height: 1.05; }
    .ad-card p { margin: 0; font-size: 28px; color: #b8c0cc; max-width: 1100px; line-height: 1.35; font-family: var(--font, system-ui); }
    .ad-card .ad-chips { display: flex; gap: 12px; margin-top: 6px; }
    .ad-card .ad-chips span { font-size: 18px; padding: 8px 16px; border-radius: 99px; background: rgba(255,255,255,.08); color: #e8ecf1; font-family: var(--font, system-ui); }
    .ad-cap { position: absolute; left: 50%; bottom: 64px; transform: translate(-50%, 24px); opacity: 0; transition: opacity .45s ease, transform .45s cubic-bezier(.2,.8,.2,1);
      display: flex; align-items: center; gap: 18px; padding: 18px 30px 18px 22px; border-radius: 18px; background: rgba(10,12,15,.88); color: #fff; box-shadow: 0 20px 60px rgba(0,0,0,.45); backdrop-filter: blur(8px); max-width: 1500px; }
    .ad-cap.on { opacity: 1; transform: translate(-50%, 0); }
    .ad-cap .ad-bar { width: 6px; align-self: stretch; border-radius: 6px; background: linear-gradient(#3db5a2, #7d9cff); }
    .ad-cap strong { display: block; font-size: 34px; font-weight: 650; letter-spacing: -.01em; }
    .ad-cap span { display: block; font-size: 20px; color: #b8c0cc; margin-top: 3px; font-family: var(--font, system-ui); }
    .ad-cursor { position: absolute; left: 0; top: 0; width: 30px; height: 30px; transform: translate(-100px, -100px); transition: transform .9s cubic-bezier(.45,.05,.25,1); filter: drop-shadow(0 3px 6px rgba(0,0,0,.45)); }
    .ad-ripple { position: absolute; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%; border: 3px solid #3db5a2; animation: ad-rip .6s ease-out forwards; }
    @keyframes ad-rip { from { transform: scale(.4); opacity: 1; } to { transform: scale(3.4); opacity: 0; } }
    .ad-spot { position: absolute; border-radius: 12px; box-shadow: 0 0 0 4px #3db5a2, 0 0 0 9999px rgba(5,7,10,.55); transition: all .5s ease; opacity: 0; }
    .ad-spot.on { opacity: 1; }
  \`;
  document.head.append(css);
  const layer = document.createElement('div');
  layer.className = 'ad-layer';
  const cursor = document.createElement('div');
  cursor.className = 'ad-cursor';
  cursor.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.4-3.6-6.8L4 20z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  layer.append(cursor);
  document.body.append(layer);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let pos = { x: -100, y: -100 };
  const el = target => typeof target === 'string' ? document.querySelector(target) : target;
  const center = node => { const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  window.__ad = {
    async card(opts) { await this.cardOn(opts); await sleep(opts.hold ?? 2500); await this.cardOff(); },
    async cardOn({ title, sub = '', chips = [], logo = true }) {
      const c = document.createElement('div');
      c.className = 'ad-card';
      c.innerHTML = (logo ? '<div class="ad-logo"><i></i><i></i><i></i><i></i></div>' : '') + '<h1></h1><p></p>' + (chips.length ? '<div class="ad-chips"></div>' : '');
      c.querySelector('h1').textContent = title;
      c.querySelector('p').textContent = sub;
      for (const t of chips) { const s = document.createElement('span'); s.textContent = t; c.querySelector('.ad-chips').append(s); }
      layer.prepend(c);
      this._card = c;
      await sleep(30); c.classList.add('on');
      await sleep(650);
      return true;
    },
    async cardOff() {
      const c = this._card;
      if (!c) return true;
      this._card = null;
      c.classList.remove('on'); await sleep(650); c.remove();
      return true;
    },
    async caption(title, sub = '', hold = 2600) {
      const c = document.createElement('div');
      c.className = 'ad-cap';
      c.innerHTML = '<div class="ad-bar"></div><div><strong></strong><span></span></div>';
      c.querySelector('strong').textContent = title;
      c.querySelector('span').textContent = sub;
      if (!sub) c.querySelector('span').remove();
      for (const old of layer.querySelectorAll('.ad-cap')) { old.classList.remove('on'); setTimeout(() => old.remove(), 500); }
      layer.append(c);
      await sleep(30); c.classList.add('on');
      if (hold > 0) { await sleep(hold); c.classList.remove('on'); await sleep(500); c.remove(); }
      return true;
    },
    clearCaption() { for (const c of layer.querySelectorAll('.ad-cap')) { c.classList.remove('on'); setTimeout(() => c.remove(), 500); } return true; },
    async moveTo(target, ms = 900) {
      const node = el(target);
      if (!node) throw new Error('no element ' + target);
      const p = center(node);
      cursor.style.transition = 'transform ' + ms + 'ms cubic-bezier(.45,.05,.25,1)';
      cursor.style.transform = 'translate(' + (p.x - 4) + 'px,' + (p.y - 2) + 'px)';
      pos = p;
      await sleep(ms + 60);
      return node;
    },
    async click(target, ms) {
      const node = await this.moveTo(target, ms);
      const r = document.createElement('div');
      r.className = 'ad-ripple';
      r.style.left = pos.x + 'px'; r.style.top = pos.y + 'px';
      layer.append(r); setTimeout(() => r.remove(), 700);
      await sleep(120);
      node.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      node.click();
      await sleep(250);
      return true;
    },
    async dblclick(target) {
      const node = await this.moveTo(target);
      node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: pos.x, clientY: pos.y }));
      await sleep(300);
      return true;
    },
    async type(target, text, cps = 22) {
      const node = await this.moveTo(target, 600);
      node.focus();
      node.value = '';
      for (const ch of text) { node.value += ch; node.dispatchEvent(new Event('input', { bubbles: true })); await sleep(1000 / cps); }
      return true;
    },
    async wheel(target, deltaY, times = 6) {
      const node = await this.moveTo(target, 600);
      for (let i = 0; i < times; i++) { node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, clientX: pos.x, clientY: pos.y })); await sleep(140); }
      return true;
    },
    async spot(target, hold = 2000, pad = 6) {
      const node = el(target);
      const r = node.getBoundingClientRect();
      const s = document.createElement('div');
      s.className = 'ad-spot';
      Object.assign(s.style, { left: (r.left - pad) + 'px', top: (r.top - pad) + 'px', width: (r.width + pad * 2) + 'px', height: (r.height + pad * 2) + 'px' });
      layer.prepend(s);
      await sleep(30); s.classList.add('on');
      await sleep(hold); s.classList.remove('on'); await sleep(500); s.remove();
      return true;
    },
    hideCursor() { cursor.style.transform = 'translate(-100px,-100px)'; return true; },
    byText(selector, text) { return [...document.querySelectorAll(selector)].find(n => n.textContent.trim().includes(text)); },
  };
  return true;
})()`;
