// Builds the version of Officina you can give to someone else.
//   node tools/release.js --win            Windows portable .exe
//   node tools/release.js --mac --arm64    macOS (Apple Silicon) .dmg and .zip; --x64 for Intel
// Output goes to dist-release/ (or RELEASE_OUT).
//
// What is different from `npm run dist`:
// - the main process (agents, browsers, trading, connectors) ships as V8 bytecode, not as
//   readable JavaScript;
// - the interface code and the preload script are obfuscated;
// - the build is locked: no DevTools, no debugging ports, no "Inspect element";
// - Electron fuses: no ELECTRON_RUN_AS_NODE, no NODE_OPTIONS, no --inspect, and the app
//   only loads from its own integrity-checked app.asar.
// Code that runs on someone's computer can never be made unreadable for a determined
// expert; this keeps it from being casually opened, read or changed.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(ROOT, 'build-app');
const OUT = process.env.RELEASE_OUT ? path.resolve(process.env.RELEASE_OUT) : path.join(ROOT, 'dist-release');
const args = process.argv.slice(2);
const target = args.includes('--mac') ? 'mac' : 'win';
const arch = args.includes('--x64') ? 'x64' : args.includes('--arm64') ? 'arm64' : process.arch;

const run = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', shell: process.platform === 'win32' && !path.isAbsolute(cmd), ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed (${r.status})`);
};
const copyDir = (from, to, skip = () => false) => {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (skip(a)) continue;
    if (e.isDirectory()) copyDir(a, b, skip); else fs.copyFileSync(a, b);
  }
};

// 1. A clean copy of what ships.
fs.rmSync(STAGE, { recursive: true, force: true });
copyDir(path.join(ROOT, 'main'), path.join(STAGE, 'main'));
copyDir(path.join(ROOT, 'renderer'), path.join(STAGE, 'renderer'));
fs.copyFileSync(path.join(ROOT, 'preload.js'), path.join(STAGE, 'preload.js'));

// 2. Main process to bytecode, compiled by this Electron (same V8 as at run time).
const electron = require('electron'); // the path of the Electron binary for this platform
const mainFiles = fs.readdirSync(path.join(STAGE, 'main')).filter(f => f.endsWith('.js')).map(f => path.join(STAGE, 'main', f));
run(electron, [path.join(__dirname, 'compile-bytecode.js'), ...mainFiles], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
fs.writeFileSync(path.join(STAGE, 'main', 'boot.js'), "'use strict';\n// Loads the compiled main process.\nrequire('bytenode');\nrequire('./main.jsc');\n");

// 3. Interface code and preload: obfuscated (they run in the page, where bytecode cannot be loaded).
const JavaScriptObfuscator = require('javascript-obfuscator');
const obfuscate = (file, sourceType) => {
  const code = fs.readFileSync(file, 'utf8');
  const out = JavaScriptObfuscator.obfuscate(code, {
    target: sourceType === 'module' ? 'browser' : 'node', sourceType, compact: true, simplify: true,
    identifierNamesGenerator: 'hexadecimal', renameGlobals: false, stringArray: true, stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75, splitStrings: false, controlFlowFlattening: false, deadCodeInjection: false, selfDefending: false,
    transformObjectKeys: false, numbersToExpressions: false, unicodeEscapeSequence: false, sourceMap: false,
  });
  fs.writeFileSync(file, out.getObfuscatedCode());
};
for (const f of fs.readdirSync(path.join(STAGE, 'renderer', 'js'))) if (f.endsWith('.js')) obfuscate(path.join(STAGE, 'renderer', 'js', f), 'module');
obfuscate(path.join(STAGE, 'preload.js'), 'script');

// 4. Package from the staged copy, locked and with the Electron fuses set.
const pkg = require(path.join(ROOT, 'package.json'));
const config = {
  ...pkg.build,
  files: [{ from: 'build-app', to: '.', filter: ['**/*'] }, 'package.json'],
  extraMetadata: { main: 'main/boot.js', officinaLocked: true },
  directories: { ...(pkg.build.directories || {}), output: OUT },
  electronFuses: {
    runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true,
  },
};
const cfgFile = path.join(ROOT, 'build-app.config.json');
fs.writeFileSync(cfgFile, JSON.stringify(config, null, 2));
try {
  const builder = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
  run(builder, ['--config', cfgFile, '--publish', 'never', ...(target === 'mac' ? ['--mac', 'dmg', 'zip', `--${arch}`] : ['--win', 'portable', '--x64'])], { cwd: ROOT, shell: process.platform === 'win32' });
} finally {
  fs.rmSync(cfgFile, { force: true });
}
console.log(`\nRelease build in ${OUT}`);
