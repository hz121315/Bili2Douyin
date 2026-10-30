/*
 * 生成扩展图标（无第三方依赖）：
 * 紫蓝渐变圆角方块 + 白色聊天气泡 + 三个点。
 *
 * 用法：node tools/make-icons.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SIZES = [16, 32, 48, 128];
const OUT_DIR = path.join(process.cwd(), 'icons');
const SS = 4; // 超采样倍数

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function insideCircle(x, y, cx, cy, radius) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
}

function insideTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function renderIcon(size) {
  const s = size * SS;
  const pixels = new Uint8ClampedArray(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          // 统一使用 0~1 的归一化坐标
          const px = (x * SS + sx + 0.5) / s;
          const py = (y * SS + sy + 0.5) / s;

          if (!insideRoundedRect(px, py, 0.02, 0.02, 0.98, 0.98, 0.23)) continue;

          // 背景渐变：左上紫蓝，右下品红
          const t = (px + py) / 2;
          let cr = mix(79, 168, t);
          let cg = mix(91, 85, t);
          let cb = mix(213, 247, t);

          const bubble =
            insideRoundedRect(px, py, 0.15, 0.19, 0.85, 0.64, 0.13) ||
            insideTriangle(px, py, 0.28, 0.62, 0.28, 0.84, 0.47, 0.62);

          if (bubble) {
            cr = 248;
            cg = 249;
            cb = 255;
            const dot =
              insideCircle(px, py, 0.34, 0.415, 0.052) ||
              insideCircle(px, py, 0.5, 0.415, 0.052) ||
              insideCircle(px, py, 0.66, 0.415, 0.052);
            if (dot) {
              cr = 92;
              cg = 100;
              cb = 225;
            }
          }

          r += cr;
          g += cg;
          b += cb;
          a += 255;
        }
      }

      const samples = SS * SS;
      const index = (y * size + x) * 4;
      const coverage = a / (samples * 255);
      if (coverage === 0) continue;
      pixels[index] = Math.round(r / (samples * coverage));
      pixels[index + 1] = Math.round(g / (samples * coverage));
      pixels[index + 2] = Math.round(b / (samples * coverage));
      pixels[index + 3] = Math.round(coverage * 255);
    }
  }

  return encodePng(size, size, Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength));
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, renderIcon(size));
  console.log('写入', file);
}
