'use strict';
// Notifications: Windows notifications, plus optional Telegram messages for
// when you're away from the computer. Each category can be switched off.
const { Notification } = require('electron');

const CATEGORIES = ['trades', 'tasks', 'attention', 'session'];

class Notifier {
  constructor({ ws, safeStorage, focusWindow, activity }) {
    this.ws = ws;
    this.safe = safeStorage;
    this.focusWindow = focusWindow;
    this.activity = activity;
  }

  get config() {
    const c = { desktop: true, telegram: false, chatId: '', categories: Object.fromEntries(CATEGORIES.map(k => [k, true])), ...(this.ws.settings.notify || {}) };
    c.categories = { ...Object.fromEntries(CATEGORIES.map(k => [k, true])), ...(c.categories || {}) };
    return c;
  }

  publicConfig() {
    const c = this.config;
    return { desktop: c.desktop, telegram: c.telegram, chatId: c.chatId, categories: c.categories, hasBotToken: !!c.botTokenEnc };
  }

  setConfig(patch) {
    const c = { ...(this.ws.settings.notify || {}) };
    for (const k of ['desktop', 'telegram', 'chatId']) if (patch[k] !== undefined) c[k] = patch[k];
    if (patch.categories) c.categories = { ...(c.categories || {}), ...patch.categories };
    if (typeof patch.botToken === 'string' && patch.botToken.trim()) {
      if (!this.safe.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable');
      c.botTokenEnc = this.safe.encryptString(patch.botToken.trim()).toString('base64');
    }
    this.ws.settings.notify = c;
    this.ws.saveSettings();
    return this.publicConfig();
  }

  botToken() {
    const enc = this.config.botTokenEnc;
    if (!enc) return '';
    if (enc.startsWith('plain:')) return enc.slice(6);
    try { return this.safe.decryptString(Buffer.from(enc, 'base64')); } catch { return ''; }
  }

  async send(category, title, body = '') {
    const c = this.config;
    if (c.categories[category] === false) return;
    // Linked Telegram and Discord chats (Connectors) get the same notifications.
    const viaConnectors = this.connectors ? await this.connectors.notify(title, body).catch(() => 0) : 0;
    if (c.desktop && Notification.isSupported()) {
      const n = new Notification({ title, body: String(body).slice(0, 250), silent: category === 'session' });
      n.on('click', () => this.focusWindow());
      n.show();
    }
    if (!viaConnectors && c.telegram && c.chatId && this.botToken()) {
      try {
        const response = await fetch(`https://api.telegram.org/bot${this.botToken()}/sendMessage`, {
          method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: c.chatId, text: `${title}\n${body}`.slice(0, 3500), disable_web_page_preview: true }),
        });
        if (!response.ok || !(await response.json()).ok) throw new Error('Telegram rejected the notification');
      } catch (e) {
        this.activity?.log('system', 'notify.failed', 'Telegram delivery failed');
      }
    }
  }

  async test() {
    await this.send('attention', 'Officina', 'Notifications are working.');
    return true;
  }
}

module.exports = { Notifier, CATEGORIES };
