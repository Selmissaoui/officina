'use strict';
// Peek: a quick look at what an agent is doing. A screenshot of the window the agent last
// acted in (or of the whole canvas when it has none), or a short clip of it. Used by the
// Peek button on agent cards and by /peek in Telegram and Discord. The clip is encoded in
// the renderer (MediaRecorder), which asks for frames here a few times a second.
const MAX_CLIP = 20;
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Peek {
  constructor({ ws, agents, browsers, getWindow, send }) {
    Object.assign(this, { ws, agents, browsers, getWindow, send });
    this.pending = new Map(); // clip request id -> { resolve, reject, timer }
    this.seq = 0;
  }

  // The window an agent last acted in, if it is still on the canvas.
  target(agentName) {
    const id = agentName ? this.agents.live.get(agentName)?.itemId : null;
    const it = id ? this.ws.getItem(id) : null;
    return it ? { id: it.id, title: it.title || it.url || it.type, type: it.type } : null;
  }

  // One JPEG frame: the browser page itself when the item is a browser, else the canvas.
  async frame(itemId, { maxWidth = 1280, quality = 80 } = {}) {
    let img = null;
    if (itemId && this.ws.getItem(itemId)?.type === 'browser') {
      try { img = await Promise.race([this.browsers.wc(itemId).capturePage(), sleep(4000).then(() => null)]); } catch { /* fall back to the canvas */ }
    }
    if (!img || img.isEmpty()) {
      const win = this.getWindow();
      if (win) img = await Promise.race([win.webContents.capturePage(), sleep(4000).then(() => null)]);
      if (!img || img.isEmpty()) throw new Error('Officina is minimised, so there is no picture of the canvas. A browser the agent works in can still be seen.');
    }
    if (img.getSize().width > maxWidth) img = img.resize({ width: maxWidth, quality: 'good' });
    return img.toJPEG(quality);
  }

  caption(agentName) {
    const t = this.target(agentName);
    const busy = this.agents.live.get(agentName)?.lastAction;
    return `${agentName}${t ? ` in "${String(t.title).slice(0, 80)}"` : ' (canvas)'}${busy ? `, last step: ${busy}` : ''}`;
  }

  async shot(agentName) {
    return { buf: await this.frame(this.target(agentName)?.id), caption: this.caption(agentName) };
  }

  // A clip of `seconds` (1..20): the renderer records it and answers through done().
  clip(agentName, seconds = 8) {
    const secs = Math.max(1, Math.min(MAX_CLIP, Math.round(Number(seconds) || 8)));
    const id = `peek${++this.seq}`;
    const itemId = this.target(agentName)?.id || null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('The recording did not finish.')); }, (secs + 20) * 1000);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.getWindow()) { clearTimeout(timer); this.pending.delete(id); return reject(new Error('Officina has no window open.')); }
      this.send('peek:record', id, itemId, secs);
    }).then(r => ({ ...r, caption: `${this.caption(agentName)} (${secs} s)` }));
  }

  done(id, bytes, mime, error) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (error || !bytes?.length) p.reject(new Error(error || 'The recording is empty.'));
    else p.resolve({ buf: Buffer.from(bytes), mime: String(mime || 'video/webm') });
    return true;
  }
}

module.exports = { Peek, MAX_CLIP };
