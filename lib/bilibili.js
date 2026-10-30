/*
 * B 站直播弹幕协议的最小实现。
 * 只保留本插件用到的部分：房间号解析、WBI 签名、弹幕服务器信息、数据包编解码、弹幕字段提取。
 *
 * 参考：bilibili-API-collect（直播信息流 / WBI 签名）
 */

import { md5Hex } from './md5.js';

export const OP = {
  HEARTBEAT: 2,
  HEARTBEAT_REPLY: 3,
  MESSAGE: 5,
  AUTH: 7,
  AUTH_REPLY: 8,
};

// WBI 混淆表
const WBI_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const API_ROOM_INIT = 'https://api.live.bilibili.com/room/v1/Room/room_init';
const API_DANMU_INFO = 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo';
const API_DANMU_CONF = 'https://api.live.bilibili.com/room/v1/Danmu/getConf';
const API_NAV = 'https://api.bilibili.com/x/web-interface/nav';
const API_BUVID = 'https://api.bilibili.com/x/frontend/finger/spi';

let buvidCache = { value: '', at: 0 };

const DEFAULT_HOSTS = [
  { host: 'broadcastlv.chat.bilibili.com', wss_port: 443 },
  { host: 'tx-bj-live-comet-02.chat.bilibili.com', wss_port: 443 },
];

let wbiCache = { key: '', at: 0 };

/** 从「6」「6?x=1」「https://live.bilibili.com/6」等输入中提取房间号。 */
export function normalizeRoomId(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const fromUrl = text.match(/live\.bilibili\.com\/(?:blanc\/)?(\d+)/i);
  if (fromUrl) return fromUrl[1];
  const digits = text.match(/\d{1,12}/);
  return digits ? digits[0] : '';
}

async function fetchJson(doFetch, url, timeoutMs = 10000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await doFetch(url, {
      // 弹幕认证包固定用 uid: 0，所以取 token 也必须用匿名身份；
      // 带上浏览器的 B 站登录 Cookie 会拿到绑定账号的 token，认证会被断开（1006）。
      credentials: 'omit',
      cache: 'no-store',
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 获取一个匿名设备 ID（buvid3），弹幕认证包需要它才能拿到完整弹幕流。 */
export async function getBuvid(doFetch = fetch) {
  if (buvidCache.value && Date.now() - buvidCache.at < 12 * 60 * 60 * 1000) {
    return buvidCache.value;
  }
  try {
    const json = await fetchJson(doFetch, API_BUVID, 8000);
    const value = json?.data?.b_3 || '';
    if (value) buvidCache = { value, at: Date.now() };
    return value;
  } catch {
    return '';
  }
}

/** 获取 WBI 签名用的 mixinKey（匿名访问 nav 也能拿到 img/sub 密钥）。 */
export async function getWbiKey(doFetch = fetch, force = false) {
  if (!force && wbiCache.key && Date.now() - wbiCache.at < 30 * 60 * 1000) {
    return wbiCache.key;
  }
  const json = await fetchJson(doFetch, API_NAV);
  const imgUrl = json?.data?.wbi_img?.img_url;
  const subUrl = json?.data?.wbi_img?.sub_url;
  if (!imgUrl || !subUrl) throw new Error('无法获取 B 站签名密钥');

  const imgKey = imgUrl.split('/').pop().split('.')[0];
  const subKey = subUrl.split('/').pop().split('.')[0];
  const raw = imgKey + subKey;
  const key = WBI_TABLE.map((index) => raw[index] || '').join('').slice(0, 32);
  wbiCache = { key, at: Date.now() };
  return key;
}

/** 生成带 w_rid 的查询串。 */
export function signWbi(params, mixinKey, now = Date.now()) {
  const wts = Math.floor(now / 1000);
  const all = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(all[key]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${query}&w_rid=${md5Hex(query + mixinKey)}`;
}

/** 短号 → 真实房间号（也返回开播状态）。 */
export async function resolveRoom(shortId, doFetch = fetch) {
  const json = await fetchJson(doFetch, `${API_ROOM_INIT}?id=${encodeURIComponent(shortId)}`);
  if (json?.code === 0 && json.data?.room_id) {
    return {
      realId: json.data.room_id,
      liveStatus: Number(json.data.live_status) || 0,
    };
  }
  const code = json?.code;
  const reason = code === 60004 ? '直播间不存在' : `获取房间信息失败（${code ?? '网络错误'}）`;
  throw new Error(reason);
}

/**
 * 获取弹幕服务器列表与 token。
 * 1) 优先官方接口 getDanmuInfo（需要 WBI 签名，B 站接口还需要 Referer）
 * 2) 官方接口被风控（-352）、出错或 token 认证失败时，退回旧接口 getConf
 * 3) 都失败时返回默认服务器 + 空 token，由调用方给出明确错误
 *
 * @param {{ preferConf?: boolean }} [options] preferConf=true 时跳过官方接口，直接用 getConf
 */
export async function getDanmuInfo(realId, doFetch = fetch, options = {}) {
  let lastCode = null;
  let lastError = null;

  if (!options.preferConf) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const key = await getWbiKey(doFetch, attempt > 0);
        const query = signWbi({ id: realId, type: 0 }, key);
        const json = await fetchJson(doFetch, `${API_DANMU_INFO}?${query}`);
        lastCode = json?.code;
        if (json?.code === 0 && Array.isArray(json.data?.host_list) && json.data.host_list.length) {
          return { token: json.data.token || '', hosts: json.data.host_list, fallback: false, source: 'getDanmuInfo' };
        }
        if (json?.code !== -352) break;
      } catch (error) {
        lastError = error;
      }
    }
  }

  try {
    const json = await fetchJson(doFetch, `${API_DANMU_CONF}?room_id=${encodeURIComponent(realId)}&platform=pc&player=web`);
    if (json?.code === 0 && Array.isArray(json.data?.host_server_list) && json.data.host_server_list.length) {
      return {
        token: json.data.token || '',
        hosts: json.data.host_server_list,
        fallback: false,
        source: 'getConf',
        warning: lastCode != null ? `官方接口返回 ${lastCode}，已改用备用接口` : '',
      };
    }
    lastCode = json?.code ?? lastCode;
  } catch (error) {
    lastError = error;
  }

  if (lastError && lastCode == null) throw lastError;
  return { token: '', hosts: DEFAULT_HOSTS, fallback: true, code: lastCode, source: 'none' };
}

/** 组装一个 B 站直播数据包（16 字节头 + body）。 */
export function buildPacket(op, body, ver = 1) {
  const payload = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const buffer = new Uint8Array(16 + payload.length);
  const view = new DataView(buffer.buffer);
  view.setUint32(0, buffer.length);
  view.setUint16(4, 16);
  view.setUint16(6, ver);
  view.setUint32(8, op);
  view.setUint32(12, 1);
  buffer.set(payload, 16);
  return buffer;
}

async function inflateZlib(bytes) {
  if (typeof DecompressionStream === 'undefined') return null;
  for (const format of ['deflate', 'deflate-raw']) {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // 换一种格式再试
    }
  }
  return null;
}

/**
 * 解析一个 WebSocket 消息（可能包含多个数据包，压缩包会递归展开）。
 * 只把「业务包」交给 onFrame，压缩容器本身不会暴露出去。
 */
export async function parseFrames(bytes, onFrame) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const view = new DataView(buffer);
  let offset = 0;

  while (offset + 16 <= buffer.byteLength) {
    const total = view.getUint32(offset);
    if (total < 16 || offset + total > buffer.byteLength) break;

    const headerLength = view.getUint16(offset + 4);
    const ver = view.getUint16(offset + 6);
    const op = view.getUint32(offset + 8);

    if (headerLength >= 16 && headerLength <= total) {
      const body = new Uint8Array(buffer, offset + headerLength, total - headerLength);
      if (op === OP.MESSAGE && (ver === 2 || ver === 3)) {
        // ver 2 = zlib，ver 3 = brotli。我们认证时请求 protover 2，正常不会收到 brotli。
        if (ver === 2) {
          const inflated = await inflateZlib(body);
          if (inflated) await parseFrames(inflated, onFrame);
        }
      } else {
        await onFrame({ op, ver, body });
      }
    }

    offset += total;
  }
}

/** 从业务 JSON 中提取一条可展示的弹幕 / 醒目留言，其他类型返回 null。 */
export function extractMessages(json) {
  const cmd = String(json?.cmd ?? '');

  if (cmd.startsWith('DANMU_MSG')) {
    const info = json.info;
    if (!Array.isArray(info)) return null;
    const text = typeof info[1] === 'string' ? info[1] : '';
    if (!text) return null;
    return {
      kind: 'danmaku',
      user: String(info[2]?.[1] ?? ''),
      text,
      color: Number(info[3]?.[0]) || 0,
      uid: info[2]?.[0] ?? 0,
    };
  }

  if (cmd === 'SUPER_CHAT_MESSAGE') {
    const data = json.data || {};
    const text = String(data.message ?? '');
    if (!text) return null;
    return {
      kind: 'sc',
      user: String(data.user_info?.uname ?? ''),
      text,
      color: 0,
      price: Number(data.price) || 0,
    };
  }

  return null;
}
