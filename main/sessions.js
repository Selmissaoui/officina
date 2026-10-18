'use strict';
// Keeps browser logins alive across app restarts.
// Persistent cookies already survive (each browser profile is a persist:
// partition on disk). Many sites, exchanges especially, log in with *session*
// cookies, which Chromium drops on exit. Like Chrome's "continue where you
// left off", we snapshot those (encrypted with the OS keystore) and put them
// back on start. The site's own server-side expiry still applies.
const fs = require('fs');
const path = require('path');
const { session } = require('electron');
const { writeAtomic } = require('./store');

const partitionFor = profile => `persist:ac-${profile}`;

class SessionKeeper {
  constructor(secretsDir, safeStorage, getProfiles) {
    this.file = path.join(secretsDir, 'session-cookies.bin');
    this.safe = safeStorage;
    this.getProfiles = getProfiles;
    this.timer = null;
  }

  _read() {
    if (!fs.existsSync(this.file)) return {};
    try {
      const buf = fs.readFileSync(this.file);
      return JSON.parse(buf.subarray(0, 5).toString() === 'PLAIN' ? buf.subarray(5).toString('utf8') : this.safe.decryptString(buf));
    } catch {
      return {};
    }
  }

  async restore() {
    const saved = this._read();
    let count = 0;
    for (const [profile, cookies] of Object.entries(saved)) {
      const ses = session.fromPartition(partitionFor(profile));
      for (const c of cookies) {
        const host = c.domain.replace(/^\./, '');
        const details = { url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`, name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite };
        if (!c.hostOnly) details.domain = c.domain;
        try { await ses.cookies.set(details); count++; } catch { /* expired/invalid cookie */ }
      }
    }
    return count;
  }

  async snapshot() {
    const out = {};
    for (const profile of this.getProfiles()) {
      const ses = session.fromPartition(partitionFor(profile));
      try {
        const all = await ses.cookies.get({});
        const sessionOnly = all.filter(c => c.session);
        if (sessionOnly.length) out[profile] = sessionOnly;
        await ses.cookies.flushStore();
      } catch { /* profile not loaded */ }
    }
    const json = JSON.stringify(out);
    const data = this.safe.isEncryptionAvailable() ? this.safe.encryptString(json) : Buffer.concat([Buffer.from('PLAIN'), Buffer.from(json)]);
    writeAtomic(this.file, data);
    return Object.values(out).reduce((s, l) => s + l.length, 0);
  }

  start(intervalMs = 30000) {
    this.timer = setInterval(() => this.snapshot().catch(() => {}), intervalMs);
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = { SessionKeeper, partitionFor };
