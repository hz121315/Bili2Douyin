/*
 * B 站弹幕连接客户端。
 * 被 offscreen 文档使用（主路径）：浏览器后台 Service Worker 里的 WebSocket 在部分
 * 国产浏览器（如 360 极速浏览器X）会被立即断开，所以把长连接放到扩展页面环境。
 * 同时作为没有 offscreen API 时的后台回退。
 */

import {
  OP,
  buildPacket,
  extractMessages,
  getBuvid,
  getDanmuInfo,
  getRoomInfo,
  parseFrames,
  resolveRoom,
} from './bilibili.js';

function ensurePort443(hosts) {
  const list = [];
  const seen = new Set();
  const push = (host, port) => {
    const key = `${host}:${port}`;
    if (!host || seen.has(key)) return;
    seen.add(key);
    list.push({ host, wss_port: port });
  };

  for (const item of hosts || []) {
    if (!item || !item.host) continue;
    push(item.host, Number(item.wss_port) || 443);
  }
  push('broadcastlv.chat.bilibili.com', 443);
  push('tx-bj-live-comet-02.chat.bilibili.com', 443);
  push('hw-bj-live-comet-01.chat.bilibili.com', 443);
  return list;
}

function describeError(error, stage) {
  const message = error?.message ? String(error.message) : '未知错误';
  if (/failed to fetch|network|load failed/i.test(message)) {
    return `${stage}失败：无法访问 B 站接口（网络错误）`;
  }
  return `${stage}失败：${message}`;
}

export class DanmakuClient {
  /**
   * @param {string} roomKey 房间号
   * @param {(roomKey: string, message: object) => void} emit 事件输出
   */
  constructor(roomKey, emit) {
    this.roomKey = roomKey;
    this.emitEvent = typeof emit === 'function' ? emit : () => {};

    this.realId = null;
    this.liveStatus = 0;
    this.roomTitle = '';
    this.roomUname = '';
    this.retry = 0;
    this.hostIndex = 0;
    this.token = '';
    this.hosts = [];
    this.fallback = false;
    this.ws = null;
    this.heartbeatTimer = null;
    this.retryTimer = null;
    this.parseChain = Promise.resolve();
    this.decoder = new TextDecoder();
    this.stopped = false;
    this.authOk = false;
    this.connecting = false;
    this.lastError = null;
    this.host = null;
    this.infoCode = null;
    this.authCode = null;
    this.closeInfo = '';
    this.hostAttempts = 0;
    this.tokenAt = 0;
    this.tokenLength = 0;
    this.forceConf = false;
    this.source = '';
    this.warning = '';
    this.buvid = '';
    this.lastFrameAt = 0;
    this.status = { phase: 'idle', text: '未连接' };
  }

  emit(message) {
    try {
      this.emitEvent(this.roomKey, message);
    } catch {
      // 输出异常不影响连接
    }
  }

  emitStatus(phase, text, extra = {}) {
    this.status = { phase, text, ...extra };
    this.emit({
      type: 'status',
      phase,
      text,
      roomId: this.roomKey,
      realRoomId: this.realId,
      liveStatus: this.liveStatus,
      roomTitle: this.roomTitle,
      roomUname: this.roomUname,
      host: this.host ? `${this.host.host}:${this.host.wss_port || 443}` : '',
      error: this.lastError,
      infoCode: this.infoCode,
      authCode: this.authCode,
      source: this.source,
      warning: this.warning,
      tokenLength: this.tokenLength,
      ...extra,
    });
  }

  /** 把当前状态再发一次（新的订阅者接入时用）。 */
  replay() {
    this.emit({
      type: 'status',
      phase: this.status.phase || 'connecting',
      text: this.status.text || '正在连接…',
      roomId: this.roomKey,
      realRoomId: this.realId,
      liveStatus: this.liveStatus,
      roomTitle: this.roomTitle,
      roomUname: this.roomUname,
      host: this.host ? `${this.host.host}:${this.host.wss_port || 443}` : '',
      error: this.lastError,
      infoCode: this.infoCode,
      authCode: this.authCode,
      source: this.source,
      warning: this.warning,
      tokenLength: this.tokenLength,
    });
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  async connect() {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;

    let stage = '获取房间信息';
    try {
      if (!this.buvid) {
        try {
          this.buvid = await getBuvid(fetch);
        } catch {
          // 拿不到 buvid 也能连，只是收到的弹幕可能被服务器限流
        }
      }
      if (!this.realId) {
        this.emitStatus('connecting', '正在获取直播间信息…');
        const room = await resolveRoom(this.roomKey);
        this.realId = room.realId;
        this.liveStatus = room.liveStatus;
      }
      if (!this.roomTitle && this.realId) {
        const info = await getRoomInfo(this.realId);
        if (info) {
          this.roomTitle = info.title;
          this.roomUname = info.uname;
        }
      }
      if (this.stopped) return;

      if (!this.token || Date.now() - this.tokenAt > 10 * 60 * 1000) {
        stage = '获取弹幕服务器';
        this.emitStatus('connecting', '正在获取弹幕服务器…');
        const info = await getDanmuInfo(this.realId, fetch, { preferConf: this.forceConf });
        this.token = info.token;
        this.tokenLength = (info.token || '').length;
        this.hosts = ensurePort443(info.hosts);
        this.fallback = Boolean(info.fallback);
        this.infoCode = info.fallback ? info.code ?? -1 : 0;
        this.source = info.source || '';
        this.warning = info.warning || '';
        this.tokenAt = Date.now();
        if (info.fallback) {
          this.lastError = {
            stage,
            message: 'B 站弹幕接口拒绝请求（-352），正在尝试免登录连接；若失败请先在浏览器登录 B 站',
            at: Date.now(),
          };
        }
      }
      if (this.stopped) return;

      stage = '连接弹幕服务器';
      const host = this.pickHost();
      this.host = host;
      this.emitStatus('connecting', `正在连接 ${host.host}…`);
      this.openSocket(`wss://${host.host}:${host.wss_port || 443}/sub`);
    } catch (error) {
      this.setError(stage, describeError(error, stage));
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  setError(stage, message) {
    this.lastError = { stage, message, at: Date.now() };
    this.emitStatus('error', message);
  }

  pickHost() {
    const hosts = (this.hosts || []).filter((item) => item && item.host);
    if (!hosts.length) return { host: 'broadcastlv.chat.bilibili.com', wss_port: 443 };
    const host = hosts[this.hostIndex % hosts.length];
    this.hostIndex = (this.hostIndex + 1) % hosts.length;
    return host;
  }

  openSocket(url) {
    this.closeSocket();
    this.authOk = false;
    this.authCode = null;
    this.closeInfo = '';

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      this.setError('连接弹幕服务器', describeError(error, '连接弹幕服务器'));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      if (this.ws !== ws || this.stopped) return;
      ws.send(
        buildPacket(
          OP.AUTH,
          JSON.stringify({
            uid: 0,
            roomid: this.realId,
            protover: 2,
            ...(this.buvid ? { buvid: this.buvid } : {}),
            platform: 'web',
            type: 2,
            key: this.token || '',
          }),
        ),
      );
      this.sendHeartbeat(ws);
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(ws), 30000);
    });

    ws.addEventListener('message', (event) => {
      if (this.ws !== ws) return;
      this.handleMessage(event.data);
    });

    ws.addEventListener('close', (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopHeartbeat();
      if (this.stopped) return;

      this.closeInfo = [event.code, event.reason].filter(Boolean).join(' ');
      if (!this.authOk) {
        // 没收到认证回包（常见 1006）通常是 token 与匿名 uid 不匹配或被风控，
        // 下一次改用 getConf 获取匿名 token。
        const tryConf = this.authCode == null && this.source !== 'getConf';
        const base = this.authCode != null
          ? `弹幕认证失败（code ${this.authCode}）${this.fallback ? '：请先在浏览器登录 B 站再重试' : ''}`
          : !this.token
            ? '未获取到弹幕认证 token（B 站接口可能被风控）'
            : this.fallback
              ? `弹幕服务器拒绝连接（${this.closeInfo || '无响应'}）：B 站接口被风控，请登录 B 站后重试`
              : `弹幕服务器连接断开（${this.closeInfo || '无响应'}）`;

        this.lastError = {
          stage: '弹幕服务器',
          message: tryConf ? `${base}，正在改用备用接口重新获取 token` : base,
          at: Date.now(),
        };

        if (tryConf) {
          this.forceConf = true;
          this.token = '';
          this.tokenAt = 0;
        }

        // 先快速轮换 host_list 里的其他服务器：不少网络只放行部分线路
        if (this.hostAttempts + 1 < this.hosts.length) {
          this.hostAttempts += 1;
          this.emitStatus('reconnecting', '当前服务器不可用，正在尝试下一台…');
          clearTimeout(this.retryTimer);
          this.retryTimer = setTimeout(() => this.connect(), 400);
          return;
        }
        this.hostAttempts = 0;
      }

      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // 通常紧跟着 close 事件，交给 close 处理重连
    });
  }

  handleMessage(data) {
    this.lastFrameAt = Date.now();
    if (data instanceof ArrayBuffer) {
      this.queueParse(new Uint8Array(data));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      this.queueParse(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      return;
    }
    if (data && typeof data.arrayBuffer === 'function') {
      data
        .arrayBuffer()
        .then((buffer) => this.handleMessage(buffer))
        .catch(() => {});
    }
  }

  queueParse(bytes) {
    const items = [];
    this.parseChain = this.parseChain
      .then(() => parseFrames(bytes, ({ op, body }) => this.consumeFrame(op, body, items)))
      .then(() => {
        if (items.length) this.emit({ type: 'danmaku', items });
      })
      .catch(() => {});
  }

  consumeFrame(op, body, items) {
    if (op === OP.AUTH_REPLY) {
      let code = null;
      try {
        code = JSON.parse(this.decoder.decode(body)).code;
      } catch {
        // 忽略非法回包
      }
      if (code === 0) {
        this.onAuthenticated();
      } else {
        this.authCode = code;
        this.lastError = {
          stage: '弹幕认证',
          message: this.fallback
            ? `弹幕认证失败（code ${code}）：请先在浏览器登录 B 站后重试`
            : `弹幕认证失败（code ${code}）`,
          at: Date.now(),
        };
        this.emitStatus('error', this.lastError.message);
      }
      return;
    }

    if (op !== OP.MESSAGE) return;

    let json;
    try {
      json = JSON.parse(this.decoder.decode(body));
    } catch {
      return;
    }
    const item = extractMessages(json);
    if (item) items.push(item);
  }

  onAuthenticated() {
    if (this.authOk) return;
    this.authOk = true;
    this.retry = 0;
    this.hostAttempts = 0;
    this.lastError = null;
    this.authCode = null;
    this.forceConf = false;
    this.lastFrameAt = Date.now();
    this.emitStatus('connected', this.liveStatus === 1 ? '已连接' : '已连接（房间未开播）');
  }

  sendHeartbeat(ws) {
    try {
      ws.send(buildPacket(OP.HEARTBEAT, ''));
    } catch {
      // 连接已断开
    }
  }

  /**
   * 外部保活调用（由页面定时触发，规避隐藏 iframe 里定时器被浏览器节流）：
   * - 连接正常：补一次心跳；若长时间没有任何数据，主动重连
   * - 连接已断：立刻重新连接，而不是等被节流的重连计时器
   */
  ping() {
    const now = Date.now();
    const state = {
      wsState: this.ws ? this.ws.readyState : -1,
      lastFrameAgo: this.lastFrameAt ? now - this.lastFrameAt : -1,
      phase: this.status.phase,
    };
    if (this.stopped) return state;

    if (this.ws && this.ws.readyState === 1) {
      this.sendHeartbeat(this.ws);
      if (this.lastFrameAt && now - this.lastFrameAt > 90000) {
        console.warn('[B站弹幕] 长时间没有收到数据，主动重连');
        this.closeSocket();
        this.scheduleReconnect();
      }
    } else if (!this.connecting) {
      this.connect();
    }
    return state;
  }

  stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.retry += 1;
    const delay = Math.min(1500 * 1.8 ** (this.retry - 1), 30000);
    this.emitStatus(
      this.retry <= 1 ? 'connecting' : 'reconnecting',
      `${this.retry <= 1 ? '连接失败' : '重新连接中'}，${Math.max(1, Math.round(delay / 1000))} 秒后重试`,
    );
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  closeSocket() {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      ws.close();
    } catch {
      // 已经关闭
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopHeartbeat();
    this.closeSocket();
  }
}
