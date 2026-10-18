// Infinite canvas: pan/zoom transform plus the set of item views.
import { createItemView } from './items.js';
import { debounce } from './ui.js';

const MIN = 0.1, MAX = 2.5;

export class Canvas {
  constructor({ viewport, world, onChange, onBackground = {} }) {
    this.viewport = viewport;
    this.world = world;
    this.onChange = onChange;
    this.onBackground = onBackground;
    this.v = { x: 0, y: 0, scale: 1 };
    this.views = new Map();
    this.persist = debounce(() => {
      const r = this.viewport.getBoundingClientRect();
      window.ac.setViewport({ ...this.v, viewW: r.width, viewH: r.height });
    }, 300);
    this._bindPanZoom();
  }

  set(v, { persist = true } = {}) {
    this.v = { x: v.x, y: v.y, scale: Math.min(MAX, Math.max(MIN, v.scale)) };
    this.world.style.transform = `translate(${this.v.x}px, ${this.v.y}px) scale(${this.v.scale})`;
    // While the view moves, the world is one GPU layer (smooth). Once it rests, that hint goes,
    // so Chromium draws text and pages sharp at the new scale instead of stretching a bitmap.
    this.world.classList.add('zooming');
    clearTimeout(this._settle);
    this._settle = setTimeout(() => this.world.classList.remove('zooming'), 180);
    this.world.style.setProperty('--inv', 1 / this.v.scale);
    const g = 24 * this.v.scale;
    this.viewport.style.backgroundSize = `${g}px ${g}px`;
    this.viewport.style.backgroundPosition = `${this.v.x}px ${this.v.y}px`;
    this.viewport.classList.toggle('far', this.v.scale < 0.35);
    if (persist) this.persist();
    this.onChange?.(this.v);
  }

  toWorld(clientX, clientY) {
    const r = this.viewport.getBoundingClientRect();
    return { x: (clientX - r.left - this.v.x) / this.v.scale, y: (clientY - r.top - this.v.y) / this.v.scale };
  }

  zoomAt(clientX, clientY, factor) {
    const r = this.viewport.getBoundingClientRect();
    const px = clientX - r.left, py = clientY - r.top;
    const scale = Math.min(MAX, Math.max(MIN, this.v.scale * factor));
    const k = scale / this.v.scale;
    this.set({ x: px - (px - this.v.x) * k, y: py - (py - this.v.y) * k, scale });
  }

  zoomCenter(factor) {
    const r = this.viewport.getBoundingClientRect();
    this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  }

  animateTo(target, ms = 280) {
    const from = { ...this.v };
    const t0 = performance.now();
    const ease = t => 1 - Math.pow(1 - t, 3);
    const step = now => {
      const t = Math.min(1, (now - t0) / ms), e = ease(t);
      this.set({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, scale: from.scale + (target.scale - from.scale) * e }, { persist: t === 1 });
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  frameRect(rect, maxScale = 1) {
    const r = this.viewport.getBoundingClientRect();
    const pad = 60;
    const scale = Math.min(maxScale, (r.width - pad * 2) / rect.w, (r.height - pad * 2) / rect.h);
    const s = Math.min(MAX, Math.max(MIN, scale));
    return { scale: s, x: r.width / 2 - (rect.x + rect.w / 2) * s, y: r.height / 2 - (rect.y + rect.h / 2) * s };
  }

  focus(id) {
    const view = this.views.get(id);
    if (!view) return;
    const it = view.item;
    this.animateTo(this.frameRect({ x: it.x, y: it.y, w: it.w, h: it.h }, 1));
    view.flash?.();
  }

  fitAll() {
    const items = [...this.views.values()].map(v => v.item);
    if (!items.length) return this.animateTo({ x: 0, y: 0, scale: 1 });
    const x1 = Math.min(...items.map(i => i.x)), y1 = Math.min(...items.map(i => i.y));
    const x2 = Math.max(...items.map(i => i.x + i.w)), y2 = Math.max(...items.map(i => i.y + i.h));
    this.animateTo(this.frameRect({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, 1));
  }

  // Pan (without zooming, unless zoomed far out) so a world point is on screen.
  ensureVisible(pt, itemId) {
    const r = this.viewport.getBoundingClientRect();
    const sx = pt.x * this.v.scale + this.v.x, sy = pt.y * this.v.scale + this.v.y;
    const m = 90;
    if (sx > m && sy > m && sx < r.width - m && sy < r.height - m) return;
    const it = itemId && this.views.get(itemId)?.item;
    if (this.v.scale < 0.3 && it) return this.animateTo(this.frameRect({ x: it.x, y: it.y, w: it.w, h: it.h }, 1), 420);
    this.animateTo({ scale: this.v.scale, x: r.width / 2 - pt.x * this.v.scale, y: r.height / 2 - pt.y * this.v.scale }, 420);
  }

  center() {
    const r = this.viewport.getBoundingClientRect();
    return this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }

  upsert(item, ctx) {
    const existing = this.views.get(item.id);
    if (existing) { existing.update(item); return existing; }
    const view = createItemView(item, { ...ctx, canvas: this });
    this.views.set(item.id, view);
    this.world.append(view.el);
    return view;
  }

  remove(id) {
    const v = this.views.get(id);
    if (!v) return;
    v.destroy?.();
    v.el.remove();
    this.views.delete(id);
  }

  _bindPanZoom() {
    const vp = this.viewport;
    vp.addEventListener('pointerdown', e => {
      const onBackground = e.target === vp || e.target === this.world;
      if (!(onBackground && (e.button === 0 || e.button === 1)) && e.button !== 1) return;
      e.preventDefault();
      if (onBackground && e.button === 0) this.onBackground.click?.();
      document.activeElement?.blur?.();
      const start = { x: e.clientX, y: e.clientY, vx: this.v.x, vy: this.v.y };
      vp.setPointerCapture(e.pointerId);
      document.body.classList.add('dragging', 'panning');
      const move = ev => this.set({ x: start.vx + ev.clientX - start.x, y: start.vy + ev.clientY - start.y, scale: this.v.scale });
      const up = () => {
        vp.removeEventListener('pointermove', move);
        vp.removeEventListener('pointerup', up);
        vp.removeEventListener('pointercancel', up);
        document.body.classList.remove('dragging', 'panning');
      };
      vp.addEventListener('pointermove', move);
      vp.addEventListener('pointerup', up);
      vp.addEventListener('pointercancel', up);
    });

    const isBg = e => e.target === vp || e.target === this.world;
    vp.addEventListener('dblclick', e => { if (isBg(e)) this.onBackground.dblclick?.(this.toWorld(e.clientX, e.clientY)); });
    vp.addEventListener('contextmenu', e => {
      if (!isBg(e)) return;
      e.preventDefault();
      this.onBackground.menu?.(e.clientX, e.clientY, this.toWorld(e.clientX, e.clientY));
    });

    vp.addEventListener('wheel', e => {
      // Inside scrollable item content a plain wheel scrolls it; Ctrl+wheel (and pinch) always zooms.
      const scroller = e.target.closest?.('.scrollable');
      if (scroller && !e.ctrlKey && scroller.scrollHeight > scroller.clientHeight) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      this.zoomAt(e.clientX, e.clientY, factor);
    }, { passive: false });
  }
}
