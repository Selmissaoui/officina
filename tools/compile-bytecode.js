// Compiles main-process files to V8 bytecode (.jsc) and removes the .js source.
// Must run inside Electron (ELECTRON_RUN_AS_NODE=1), so the bytecode matches the V8 that
// will load it. Called by tools/release.js.
const fs = require('fs');
const bytenode = require('bytenode');

(async () => {
  for (const filename of process.argv.slice(2)) {
    await bytenode.compileFile({ filename, output: filename.replace(/\.js$/, '.jsc'), compileAsModule: true });
    fs.rmSync(filename);
  }
  console.log(`compiled ${process.argv.length - 2} files to bytecode`);
})().catch(e => { console.error(e); process.exit(1); });
