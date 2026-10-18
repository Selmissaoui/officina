'use strict';
// The few things that differ between Windows and macOS: unpacking downloads, reading the
// process list, and where a downloaded program keeps its executable.
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

// Unpacks a .zip or .tar.gz. macOS uses ditto for zips (keeps the symlinks and
// permissions an .app bundle needs); Windows uses its built-in tar.
function unpack(file, target) {
  return new Promise((resolve, reject) => {
    const done = e => (e ? reject(e) : resolve());
    if (isMac && /\.zip(\.part)?$/i.test(file)) return execFile('/usr/bin/ditto', ['-x', '-k', file, target], done);
    const tar = isWin ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
    execFile(tar, ['-xf', file, '-C', target], { windowsHide: true }, done);
  });
}

// Finds a file or folder by name below dir (downloads sometimes wrap everything in a folder).
function findBelow(dir, test, depth = 4) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) if (test(e)) return path.join(dir, e.name);
  if (depth <= 0) return null;
  for (const e of entries) {
    if (!e.isDirectory() || e.name.endsWith('.app')) continue;
    const hit = findBelow(path.join(dir, e.name), test, depth - 1);
    if (hit) return hit;
  }
  return null;
}

// Every process of the given program names: [{ ProcessId, ParentProcessId, WorkingSetSize, Name }].
function processList(names, cb) {
  if (isWin) {
    const filter = names.map(n => `Name='${n}.exe'`).join(' OR ');
    const cmd = `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name | ConvertTo-Json -Compress`;
    return execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 15000, maxBuffer: 4 << 20 }, (err, out) => {
      if (err) return cb(err);
      try { const j = JSON.parse(out || '[]'); cb(null, Array.isArray(j) ? j : [j]); } catch (e) { cb(e); }
    });
  }
  // ps reports the resident size in KiB; comm is the full path of the executable.
  execFile('/bin/ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], { timeout: 10000, maxBuffer: 8 << 20 }, (err, out) => {
    if (err) return cb(err);
    const rows = [];
    for (const line of String(out).split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      const base = path.basename(m[4]);
      const name = names.find(n => base === n || base.toLowerCase().startsWith(n.toLowerCase()) || m[4].includes(`${n}.app`));
      if (name || names.some(n => /brave/i.test(n) && /Brave Browser/.test(m[4]))) rows.push({ ProcessId: Number(m[1]), ParentProcessId: Number(m[2]), WorkingSetSize: Number(m[3]) * 1024, Name: /Brave/i.test(m[4]) ? 'brave' : (name || base) });
    }
    cb(null, rows);
  });
}

// The command line of one process, or '' when it is gone.
function commandLine(pid) {
  try {
    if (isWin) return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { windowsHide: true, timeout: 8000 }).toString();
    return execFileSync('/bin/ps', ['-o', 'command=', '-p', String(Number(pid))], { timeout: 5000 }).toString();
  } catch { return ''; }
}

module.exports = { isMac, isWin, unpack, findBelow, processList, commandLine };
