// The AI's visible cursor on the canvas. It is drawn in world coordinates (so
// it pans and zooms with the windows) but keeps a constant on-screen size.
// It never touches the user's real mouse; it only shows what the AI does.
import { h } from './ui.js';
import { prefs, isSimple, isGame } from './prefs.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function arrow() {
  const s = svg('svg', { viewBox: '0 0 24 24', width: '24', height: '24', class: 'ai-arrow' });
  s.append(svg('path', { d: 'M3 2 L3 19 L7.6 14.9 L10.6 21.6 L13.6 20.3 L10.7 13.7 L17 13.4 Z', 'stroke-linejoin': 'round' }));
  return s;
}

export function createAiCursor(canvas, opts = {}) {
  const layer = h('div', { class: 'ai-layer', 'aria-hidden': 'true' });
  if (opts.color) layer.style.setProperty('--ai', opts.color);
  const trails = svg('svg', { class: 'ai-trails', width: '1', height: '1' });
  const label = h('span', { class: 'ai-label' }, 'AI');
  const caption = h('span', { class: 'ai-caption' });
  const cursor = h('div', { class: 'ai-cursor' }, h('div', { class: 'ai-inner' }, arrow(), h('div', { class: 'ai-tags' }, label, caption)));
  layer.append(trails, cursor);
  canvas.world.append(layer);

  let pos = null;
  let raf = 0;
  let idleTimer = 0;
  let captionTimer = 0;

  const speedK = () => ({ fast: 0.6, normal: 1, slow: 1.8 }[prefs.cursor.speed] || 1);
  const place = p => { cursor.style.transform = `translate(${p.x}px, ${p.y}px)`; };

  function wake() {
    label.textContent = opts.label || (isSimple() ? 'AI' : isGame() ? 'COMPANION' : 'AI');
    cursor.classList.add('on');
    cursor.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => cursor.classList.add('idle'), 8000);
  }

  function say(text, ms = 2600) {
    if (!text || !prefs.cursor.captions) return;
    caption.textContent = text;
    caption.classList.add('on');
    clearTimeout(captionTimer);
    captionTimer = setTimeout(() => caption.classList.remove('on'), ms * speedK());
  }

  // Something attached to a world point that fades out by itself (ripples, chips, bubbles).
  function stamp(at, el, ms) {
    const holder = h('div', { class: 'ai-stamp', style: { transform: `translate(${at.x}px, ${at.y}px)` } }, h('div', { class: 'ai-inner' }, el));
    layer.append(holder);
    setTimeout(() => holder.remove(), ms);
    return holder;
  }

  function trail(a, b, ms) {
    if (!a || Math.hypot(b.x - a.x, b.y - a.y) < 4) return;
    const line = svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'ai-trail', 'vector-effect': 'non-scaling-stroke' });
    line.style.animationDuration = `${ms + 900}ms`;
    trails.append(line);
    setTimeout(() => line.remove(), ms + 950);
  }

  function move({ from, to, ms, caption: text, itemId, follow }) {
    const start = pos || from || to;
    pos = to;
    if (!prefs.cursor.show) return;
    wake();
    if (follow) canvas.ensureVisible(to, itemId);
    trail(start, to, ms);
    say(text, ms + 2200);
    cancelAnimationFrame(raf);
    const t0 = performance.now();
    const step = now => {
      const t = Math.min(1, (now - t0) / Math.max(1, ms));
      const e = ease(t);
      place({ x: start.x + (to.x - start.x) * e, y: start.y + (to.y - start.y) * e });
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  function click({ at, button = 'left', double = false }) {
    if (!prefs.cursor.show) return;
    wake();
    const p = at || pos;
    cursor.classList.remove('press'); void cursor.offsetWidth; cursor.classList.add('press');
    const ripple = () => stamp(p, h('span', { class: `ai-ripple ${button === 'right' ? 'right' : ''}` }), 900);
    ripple();
    if (double) setTimeout(ripple, 160);
  }

  function key({ label: k }) {
    if (!prefs.cursor.show) return;
    wake();
    stamp(pos, h('kbd', { class: 'ai-key' }, String(k).replace(/\bctrl\b/i, 'Ctrl').replace(/\bshift\b/i, 'Shift').replace(/\balt\b/i, 'Alt')), 1500 * speedK());
  }

  function type({ text }) {
    if (!prefs.cursor.show) return;
    wake();
    const tail = String(text || '');
    say(`Typing “${tail.length > 42 ? '…' + tail.slice(-42) : tail}”`, 2400);
  }

  function scroll({ dir }) {
    if (!prefs.cursor.show) return;
    wake();
    stamp(pos, h('span', { class: `ai-scroll ${dir === 'up' ? 'up' : 'down'}` }, dir === 'up' ? '︿' : '﹀'), 700);
  }

  function drag({ phase }) {
    if (!prefs.cursor.show) return;
    cursor.classList.toggle('dragging', phase === 'start');
  }

  // Shown even when the cursor itself is hidden: it is a message for the user.
  function point({ at, message }) {
    const p = at || pos;
    if (!p) return;
    if (prefs.cursor.show) { wake(); place(p); }
    else if (prefs.cursor.follow) canvas.ensureVisible(p);
    const k = speedK();
    stamp(p, h('div', { class: 'ai-bubble' }, h('span', { class: 'ai-bubble-who' }, opts.label || (isGame() ? 'Companion' : 'AI')), message), Math.max(5000, 60 * message.length) * k + 600);
    stamp(p, h('span', { class: 'ai-ripple point' }), 1400);
  }

  function hide() {
    cancelAnimationFrame(raf);
    cursor.classList.remove('on');
    caption.classList.remove('on');
  }

  function handle(e) {
    if (e.kind === 'move') move(e);
    else if (e.kind === 'click') click(e);
    else if (e.kind === 'key') key(e);
    else if (e.kind === 'type') type(e);
    else if (e.kind === 'scroll') scroll(e);
    else if (e.kind === 'drag') drag(e);
    else if (e.kind === 'point') point(e);
    else if (e.kind === 'hide') hide();
  }

  function applyPrefs() {
    if (!prefs.cursor.show) hide();
    layer.classList.toggle('no-captions', !prefs.cursor.captions);
  }

  function restyle({ color, name }) {
    if (color) layer.style.setProperty('--ai', color);
    if (name) opts.label = name;
  }

  return { handle, applyPrefs, hide, restyle };
}

// One cursor per agent: the first keeps the theme colour, later agents get
// their own colour and their client name as label.
const AGENT_COLORS = ['#d9480f', '#7048e8', '#1971c2', '#c2255c', '#2f9e44', '#f08c00'];
export function createCursorManager(canvas) {
  const cursors = new Map();
  const get = agent => {
    const id = agent?.id || 'agent';
    if (!cursors.has(id)) {
      const n = cursors.size;
      cursors.set(id, createAiCursor(canvas, { color: agent?.color || AGENT_COLORS[n % AGENT_COLORS.length], label: agent?.label && agent.label !== 'Agent' ? agent.label : undefined }));
    }
    return cursors.get(id);
  };
  return {
    handle(e) {
      if (e.kind === 'hide') { for (const c of cursors.values()) c.hide(); return; }
      const c = get(e.agent);
      if (e.agent?.color) c.restyle({ color: e.agent.color, name: e.agent.label !== 'Agent' ? e.agent.label : null });
      c.handle(e);
    },
    applyPrefs() { for (const c of cursors.values()) c.applyPrefs(); },
    hide() { for (const c of cursors.values()) c.hide(); },
    count: () => cursors.size,
  };
}

// Draws numbered boxes over a screenshot for vision models (called from the
// main process through executeJavaScript). Boxes are in the image's pixels.
window.__acAnnotate = async (dataUrl, boxes) => {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const colors = ['#e5484d', '#0d74ce', '#2b9a66', '#ab4aba', '#d6409f', '#c2410c', '#0e7490'];
  g.font = 'bold 12px "Segoe UI", sans-serif';
  g.textBaseline = 'top';
  for (const b of boxes) {
    const col = colors[b.i % colors.length];
    g.strokeStyle = col;
    g.lineWidth = 2;
    g.strokeRect(b.x + 0.5, b.y + 0.5, Math.max(4, b.w - 1), Math.max(4, b.h - 1));
    const label = String(b.i);
    const w = g.measureText(label).width + 8;
    const lx = Math.max(0, Math.min(c.width - w, b.x - 1));
    const ly = b.y >= 16 ? b.y - 16 : b.y;
    g.fillStyle = col;
    g.fillRect(lx, ly, w, 16);
    g.fillStyle = '#fff';
    g.fillText(label, lx + 4, ly + 2);
  }
  return c.toDataURL('image/png');
};
