/*
 * 扩展 iframe：承载 B 站弹幕 WebSocket 长连接。
 * 部分浏览器（360 极速浏览器X 等）没有 chrome.offscreen，且会在后台 Service Worker
 * 里立刻断开 WebSocket；放在嵌入抖音页面的扩展 iframe 里可以稳定保持连接。
 *
 * 与父页面的通信全部走 postMessage，并用 URL 里的 token 校验来源。
 */

import { DanmakuClient } from './lib/danmaku-client.js';

const params = new URLSearchParams(location.search);
const token = params.get('token') || '';
const clients = new Map(); // roomKey -> DanmakuClient

function post(message) {
  try {
    window.parent.postMessage({ source: 'bdm-frame', token, ...message }, '*');
  } catch {
    // 父页面可能已经关闭
  }
}

function connectRoom(roomKey) {
  if (!roomKey) return;
  const existing = clients.get(roomKey);
  if (existing) {
    existing.replay();
    return;
  }
  const client = new DanmakuClient(roomKey, (_roomKey, event) => post({ type: 'event', event }));
  clients.set(roomKey, client);
  client.start();
}

function disconnectRoom(roomKey) {
  const client = clients.get(roomKey);
  if (!client) return;
  client.stop();
  clients.delete(roomKey);
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.source !== 'bdm-overlay' || data.token !== token) return;

  if (data.type === 'connect') {
    connectRoom(data.roomKey);
  } else if (data.type === 'disconnect') {
    disconnectRoom(data.roomKey);
  } else if (data.type === 'ping') {
    const states = [];
    for (const [roomKey, client] of clients) {
      states.push({ roomKey, ...client.ping() });
    }
    post({ type: 'pong', states });
  }
});

post({ type: 'ready' });
