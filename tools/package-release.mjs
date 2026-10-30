/*
 * 生成可直接上传 GitHub Releases / Chrome 应用商店的 zip：
 * - manifest.json 位于压缩包根目录
 * - 只包含运行时文件 + README + LICENSE + PRIVACY
 * - 不包含 dev/、tools/、.gitignore、.git、旧 zip
 *
 * 用法：node tools/package-release.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;
const output = path.join(ROOT, `Bili2Douyin-v${version}.zip`);

const FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'content.css',
  'danmaku-layer.js',
  'frame.html',
  'frame.js',
  'offscreen.html',
  'offscreen.js',
  'popup.html',
  'popup.js',
  'rules.json',
  'README.md',
  'LICENSE',
  'PRIVACY.md',
];

const DIRS = ['lib', 'icons'];

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

function collect(relativePath, out = []) {
  const abs = path.join(ROOT, relativePath);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) {
      collect(path.join(relativePath, name), out);
    }
  } else if (stat.isFile()) {
    out.push(relativePath.split(path.sep).join('/'));
  }
  return out;
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  const { time, date } = dosDateTime();
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const data = fs.readFileSync(entry.abs);
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const flags = 0x0800; // 文件名使用 UTF-8
    const method = 8; // deflate

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);

    localParts.push(local, compressed);
    centralParts.push(central);
    offset += local.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

const entries = [];
for (const file of FILES) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) throw new Error(`缺少文件：${file}`);
  entries.push({ name: file, abs });
}
for (const dir of DIRS) {
  for (const file of collect(dir)) {
    entries.push({ name: file, abs: path.join(ROOT, file) });
  }
}
entries.sort((a, b) => a.name.localeCompare(b.name));

const zip = createZip(entries);
fs.writeFileSync(output, zip);
const sha256 = crypto.createHash('sha256').update(zip).digest('hex');

console.log(`已生成：${path.basename(output)}`);
console.log(`版本：${version}`);
console.log(`文件数：${entries.length}`);
console.log(`大小：${(zip.length / 1024).toFixed(1)} KB`);
console.log(`SHA256：${sha256}`);
console.log('\n压缩包内容：');
for (const entry of entries) console.log(`  ${entry.name}`);
