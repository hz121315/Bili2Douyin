/*
 * 后台：房间订阅与消息分发。
 * 弹幕 WebSocket 默认放在 offscreen 文档（扩展页面环境）里，
 * 因为部分浏览器（360 极速浏览器X 等）会在后台 Service Worker 里立刻断开 WebSocket。
 * 没有 offscreen API 时回退到 Service Worker 内直连。
 */

import { normalizeRoomId } from './lib/bilibili.js';
import { DanmakuClient } from './lib/danmaku-client.js';

const OFFSITE_URL = 'offscreen.html';

const portsByRoom = new Map(); // roomKey -> Set<Port>
const clientsByRoom = new Map(); // roomKey -> DanmakuClient（仅回退时使用）
const statusByRoom = new Map(); // roomKey -> 最近一次状态

let offscreenPromise = null;

function broadcast(roomKey, message) {
  const ports = portsByRoom.get(roomKey);
  if (!ports) return;
  for (const port of ports) {
    try {
      port.postMessage(message);
    } catch {
      // 页面可能已经关闭，等 onDisconnect 清理
    }
  }
}

function relay(roomKey, message, transport) {
  const event = { ...message, transport };
  if (event.type === 'status') statusByRoom.set(roomKey, event);
  broadcast(roomKey, event);
}

function emitFromOffscreen(roomKey, event) {
  relay(roomKey, event, 'offscreen');
}

function emitFromLocal(roomKey, event) {
  relay(roomKey, event, 'sw');
}

function hasOffscreenApi() {
  return Boolean(chrome.offscreen && typeof chrome.offscreen.createDocument === 'function');
}

async function ensureOffscreen() {
  if (!hasOffscreenApi()) return false;
  if (!offscreenPromise) {
    offscreenPromise = (async () => {
      try {
        if (typeof chrome.offscreen.hasDocument === 'function') {
          const exists = await chrome.offscreen.hasDocument();
          if (exists) return true;
        }
        await chrome.offscreen.createDocument({
          url: OFFSITE_URL,
          reasons: [chrome.offscreen.Reason?.WORKERS || 'WORKERS'],
          justification: '维持 B 站弹幕 WebSocket 长连接',
        });
        return true;
      } catch {
        try {
          return typeof chrome.offscreen.hasDocument === 'function'
            ? await chrome.offscreen.hasDocument()
            : false;
        } catch {
          return false;
        }
      } finally {
        offscreenPromise = null;
      }
    })();
  }
  return offscreenPromise;
}

function sendToOffscreen(message, attempt = 0) {
  try {
    chrome.runtime.sendMessage({ target: 'offscreen', ...message }, () => {
      if (chrome.runtime.lastError && attempt < 6) {
        setTimeout(() => sendToOffscreen(message, attempt + 1), 300);
      }
    });
  } catch {
    if (attempt < 6) setTimeout(() => sendToOffscreen(message, attempt + 1), 300);
  }
}

function startRoom(roomKey) {
  ensureOffscreen().then((ok) => {
    if (!portsByRoom.has(roomKey)) return;

    if (ok) {
      sendToOffscreen({ type: 'connect', roomKey });
      return;
    }

    // 浏览器不支持 offscreen：在后台直连（部分浏览器可能不稳定）
    let client = clientsByRoom.get(roomKey);
    if (!client) {
      client = new DanmakuClient(roomKey, emitFromLocal);
      clientsByRoom.set(roomKey, client);
      client.start();
    } else {
      client.replay();
    }
  });
}

function stopRoom(roomKey) {
  const client = clientsByRoom.get(roomKey);
  if (client) {
    client.stop();
    clientsByRoom.delete(roomKey);
  }
  if (hasOffscreenApi()) sendToOffscreen({ type: 'disconnect', roomKey });
}

function subscribe(roomKey, port) {
  let ports = portsByRoom.get(roomKey);
  const isFirst = !ports;
  if (!ports) {
    ports = new Set();
    portsByRoom.set(roomKey, ports);
  }
  ports.add(port);
  if (isFirst) startRoom(roomKey);
}

function unsubscribe(roomKey, port) {
  const ports = portsByRoom.get(roomKey);
  if (!ports) return;
  ports.delete(port);
  if (ports.size > 0) return;

  portsByRoom.delete(roomKey);
  statusByRoom.delete(roomKey);
  stopRoom(roomKey);
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'bdm-event') return undefined;
  if (!message.roomKey || !message.event) return undefined;
  emitFromOffscreen(message.roomKey, message.event);
  return undefined;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'bdm') return;
  let roomKey = '';

  const reply = (message) => {
    try {
      port.postMessage(message);
    } catch {
      // 端口已失效
    }
  };

  port.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'subscribe') {
      const key = normalizeRoomId(message.roomId);
      if (!key) {
        reply({ type: 'status', phase: 'error', text: '请先填写 B 站直播间号' });
        return;
      }
      if (roomKey && roomKey !== key) unsubscribe(roomKey, port);
      roomKey = key;
      subscribe(key, port);

      const cached = statusByRoom.get(key);
      reply(cached || { type: 'status', phase: 'connecting', text: '正在连接…', roomId: key });
    } else if (message.type === 'unsubscribe') {
      if (roomKey) unsubscribe(roomKey, port);
      roomKey = '';
      reply({ type: 'status', phase: 'idle', text: '未连接' });
    } else if (message.type === 'ping') {
      reply({ type: 'pong' });
    }
  });

  port.onDisconnect.addListener(() => {
    if (roomKey) unsubscribe(roomKey, port);
  });
});

/*
 * 保证抖音直播页里有最新版本的内容脚本。
 * 典型场景：扩展安装/更新时页面已经打开，声明式 content script 不会自动重跑。
 */
const DOUYIN_URL = /^https:\/\/live\.douyin\.com\//;

async function ensureContentScript(tabId, url) {
  if (!tabId || !DOUYIN_URL.test(url || '')) return;
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['danmaku-layer.js', 'content.js'],
    });
  } catch {
    // 页面还没就绪，或被浏览器拒绝；下次导航会再试
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') ensureContentScript(tabId, tab.url);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({ url: 'https://live.douyin.com/*' }, (tabs) => {
    for (const tab of tabs) ensureContentScript(tab.id, tab.url);
  });
});
