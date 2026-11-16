// Rasterizes the app icon (same shapes as public/icon.svg) to PNG with no dependencies.
// Usage: node tools/make-icons.mjs
import fs from "node:fs";
import zlib from "node:zlib";

const ACCENT = [0x2f, 0x6f, 0x60], CLAY = [0xd3, 0xbd, 0x98], GLAZE = [0xe8, 0xf1, 0xee];

function inRoundRect(x, y, x0, y0, w, h, r) {
  if (x < x0 || y < y0 || x > x0 + w || y > y0 + h) return false;
  const cx = Math.min(Math.max(x, x0 + r), x0 + w - r), cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
// Colour of a point in the 512-unit design space.
function shade(x, y) {
  if (!inRoundRect(x, y, 0, 0, 512, 512, 112)) return null;
  const tx = x - 166, ty = y - 96;
  if (inRoundRect(tx, ty, 0, 0, 180, 240, 18)) {
    if ((tx - 90) ** 2 + (ty - 33) ** 2 <= 169) return ACCENT;
    const edge = 132 + 4.5 * (1 - Math.cos((tx / 45) * Math.PI)) / 2;
    const drip = (tx > 33 && tx < 54 && ty < 132 + 42 * Math.sin(((tx - 33) / 21) * Math.PI)) ||
                 (tx > 114 && tx < 135 && ty < 132 + 60 * Math.sin(((tx - 114) / 21) * Math.PI));
    return ty <= edge || drip ? GLAZE : CLAY;
  }
  if (inRoundRect(x, y, 136, 356, 240, 20, 10)) return ACCENT.map((c, i) => Math.round(c * 0.65 + GLAZE[i] * 0.35));
  return ACCENT;
}

function png(size) {
  const ss = 4, raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const c = shade(((px + (sx + 0.5) / ss) / size) * 512, ((py + (sy + 0.5) / ss) / size) * 512);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
      }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = a ? r / a : 0; raw[o + 1] = a ? g / a : 0; raw[o + 2] = a ? b / a : 0; raw[o + 3] = (a / (ss * ss)) * 255;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

for (const s of [192, 512]) fs.writeFileSync(new URL(`../public/icon-${s}.png`, import.meta.url), png(s));
console.log("Wrote public/icon-192.png and public/icon-512.png");
