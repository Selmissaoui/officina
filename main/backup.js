'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { writeAtomic } = require('./store');
const MAGIC = Buffer.from('ACBACKUP2');
function pack(root, password) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('Use a backup password of at least 12 characters');
  const entries = []; let bytes = 0;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Cannot back up symbolic links');
      const abs = path.join(dir, entry.name), name = path.relative(root, abs).split(path.sep).join('/');
      // Cache and active Chromium locks can be recreated; saved profiles and cookies are retained.
      if (/^(chromium\/.*\/)?(Cache|Code Cache|GPUCache|Crashpad)(\/|$)/i.test(name) || /(^|\/)(Singleton\w*|LOCK|lockfile)$/.test(name)) continue;
      if (entry.isDirectory()) walk(abs);
      else { const data = fs.readFileSync(abs); bytes += data.length; if (bytes > 512 * 1024 * 1024) throw new Error('Workspace exceeds the 512 MB backup limit'); entries.push({ name, data: data.toString('base64') }); }
    }
  }
  walk(root);
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const zipped = zlib.gzipSync(Buffer.from(JSON.stringify({ version: 2, entries })));
  const encrypted = Buffer.concat([cipher.update(zipped), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), encrypted]);
}
function unpack(buffer, password, destination) {
  if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an Officina backup');
  const n = MAGIC.length;
  const key = crypto.scryptSync(password, buffer.subarray(n, n + 16), 32);
  let archive;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(n + 16, n + 28));
    decipher.setAuthTag(buffer.subarray(n + 28, n + 44));
    const raw = Buffer.concat([decipher.update(buffer.subarray(n + 44)), decipher.final()]);
    archive = JSON.parse(zlib.gunzipSync(raw, { maxOutputLength: 750 * 1024 * 1024 }));
  } catch { throw new Error('Incorrect password or damaged backup'); }
  if (archive.version !== 2 || !Array.isArray(archive.entries) || archive.entries.length > 100000) throw new Error('Invalid archive');
  const names = new Set();
  for (const e of archive.entries) {
    if (typeof e.name !== 'string' || typeof e.data !== 'string' || !e.name || e.name.includes('\\') || e.name.includes(':') || e.name.startsWith('/') || e.name.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p)) || names.has(e.name.toLowerCase())) throw new Error('Unsafe archive path');
    names.add(e.name.toLowerCase());
  }
  if (fs.existsSync(destination)) throw new Error('Restore destination must be new');
  fs.mkdirSync(destination, { recursive: true });
  for (const e of archive.entries) writeAtomic(path.join(destination, e.name), Buffer.from(e.data, 'base64'));
  return destination;
}
module.exports = { pack, unpack };
