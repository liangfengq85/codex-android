// 生成 CodeX 的 PWA 图标（纯 Node 手写 PNG，零三方依赖）
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const OUT = __dirname;

// ---- CRC32 ----
const crcTable = (function () {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function makePNG(size, draw) {
  const w = size, h = size;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = draw(x, y, w, h);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 在圆角矩形内填充（用于背景）
function roundedBg(size, bg, radius) {
  return function (x, y) {
    const r = radius;
    let inside = true;
    if (x < r && y < r) inside = ((x - r) ** 2 + (y - r) ** 2) <= r * r;
    else if (x > size - r && y < r) inside = ((x - (size - r)) ** 2 + (y - r) ** 2) <= r * r;
    else if (x < r && y > size - r) inside = ((x - r) ** 2 + (y - (size - r)) ** 2) <= r * r;
    else if (x > size - r && y > size - r) inside = ((x - (size - r)) ** 2 + (y - (size - r)) ** 2) <= r * r;
    else inside = (x >= 0 && x < size && y >= 0 && y < size);
    if (!inside) return [0, 0, 0, 0];
    return bg;
  };
}
// 点是否在多边形内（归一化坐标）
function inPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
// 闪电多边形（归一化 0..1）
const BOLT = [[0.52, 0.04], [0.20, 0.56], [0.44, 0.56], [0.36, 0.98], [0.82, 0.40], [0.54, 0.40]];
const BOLT_COLOR = [255, 208, 0, 255];

function drawIcon(size, fullBleed) {
  const bg = fullBleed ? [30, 30, 30, 255] : [14, 99, 156, 255];
  const radius = fullBleed ? 0 : size * 0.18;
  const base = roundedBg(size, bg, radius);
  const scale = fullBleed ? 0.62 : 0.92; // maskable 留安全区
  const cx = (1 - scale) / 2, cy = (1 - scale) / 2;
  return function (x, y) {
    const px = x / size, py = y / size;
    let c = base(x, y);
    // 缩放+平移闪电
    const lx = (px - cx) / scale, ly = (py - cy) / scale;
    if (lx >= 0 && lx <= 1 && ly >= 0 && ly <= 1 && inPoly(lx, ly, BOLT)) c = BOLT_COLOR;
    return c;
  };
}

fs.writeFileSync(path.join(OUT, 'icon-192.png'), makePNG(192, drawIcon(192, false)));
fs.writeFileSync(path.join(OUT, 'icon-512.png'), makePNG(512, drawIcon(512, false)));
fs.writeFileSync(path.join(OUT, 'maskable-512.png'), makePNG(512, drawIcon(512, true)));
console.log('icons generated');
