// Generates media/icon.png (128x128) for the VS Code Marketplace listing.
// A white infinity mark (Nonstop's ♾️) on a Claude-coral rounded square.
// Pure Node (zlib only) — renders at a supersampled resolution for clean AA,
// then box-downsamples to 128x128. Re-run with: node scripts/generate-icon.js
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT = 128;          // final icon size
const SS = 4;             // supersampling factor
const R = OUT * SS;       // internal render resolution
const c = R / 2;          // center

// Claude-coral vertical gradient (top -> bottom)
const TOP = [232, 137, 107];
const BOT = [198, 93, 60];
const WHITE = [255, 255, 255];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

// Rounded-square signed distance (negative inside).
function roundedRectSDF(px, py) {
  const half = R / 2 - 1 * SS;     // 1px inset so corners aren't clipped
  const rad = 26 * SS;             // corner radius (~26px @128)
  const qx = Math.abs(px - c) - (half - rad);
  const qy = Math.abs(py - c) - (half - rad);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - rad;
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside;
}

// Pre-sample the lemniscate (figure-eight) curve once.
const A = 46 * SS;                 // horizontal half-extent of the ∞
const STROKE = 9 * SS;             // half stroke width
const N = 4000;
const curve = new Float64Array(N * 2);
for (let i = 0; i < N; i++) {
  const t = (2 * Math.PI * i) / N;
  const denom = 1 + Math.sin(t) * Math.sin(t);
  curve[i * 2] = c + (A * Math.cos(t)) / denom;
  curve[i * 2 + 1] = c + (A * Math.sin(t) * Math.cos(t)) / denom;
}
function infinityCoverage(px, py) {
  let best = Infinity;
  for (let i = 0; i < N; i++) {
    const dx = px - curve[i * 2];
    const dy = py - curve[i * 2 + 1];
    const d2 = dx * dx + dy * dy;
    if (d2 < best) best = d2;
  }
  const d = Math.sqrt(best);
  return clamp(STROKE - d + 0.5 * SS, 0, 1); // 1 = on the stroke
}

// Render the supersampled image as premultiplied RGBA.
const hi = new Float64Array(R * R * 4);
for (let y = 0; y < R; y++) {
  for (let x = 0; x < R; x++) {
    const sd = roundedRectSDF(x, y);
    const bgA = clamp(0.5 * SS - sd, 0, 1); // rounded-rect coverage
    const o = (y * R + x) * 4;
    if (bgA <= 0) continue;                 // transparent outside
    const g = clamp(y / R, 0, 1);
    const bg = mix(TOP, BOT, g);
    const inf = infinityCoverage(x, y) * bgA;
    const rgb = mix(bg, WHITE, inf);
    hi[o] = rgb[0] * bgA;                    // premultiplied
    hi[o + 1] = rgb[1] * bgA;
    hi[o + 2] = rgb[2] * bgA;
    hi[o + 3] = 255 * bgA;
  }
}

// Box-downsample SSxSS -> 1, then un-premultiply.
const raw = Buffer.alloc(OUT * OUT * 4);
for (let y = 0; y < OUT; y++) {
  for (let x = 0; x < OUT; x++) {
    let r = 0, gg = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const o = ((y * SS + sy) * R + (x * SS + sx)) * 4;
        r += hi[o]; gg += hi[o + 1]; b += hi[o + 2]; a += hi[o + 3];
      }
    }
    const n = SS * SS;
    a /= n;
    const aa = a > 0 ? a : 1;
    const o = (y * OUT + x) * 4;
    raw[o] = clamp(Math.round((r / n) / (aa / 255), 0), 0, 255);
    raw[o + 1] = clamp(Math.round((gg / n) / (aa / 255)), 0, 255);
    raw[o + 2] = clamp(Math.round((b / n) / (aa / 255)), 0, 255);
    raw[o + 3] = clamp(Math.round(a), 0, 255);
  }
}

// --- Minimal PNG encoder (RGBA, no filtering) ---
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT, 0);
ihdr.writeUInt32BE(OUT, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // RGBA
// scanlines with filter byte 0
const stride = OUT * 4;
const filtered = Buffer.alloc((stride + 1) * OUT);
for (let y = 0; y < OUT; y++) {
  filtered[y * (stride + 1)] = 0;
  raw.copy(filtered, y * (stride + 1) + 1, y * stride, y * stride + stride);
}
const idat = zlib.deflateSync(filtered, { level: 9 });
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = path.join(__dirname, '..', 'media');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'icon.png');
fs.writeFileSync(outPath, png);
console.log(`Wrote ${outPath} (${png.length} bytes, ${OUT}x${OUT})`);
