/*
 * 开发用探针：不加载浏览器扩展，直接用 Node 复现插件后台的连接流程，
 * 验证 WBI 签名、弹幕服务器认证、zlib 解包与弹幕字段提取是否正常。
 *
 * 用法：node tools/probe.mjs [房间号] [观察秒数]
 */

import crypto from 'node:crypto';
import { md5Hex } from '../lib/md5.js';
import {
  OP,
  buildPacket,
  extractMessages,
  getDanmuInfo,
  normalizeRoomId,
  parseFrames,
  resolveRoom,
} from '../lib/bilibili.js';

const ROOM = process.argv[2] || '7734200';
const SECONDS = Number(process.argv[3] || 15);

const sample = 'hello bilibili 弹幕';
const expected = crypto.createHash('md5').update(sample).digest('hex');
if (md5Hex(sample) !== expected) {
  console.error('MD5 自检失败');
  process.exit(1);
}
console.log('MD5 自检通过');

// Node 不会像浏览器那样自动带上 Referer，这里补上（B 站接口要求）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const doFetch = (url, init = {}) =>
  fetch(url, {
    ...init,
    headers: {
      'User-Agent': UA,
      Referer: 'https://live.bilibili.com/',
      ...(init.headers || {}),
    },
  });

const shortId = normalizeRoomId(ROOM);
const room = await resolveRoom(shortId, doFetch);
console.log(`房间 ${shortId} -> 真实房间号 ${room.realId}，开播状态 ${room.liveStatus}`);

const info = await getDanmuInfo(room.realId, doFetch);
console.log(`getDanmuInfo: token=${info.token ? '有' : '无'}，服务器 ${info.hosts.length} 个${info.fallback ? '（走了兜底）' : ''}`);

const host = info.hosts[0];
const url = `wss://${host.host}:${host.wss_port || 443}/sub`;
console.log('连接', url);

const ws = new WebSocket(url);
ws.binaryType = 'arraybuffer';

let authenticated = false;
let danmaku = 0;
let superChats = 0;
let frames = 0;

ws.addEventListener('open', () => {
  ws.send(
    buildPacket(
      OP.AUTH,
      JSON.stringify({
        uid: 0,
        roomid: room.realId,
        protover: 2,
        platform: 'web',
        type: 2,
        key: info.token,
      }),
    ),
  );
  ws.send(buildPacket(OP.HEARTBEAT, ''));
  setInterval(() => ws.send(buildPacket(OP.HEARTBEAT, '')), 30000);
});

ws.addEventListener('message', async (event) => {
  const bytes = new Uint8Array(event.data);
  frames += 1;
  try {
    await parseFrames(bytes, ({ op, body }) => {
      if (op === OP.AUTH_REPLY) {
        const code = JSON.parse(new TextDecoder().decode(body)).code;
        authenticated = code === 0;
        console.log('认证结果：', code);
        return;
      }
      if (op !== OP.MESSAGE) return;
      let json;
      try {
        json = JSON.parse(new TextDecoder().decode(body));
      } catch {
        return;
      }
      const item = extractMessages(json);
      if (!item) return;
      if (item.kind === 'sc') {
        superChats += 1;
        console.log(`[SC ￥${item.price}] ${item.user}: ${item.text}`);
      } else {
        danmaku += 1;
        if (danmaku <= 10) console.log(`[弹幕] ${item.user}: ${item.text}`);
      }
    });
  } catch (error) {
    console.warn('解包失败：', error.message);
  }
});

ws.addEventListener('error', () => console.warn('WebSocket 出错'));
ws.addEventListener('close', () => console.log('WebSocket 已关闭'));

setTimeout(() => {
  console.log(`\n${SECONDS} 秒内：消息包 ${frames} 个，认证${authenticated ? '成功' : '失败'}，弹幕 ${danmaku} 条，SC ${superChats} 条`);
  ws.close();
  process.exit(authenticated && (danmaku > 0 || frames > 0) ? 0 : 1);
}, SECONDS * 1000);
