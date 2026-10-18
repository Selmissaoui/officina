// Draws the app icon as a PNG without any image library. Default 256 px; --size=1024 for macOS.
// Run: node tools/make-icon.js build/icon.png   or   node tools/make-icon.js --size=1024 build/icon-1024.png
const fs = require('fs');
const zlib = require('zlib');
const S = Number((process.argv.find(a => a.startsWith('--size=')) || '--size=256').slice(7));
const K = S / 256; // the design is drawn in 256 units
const px = Buffer.alloc(S * S * 4);
const mix = (a, b, t) => a + (b - a) * t;
function roundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const i = (y * S + x) * 4;
  let c = [0, 0, 0, 0];
  const ux = (x + .5) / K, uy = (y + .5) / K;
  if (roundRect(ux, uy, 8, 8, 248, 248, 56)) {
    const t = (x + y) / (2 * S);
    c = [mix(124, 179, t), mix(156, 140, t), 255, 255];
    if (roundRect(ux, uy, 40, 40, 216, 216, 34)) c = [16, 18, 24, 255];
    const tiles = [[62, 62, 122, 140, [124, 156, 255]], [134, 62, 194, 108, [179, 140, 255]], [134, 120, 194, 194, [61, 220, 151]], [62, 152, 122, 194, [245, 207, 90]]];
    for (const [a, b, cc, d, col] of tiles) if (roundRect(ux, uy, a, b, cc, d, 10)) c = [...col, 255];
  }
  px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
}
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
for (const out of process.argv.slice(2).filter(a => !a.startsWith('--'))) fs.writeFileSync(out, png);
