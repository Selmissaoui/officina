'use strict';
// Encrypted API-key vault. Secrets are encrypted with the OS keystore
// (DPAPI on Windows via Electron safeStorage) and never leave the main
// process: the UI only ever sees masked values, and agents never see exchange
// secrets at all. They trade through the app, which signs requests itself.
const fs = require('fs');
const path = require('path');
const { newId, writeAtomic } = require('./store');

const SECRET_FIELDS = ['apiKey', 'secret', 'password', 'value', 'privateKey'];

function mask(v) {
  if (!v) return '';
  return v.length <= 6 ? '••••' : `••••${v.slice(-4)}`;
}

class KeyStore {
  constructor(secretsDir, safeStorage) {
    this.file = path.join(secretsDir, 'keys.bin');
    this.safe = safeStorage;
    this.entries = this._load();
  }

  get encrypted() {
    return this.safe.isEncryptionAvailable();
  }

  _load() {
    if (!fs.existsSync(this.file)) return [];
    try {
      const buf = fs.readFileSync(this.file);
      const json = buf.subarray(0, 5).toString() === 'PLAIN' ? buf.subarray(5).toString('utf8') : this.safe.decryptString(buf);
      return JSON.parse(json);
    } catch (e) {
      console.error('Could not read key store:', e.message);
      return [];
    }
  }

  _save() {
    const json = JSON.stringify(this.entries);
    const data = this.encrypted ? this.safe.encryptString(json) : Buffer.concat([Buffer.from('PLAIN'), Buffer.from(json)]);
    writeAtomic(this.file, data);
  }

  // Safe view for the UI / agents.
  list() {
    return this.entries.map(e => {
      const out = { ...e };
      for (const f of SECRET_FIELDS) {
        out[`${f}Masked`] = mask(e[f]);
        out[`has_${f}`] = !!e[f];
        delete out[f];
      }
      return out;
    });
  }

  get(id) {
    return this.entries.find(e => e.id === id) || null;
  }

  upsert(input) {
    const existing = input.id ? this.get(input.id) : null;
    const entry = existing || { id: newId('k'), createdAt: new Date().toISOString(), linkedBrowsers: [] };
    for (const k of ['label', 'kind', 'exchange', 'sandbox', 'agentReadable', 'linkedBrowsers', 'uid', 'walletAddress', 'notes']) {
      if (input[k] !== undefined) entry[k] = input[k];
    }
    // Blank secret fields on edit mean "keep the stored value".
    for (const f of SECRET_FIELDS) {
      if (typeof input[f] === 'string' && input[f].trim() !== '') entry[f] = input[f].trim();
    }
    entry.kind ||= 'exchange';
    entry.label ||= entry.kind === 'exchange' ? (entry.exchange || 'Exchange') : 'API key';
    entry.updatedAt = new Date().toISOString();
    if (!existing) this.entries.push(entry);
    this._save();
    return entry;
  }

  remove(id) {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.id !== id);
    if (this.entries.length !== before) this._save();
    return before !== this.entries.length;
  }

  clear() {
    this.entries = [];
    fs.rmSync(this.file, { force: true });
  }

  linkedTo(browserId) {
    return this.entries.filter(e => (e.linkedBrowsers || []).includes(browserId));
  }

  // A browser can be linked to keys from both sides; drop links to browsers that no longer exist.
  pruneLinks(validIds) {
    let changed = false;
    for (const e of this.entries) {
      const next = (e.linkedBrowsers || []).filter(id => validIds.has(id));
      if (next.length !== (e.linkedBrowsers || []).length) { e.linkedBrowsers = next; changed = true; }
    }
    if (changed) this._save();
  }
}

module.exports = { KeyStore, mask };
