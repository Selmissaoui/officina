'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
let failed = false;
for (const [dir, type] of [['renderer/js', 'module'], ['main', 'commonjs'], ['tools', 'commonjs'], ['test', 'commonjs'], ['', 'commonjs']]) {
  for (const name of fs.readdirSync(path.join(root, dir)).filter(name => name.endsWith('.js'))) {
    const file = path.join(dir, name);
    // Explicit module mode avoids Node's ambiguous .js syntax detection.
    const result = spawnSync(process.execPath, ['--check', `--input-type=${type}`], {
      input: fs.readFileSync(path.join(root, file)), encoding: 'utf8',
    });
    if (result.status !== 0) {
      console.error(`${file}:\n${result.stderr || result.error}`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log('JavaScript syntax checks passed.');
