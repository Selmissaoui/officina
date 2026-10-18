'use strict';
// Small JSON/file helpers. Writes go through a temp file + rename so a crash
// mid-write never leaves a half-written state file behind.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function writeJson(file, value) {
  writeAtomic(file, JSON.stringify(value, null, 2));
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + '\n');
}

function readJsonl(file, limit = Infinity) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip corrupt line */
    }
  }
  return limit === Infinity ? out : out.slice(-limit);
}

function newId(prefix = '') {
  return prefix + crypto.randomBytes(5).toString('hex');
}

module.exports = { readJson, writeJson, writeAtomic, appendJsonl, readJsonl, newId };
