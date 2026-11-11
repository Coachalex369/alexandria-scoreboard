#!/usr/bin/env node
// Generates build/icon.png (256×256) and build/icon.ico (PNG-in-ICO) for the desktop app with no dependencies:
// a painted-steel blue housing, a recessed black window and an amber 5×7 bulb-matrix "A". Deterministic.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { FONT } from "../packages/scoreboard/src/digits.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const N = 256;
const px = new Uint8Array(N * N * 4);
const set = (x, y, r, g, b, a = 255) => { if (x < 0 || y < 0 || x >= N || y >= N) return; const i = (y * N + x) * 4; const k = a / 255; px[i] = px[i] * (1 - k) + r * k; px[i + 1] = px[i + 1] * (1 - k) + g * k; px[i + 2] = px[i + 2] * (1 - k) + b * k; px[i + 3] = Math.max(px[i + 3], a); };
const inRound = (x, y, x0, y0, w, h, rad) => { const cx = Math.max(x0 + rad, Math.min(x, x0 + w - rad)), cy = Math.max(y0 + rad, Math.min(y, y0 + h - rad)); return x >= x0 && x < x0 + w && y >= y0 && y < y0 + h && (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad; };

// housing with a vertical gradient and a bevel
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  if (!inRound(x, y, 8, 8, 240, 240, 34)) continue;
  const t = y / N; const r = 29 + (16 - 29) * t, g = 65 + (38 - 65) * t, b = 134 + (90 - 134) * t;
  set(x, y, r, g, b);
  if (inRound(x, y, 8, 8, 240, 240, 34) && !inRound(x, y, 12, 12, 232, 232, 31)) set(x, y, 255, 255, 255, y < 60 ? 40 : 12);
}
// recessed window
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (inRound(x, y, 40, 48, 176, 160, 10)) { set(x, y, 5, 6, 8); if (y < 56) set(x, y, 255, 255, 255, 10); }
// dots: 5×7 glyph "A", each bulb a soft disc with glow
const g = FONT.A; const dot = 16, gap = 6, cell = dot + gap; const w = 5 * cell - gap, h = 7 * cell - gap; const ox = 40 + (176 - w) / 2, oy = 48 + (160 - h) / 2;
for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
  const on = g[r][c] === "1"; const cx = ox + c * cell + dot / 2, cy = oy + r * cell + dot / 2;
  for (let y = Math.floor(cy - 18); y <= cy + 18; y++) for (let x = Math.floor(cx - 18); x <= cx + 18; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (on && d > dot / 2 && d < 18) set(x, y, 255, 160, 40, 90 * (1 - (d - dot / 2) / (18 - dot / 2)));
    if (d <= dot / 2) { if (on) set(x, y, 255, 179, 71, d > dot / 2 - 1 ? 160 : 255); else set(x, y, 60, 42, 20, d > dot / 2 - 1 ? 120 : 255); }
  }
}
// screws
for (const [sx, sy] of [[24, 24], [232, 24], [24, 232], [232, 232]]) for (let y = sy - 7; y <= sy + 7; y++) for (let x = sx - 7; x <= sx + 7; x++) { const d = Math.hypot(x - sx, y - sy); if (d <= 7) set(x, y, d < 2 ? 50 : 150 + (7 - d) * 10, d < 2 ? 55 : 160 + (7 - d) * 8, d < 2 ? 70 : 180 + (7 - d) * 6, d > 6 ? 150 : 255); }

function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1); }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
function ico(pngBuf, size) {
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16); entry[0] = size === 256 ? 0 : size; entry[1] = size === 256 ? 0 : size; entry[2] = 0; entry[3] = 0; entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6); entry.writeUInt32LE(pngBuf.length, 8); entry.writeUInt32LE(22, 12);
  return Buffer.concat([head, entry, pngBuf]);
}
fs.mkdirSync(path.join(ROOT, "build"), { recursive: true });
const p = png(N, N, px);
fs.writeFileSync(path.join(ROOT, "build", "icon.png"), p);
fs.writeFileSync(path.join(ROOT, "build", "icon.ico"), ico(p, N));
console.log(`icon: build/icon.png (${p.length} bytes), build/icon.ico`);
