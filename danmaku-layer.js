/*
 * 画面内弹幕层：把弹幕渲染在抖音直播画面（<video>）之上，从右向左飞过。
 * 由 content.js 调用：setEnabled / setFontSize / show。
 * 层本身 pointer-events: none，不影响操作视频。
 */

(() => {
  'use strict';

  // 每次注入都重新定义类；旧实例由 content.js 的 dispose 负责销毁
  const MAX_ACTIVE = 900;
  const TRACK_MS = 400;
  const SC_DURATION = 6500;
  const TARGET_QUEUE_MS = 800;
  const TICK_MS = 100;
  const TICK_OFFSET = 36;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function readableColor(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return '#ffffff';
    const red = (number >> 16) & 255;
    const green = (number >> 8) & 255;
    const blue = number & 255;
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    if (luminance >= 0.42) return `rgb(${red}, ${green}, ${blue})`;
    const lighten = (channel) => Math.round(channel + (255 - channel) * 0.78);
    return `rgb(${lighten(red)}, ${lighten(green)}, ${lighten(blue)})`;
  }

  class BdmDanmakuLayer {
    constructor(options = {}) {
      this.onAvailabilityChange =
        typeof options.onAvailabilityChange === 'function' ? options.onAvailabilityChange : () => {};

      this.enabled = false;
      this.ready = false;
      this.lastNotified = false;
      this.root = null;
      this.area = null;
      this.scArea = null;
      this.rect = null;
      this.fontSize = 20;
      this.laneHeight = 33;
      this.laneFreeAt = [];
      this.active = new Set();
      this.pending = [];
      this.pumpTimer = null;
      this.lastPumpAt = 0;
      this.speedSeconds = 12;
      this.colorMode = 'original';
      this.customColor = '#ffffff';
      this.density = 100;
      this.areaRatio = 1;
      this.received = 0;
      this.shown = 0;
      this.dropped = 0;
      this.lastLag = 0;
      this.maxLag = 0;
      this.scShowing = 0;
      this.timer = null;
      this.boundTrack = () => this.track();

      document.addEventListener('fullscreenchange', this.boundTrack);
      document.addEventListener('webkitfullscreenchange', this.boundTrack);
      window.addEventListener('resize', this.boundTrack);
      window.addEventListener('scroll', this.boundTrack, { passive: true, capture: true });
    }

    /* ---------- 对外接口 ---------- */

    setEnabled(enabled) {
      this.enabled = Boolean(enabled);
      if (this.enabled) {
        this.ensureDom();
        this.startTracking();
      } else {
        this.stopTracking();
        this.stopPump();
        this.pending.length = 0;
        this.hide();
        this.clearAll();
        this.notify();
      }
    }

    setFontSize(px) {
      const size = clamp(Math.round(Number(px) || 22), 12, 48);
      if (size === this.fontSize) return;
      this.fontSize = size;
      this.updateLanes();
    }

    /** 弹幕横穿画面的时长（秒），越大越慢。 */
    setSpeed(seconds) {
      const value = Number(seconds);
      if (!Number.isFinite(value)) return;
      this.speedSeconds = clamp(value, 4, 20);
    }

    /** 颜色模式：original（跟随 B 站）/ white / custom。 */
    setColorMode(mode, customColor) {
      if (['original', 'white', 'custom'].includes(mode)) this.colorMode = mode;
      if (typeof customColor === 'string' && /^#[0-9a-f]{6}$/i.test(customColor)) {
        this.customColor = customColor;
      }
    }

    /** 显示比例（10~100），低于 100 时会随机少显示一部分弹幕。 */
    setDensity(percent) {
      const value = Number(percent);
      if (!Number.isFinite(value)) return;
      this.density = clamp(Math.round(value), 10, 100);
    }

    /** 显示区域占视频高度的比例：1 全屏、0.5 上半屏、0.25 上四分之一。 */
    setAreaRatio(ratio) {
      const value = Number(ratio);
      if (!Number.isFinite(value)) return;
      const next = clamp(value, 0.1, 1);
      if (Math.abs(next - this.areaRatio) < 0.001) return;
      this.areaRatio = next;
      this.updateLanes();
      this.clearAll();
      if (this.pending.length) this.pump();
    }

    isReady() {
      return Boolean(this.enabled && this.ready && this.rect);
    }

    getStatus() {
      return {
        ready: this.isReady(),
        width: this.rect ? Math.round(this.rect.width) : 0,
        height: this.rect ? Math.round(this.rect.height) : 0,
        active: this.active.size,
        pending: this.pending.length,
        received: this.received,
        shown: this.shown,
        dropped: this.dropped,
        lag: Math.round(this.lastLag),
        maxLag: Math.round(this.maxLag),
      };
    }

    /**
     * 接收已经到期的弹幕。
     * 进入缓冲队列后按「积压量」控制放出节奏：积压越多放得越快，
     * 把排队延迟压在一个很小的范围内（约 0.8 秒），同时保持先后顺序。
     */
    show(items) {
      if (!this.enabled) return;
      const now = performance.now();
      for (const item of items) {
        if (!item || !item.text) continue;
        this.received += 1;
        if (this.density < 100 && Math.random() * 100 >= this.density) {
          this.dropped += 1;
          continue;
        }
        item.__bdmQueuedAt = now;
        this.pending.push(item);
      }
      if (this.pending.length > 5000) {
        const extra = this.pending.length - 5000;
        this.pending.splice(0, extra);
        this.dropped += extra;
      }
      this.pump();
    }

    pump() {
      if (!this.enabled || !this.rect) return;
      if (this.pumpTimer) return;

      // 每 100ms 一拍，按积压量决定这一拍放几条。
      // 如果浏览器把定时器节流了（elapsed 变大），这一拍就多放一些，
      // 保证排队延迟不会因为定时器被压后而越积越多。
      const now = performance.now();
      const elapsed = this.lastPumpAt ? Math.max(TICK_MS, now - this.lastPumpAt) : TICK_MS;
      this.lastPumpAt = now;

      const pending = this.pending.length;
      const perTick = pending ? Math.max(1, Math.ceil((pending * elapsed) / TARGET_QUEUE_MS)) : 0;

      let launched = 0;
      while (launched < perTick && this.pending.length) {
        const item = this.pending.shift();
        if (!item) break;
        if (item.kind === 'sc') this.showSuperChat(item);
        else this.launch(item, launched * TICK_OFFSET);
        launched += 1;
      }

      this.pumpTimer = setTimeout(() => {
        this.pumpTimer = null;
        this.pump();
      }, TICK_MS);
    }

    stopPump() {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }

    /* ---------- DOM ---------- */

    ensureDom() {
      if (this.root && this.root.isConnected) return;

      // 扩展重新加载后，旧脚本留下的节点要先清掉
      document.getElementById('bdm-dm-layer')?.remove();

      const root = document.createElement('div');
      root.id = 'bdm-dm-layer';

      const area = document.createElement('div');
      area.className = 'bdm-dm-area';

      const scArea = document.createElement('div');
      scArea.className = 'bdm-dm-sc-area';

      root.append(area, scArea);
      this.root = root;
      this.area = area;
      this.scArea = scArea;
      this.mountRoot();
    }

    mountRoot() {
      if (!this.root) return;
      const fullscreen = document.fullscreenElement || document.webkitFullscreenElement;
      const host = fullscreen && fullscreen.tagName !== 'VIDEO' && fullscreen !== document.documentElement
        ? fullscreen
        : document.body || document.documentElement;
      if (this.root.parentNode !== host) host.appendChild(this.root);
    }

    hide() {
      if (this.root) this.root.style.display = 'none';
    }

    /* ---------- 跟随视频位置 ---------- */

    startTracking() {
      if (!this.timer) this.timer = setInterval(this.boundTrack, TRACK_MS);
      this.track();
    }

    stopTracking() {
      clearInterval(this.timer);
      this.timer = null;
    }

    track() {
      if (!this.enabled) return;
      this.mountRoot();

      const video = this.pickVideo();
      if (!video) {
        this.rect = null;
        this.ready = false;
        this.hide();
        this.notify();
        return;
      }

      const contentRect = this.computeContentRect(video);
      if (!contentRect) {
        this.rect = null;
        this.ready = false;
        this.hide();
        this.notify();
        return;
      }

      const rect = {
        left: Math.round(contentRect.left),
        top: Math.round(contentRect.top),
        width: Math.round(contentRect.width),
        height: Math.round(contentRect.height),
      };
      const previous = this.rect;
      const sizeChanged = !previous || Math.abs(rect.width - previous.width) > 1 || Math.abs(rect.height - previous.height) > 1;

      this.rect = rect;
      if (this.root) {
        this.root.style.left = `${rect.left}px`;
        this.root.style.top = `${rect.top}px`;
        this.root.style.width = `${rect.width}px`;
        this.root.style.height = `${rect.height}px`;
        this.root.style.display = 'block';
      }

      if (sizeChanged) {
        this.clearAll();
        this.updateLanes();
      }

      this.ready = true;
      this.notify();
      if (this.pending.length) this.pump();
    }

    pickVideo() {
      let best = null;
      let bestArea = 0;
      for (const video of document.querySelectorAll('video')) {
        if (!video.isConnected || video.readyState < 2) continue;
        const rect = video.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 80) continue;
        const style = getComputedStyle(video);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
        const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
        const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
        if (visibleWidth < 80 || visibleHeight < 60) continue;
        const area = visibleWidth * visibleHeight;
        if (area > bestArea) {
          bestArea = area;
          best = video;
        }
      }
      return best;
    }

    computeContentRect(video) {
      const rect = video.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 60) return null;
      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return null;

      const videoWidth = video.videoWidth;
      const videoHeight = video.videoHeight;
      if (!videoWidth || !videoHeight) return rect;

      const fit = getComputedStyle(video).objectFit;
      if (fit !== 'contain' && fit !== 'scale-down') return rect;

      // contain：去掉上下或左右的黑边，让弹幕只落在画面内容上
      const videoRatio = videoWidth / videoHeight;
      const boxRatio = rect.width / rect.height;
      let left = rect.left;
      let top = rect.top;
      let width = rect.width;
      let height = rect.height;

      if (videoRatio > boxRatio) {
        height = rect.width / videoRatio;
        top = rect.top + (rect.height - height) / 2;
      } else {
        width = rect.height * videoRatio;
        left = rect.left + (rect.width - width) / 2;
      }
      return { left, top, width, height };
    }

    destroy() {
      this.enabled = false;
      this.stopTracking();
      this.stopPump();
      this.pending.length = 0;
      document.removeEventListener('fullscreenchange', this.boundTrack);
      document.removeEventListener('webkitfullscreenchange', this.boundTrack);
      window.removeEventListener('resize', this.boundTrack);
      window.removeEventListener('scroll', this.boundTrack, true);
      this.clearAll();
      this.root?.remove();
      this.root = null;
      this.area = null;
      this.scArea = null;
      this.rect = null;
      this.ready = false;
    }

    notify() {
      const next = this.isReady();
      if (next === this.lastNotified) return;
      this.lastNotified = next;
      try {
        this.onAvailabilityChange(next);
      } catch {
        // 回调异常不影响渲染
      }
    }

    /* ---------- 渲染 ---------- */

    updateLanes() {
      this.laneHeight = Math.max(26, Math.round(this.fontSize * 1.55));
      const usableHeight = this.rect ? this.rect.height * this.areaRatio : 0;
      const count = Math.max(1, Math.floor((usableHeight - 12) / this.laneHeight));
      this.laneFreeAt = new Array(count).fill(0);
    }

    clearAll() {
      if (this.area) this.area.replaceChildren();
      this.active.clear();
      this.laneFreeAt = this.laneFreeAt.map(() => 0);
    }

    speed() {
      const width = this.rect ? this.rect.width : 900;
      return clamp(width / this.speedSeconds, 50, 600);
    }

    pickLane(now) {
      const lanes = this.laneFreeAt.length || 1;
      const free = [];
      let bestLane = 0;
      let earliest = Infinity;
      for (let index = 0; index < lanes; index += 1) {
        const freeAt = this.laneFreeAt[index] || 0;
        if (freeAt <= now) free.push(index);
        if (freeAt < earliest) {
          earliest = freeAt;
          bestLane = index;
        }
      }
      // 空闲轨道里随机选，避免相邻弹幕总是挤在相邻两行
      if (free.length) return free[Math.floor(Math.random() * free.length)];
      // 所有轨道都在占用时仍然放出去（允许重叠），保证不丢弹幕
      return bestLane;
    }

    colorFor(item) {
      if (this.colorMode === 'white') return '#f5f6fa';
      if (this.colorMode === 'custom') return this.customColor;
      return readableColor(item.color);
    }

    launch(item, extraOffset = 0) {
      // 同屏到上限时提前清掉最老的弹幕，保证新弹幕永远能显示出来
      while (this.active.size >= MAX_ACTIVE) {
        const oldest = this.active.values().next().value;
        if (!oldest) break;
        this.active.delete(oldest);
        try {
          oldest.remove();
        } catch {
          // 忽略
        }
      }

      const node = document.createElement('div');
      node.className = 'bdm-dm-item';
      node.textContent = item.text;
      node.style.fontSize = `${this.fontSize}px`;
      node.style.color = this.colorFor(item);

      const speed = this.speed();
      const from = this.rect.width + 12 + Math.max(0, extraOffset);
      node.style.transform = `translate3d(${from}px, 0, 0)`;

      this.area.appendChild(node);

      const width = node.offsetWidth || 80;
      const now = performance.now();
      const queuedAt = Number(item.__bdmQueuedAt) || now;
      const lag = Math.max(0, now - queuedAt);
      this.lastLag = lag;
      if (lag > this.maxLag) this.maxLag = lag;
      const lane = this.pickLane(now);
      node.style.top = `${6 + lane * this.laneHeight}px`;
      this.laneFreeAt[lane] = now + ((width + 32) / speed) * 1000;

      const to = -width - 12;
      const duration = Math.max(1500, ((from - to) / speed) * 1000);
      const animation = node.animate(
        [
          { transform: `translate3d(${from}px, 0, 0)` },
          { transform: `translate3d(${to}px, 0, 0)` },
        ],
        { duration, easing: 'linear' },
      );

      this.active.add(node);
      this.shown += 1;
      let removed = false;
      const remove = () => {
        if (removed) return;
        removed = true;
        this.active.delete(node);
        node.remove();
      };
      animation.addEventListener('finish', remove);
      animation.addEventListener('cancel', remove);
      setTimeout(remove, duration + 800);
    }

    showSuperChat(item) {
      if (!this.scArea || this.scShowing >= 2) return;

      const node = document.createElement('div');
      node.className = 'bdm-dm-sc';

      const head = document.createElement('div');
      head.className = 'bdm-dm-sc-head';

      const price = document.createElement('span');
      price.className = 'bdm-dm-sc-price';
      price.textContent = `¥${item.price || ''}`;

      const user = document.createElement('span');
      user.className = 'bdm-dm-sc-user';
      user.textContent = item.user || '';

      const text = document.createElement('div');
      text.className = 'bdm-dm-sc-text';
      text.textContent = item.text;

      head.append(price, user);
      node.append(head, text);
      this.scArea.appendChild(node);
      this.scShowing += 1;

      setTimeout(() => {
        node.remove();
        this.scShowing = Math.max(0, this.scShowing - 1);
      }, SC_DURATION);
    }
  }

  window.BdmDanmakuLayer = BdmDanmakuLayer;
})();
