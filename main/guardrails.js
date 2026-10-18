'use strict';
const { newId } = require('./store');
class Handoffs {
  constructor({ send, notify, focus }) { Object.assign(this, { send, notify, focus }); this.pending = new Map(); }
  list() { return [...this.pending.values()].map(({ resolve, timer, ...entry }) => entry); }
  ask({ id: browserId, message }) {
    if (!String(message || '').trim()) throw new Error('A message is required');
    if (this.pending.size >= 20) throw new Error('Too many pending requests');
    const id = newId('ask');
    return new Promise(resolve => {
      const timer = setTimeout(() => this.answer(id, false), 30 * 60 * 1000);
      timer.unref?.();
      this.pending.set(id, { id, browserId, message: String(message).slice(0, 2000), createdAt: new Date().toISOString(), resolve, timer });
      this.send('handoff:changed', this.list());
      this.notify('attention', 'AI needs you', message);
      if (browserId) this.focus(browserId);
    });
  }
  answer(id, accepted) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer); this.pending.delete(id);
    entry.resolve({ accepted: accepted === true, message: accepted === true ? 'User completed the requested action. Read the page again.' : 'User declined or request expired. Do not continue this action.' });
    this.send('handoff:changed', this.list()); return true;
  }
  cancelAll() { for (const id of this.pending.keys()) this.answer(id, false); }
  owns(browserId) { return [...this.pending.values()].some(e => e.browserId === browserId); }
}
function rulesFor(ws, id) { return { mode: 'act', sites: [], confirm: false, ...(ws.settings.browserRules?.[ws.getItem(id)?.profile || id] || {}) }; }
function allowedSite(url, sites) {
  if (!sites?.length) return true;
  try { const host = new URL(url).hostname.toLowerCase(); return sites.some(s => host === s.toLowerCase()); } catch { return false; }
}
const HANDS_ON = ['click', 'type', 'key', 'drag', 'fill', 'upload', 'dialog', 'hover', 'select'];
class BrowserGuard {
  constructor({ ws, browsers, handoffs, isPaused }) { Object.assign(this, { ws, browsers, handoffs, isPaused }); }
  async check(id, action, args = {}) {
    if (this.isPaused()) throw new Error('The user pressed STOP');
    if (this.handoffs.owns(id)) throw new Error('The user currently controls this browser');
    // The person solves bot checks, never the agent. Reading, waiting or going to
    // another site stays allowed; touching the page does not.
    if (HANDS_ON.includes(action) && this.browsers.botChecks?.get(id)) {
      const kind = await this.browsers.botCheck(id); // the user may have solved it in the meantime
      if (kind) throw new Error(`${kind} on this page. Only the user may complete it: call ask_user, or go to another site.`);
    }
    const r = rulesFor(this.ws, id);
    const readOnly = ['read', 'find', 'links', 'screenshot', 'waitFor', 'point', 'frames', 'logs'].includes(action);
    if (r.mode === 'none' || (!readOnly && r.mode === 'read')) throw new Error('Browser access rules block this action');
    const url = this.browsers.wc(id).getURL();
    if (!allowedSite(url, r.sites)) throw new Error('This site is outside the browser allowlist');
    if (action === 'navigate' && !['back', 'forward', 'reload'].includes(args.url)) {
      const target = /^[a-z]+:/i.test(args.url) ? args.url : 'https://' + args.url;
      if (!allowedSite(target, r.sites)) throw new Error('Destination is outside the browser allowlist');
    }
    // A conservative action confirmation also covers JS-driven forms and custom submit buttons.
    if (r.confirm && ['click', 'type', 'key', 'drag', 'fill', 'upload', 'dialog'].includes(action)) {
      const result = await this.handoffs.ask({ id, message: 'Allow the AI to ' + action + ' on ' + url + '?' });
      if (!result.accepted || this.isPaused()) throw new Error('Action not approved or stopped');
      const current = rulesFor(this.ws, id);
      if (current.mode !== 'act' || !allowedSite(this.browsers.wc(id).getURL(), current.sites)) throw new Error('Browser rules changed');
    }
  }
}
module.exports = { Handoffs, BrowserGuard, rulesFor, allowedSite };
