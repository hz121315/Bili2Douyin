/*
 * Offscreen 文档：承载 B 站弹幕 WebSocket 长连接。
 * 部分浏览器（360 极速浏览器X 等）会在后台 Service Worker 里立刻断开 WebSocket，
 * 放到扩展页面环境可以稳定保持连接。
 */

import { DanmakuClient } from './lib/danmaku-client.js';

const clients = new Map(); // roomKey -> DanmakuClient

function emit(roomKey, event) {
  try {
    chrome.runtime.sendMessage({ type: 'bdm-event', roomKey, event }, () => {
      // 后台可能正在重启，忽略连接错误
      void chrome.runtime.lastError;
    });
  } catch {
    // 忽略
  }
}

function connectRoom(roomKey) {
  if (!roomKey) return;
  const client = clients.get(roomKey);
  if (client) {
    client.replay();
    return;
  }
  const next = new DanmakuClient(roomKey, emit);
  clients.set(roomKey, next);
  next.start();
}

function disconnectRoom(roomKey) {
  const client = clients.get(roomKey);
  if (!client) return;
  client.stop();
  clients.delete(roomKey);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return undefined;

  if (message.type === 'connect') {
    connectRoom(message.roomKey);
    sendResponse({ ok: true });
  } else if (message.type === 'disconnect') {
    disconnectRoom(message.roomKey);
    sendResponse({ ok: true });
  } else if (message.type === 'ping') {
    sendResponse({ ok: true });
  }
  return undefined;
});
