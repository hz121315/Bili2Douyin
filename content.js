/*
 * 抖音直播间页面内的 B 站弹幕浮层。
 * 弹幕会全部先进入本地队列，再按「到达时间 + 延迟」逐条显示，
 * 因此拖动延迟即可让 B 站弹幕与抖音画面重新对齐。
 */

(() => {
  'use strict';

  const VERSION = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return '';
    }
  })();

  // 同一版本重复注入时跳过；扩展升级后允许新脚本接管旧界面
  if (VERSION && window.__bdmOverlayVersion === VERSION) return;
  window.__bdmOverlayVersion = VERSION || 'dev';
  window.__bdmOverlayLoaded = true;

  // 清理旧实例（扩展升级后旧脚本的定时器、弹幕层和界面）
  try {
    window.__bdmDispose?.();
  } catch {
    // 忽略
  }

  const STORAGE_KEY = 'bdmSettings';
  const MAX_OFFSET = 10 * 60 * 1000;
  const MAX_QUEUE = 4000;
  const MAX_LINES = 200;
  const TICK = 100;

  const DEFAULTS = {
    roomId: '',
    offsetMs: 0,
    fontSize: 15,
    dmFontSize: 20,
    dmSpeed: 12,
    dmOpacity: 1,
    dmShadow: 2,
    dmFontFamily: 'system',
    dmFontWeight: 500,
    savedRooms: [],
    dmColorMode: 'original',
    dmColor: '#ffffff',
    dmDensity: 100,
    dmArea: 'full',
    displayMode: 'overlay',
    opacity: 0.88,
    showSC: true,
    wantConnected: false,
    hidden: false,
    collapsed: false,
    panel: { x: null, y: 96, w: 360, h: 340 },
  };

  // B 站弹幕里的表情是 [名称] 文本 token，这里把常见的换成 emoji，避免刷屏时满屏方括号
  const SHADOW_LABELS = ['无', '弱', '中', '强'];

  const FONT_STACKS = {
    system: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    yahei: '"Microsoft YaHei", "微软雅黑", "PingFang SC", sans-serif',
    simhei: 'SimHei, "黑体", "Microsoft YaHei", sans-serif',
    simsun: 'SimSun, "宋体", "Songti SC", serif',
    kaiti: 'KaiTi, "楷体", "Kaiti SC", serif',
    sourcehan: '"Source Han Sans SC", "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei", sans-serif',
    pingfang: '"PingFang SC", "苹方", "Microsoft YaHei", sans-serif',
    dengxian: 'DengXian, "等线", "Microsoft YaHei", sans-serif',
    fangsong: 'FangSong, "仿宋", "STFangsong", "Songti SC", serif',
    stxihei: 'STXihei, "华文细黑", "Microsoft YaHei", sans-serif',
    sourcehanserif: '"Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", "Songti SC", serif',
    yaheiLight: '"Microsoft YaHei Light", "Microsoft YaHei", "微软雅黑", sans-serif',
  };

  const EMOTICONS = {
    '大笑': '😄', '笑哭': '😂', '呲牙': '😁', '大哭': '😭', '泪目': '🥲', '委屈': '🥺', '害羞': '😳',
    '喜欢': '😍', '花痴': '😍', '爱心': '❤️', '亲亲': '😘', '白眼': '🙄', '无语': '😑', '嫌弃': '😒',
    '撇嘴': '😕', '傲慢': '😤', '生气': '😠', '惊恐': '😱', '害怕': '😨', '憨笑': '😊', '坏笑': '😏',
    '阴险': '😏', '滑稽': '😜', '抠鼻': '😏', '打脸': '🤕', '疼': '😣', '呆': '🤪', '疑问': '❓',
    '妙啊': '👍', '点赞': '👍', '鼓掌': '👏', '抱拳': '🙏', '保佑': '🙏', '干杯': '🍻', '吃瓜': '🍉',
    '咖啡': '☕', '打call': '🙌', '加油': '💪', '奋斗': '💪', 'doge': '🐶', 'OK': '👌', '牛': '👍',
    '玫瑰': '🌹', '星星': '⭐', '月亮': '🌙', '太阳': '☀️', '烟花': '🎆', '庆祝': '🎉', '生日快乐': '🎂',
    '奶茶': '🥤', '妙': '✨', '灵光一闪': '💡', '灵魂出窍': '😵', '懵逼': '😵', '摸鱼': '🐟',
  };

  function prettifyText(text) {
    return String(text).replace(/\[([^\]]{1,12})\]/g, (match, name) => EMOTICONS[name] || match);
  }

  const TEMPLATE = `
    <div class="bdm-panel" data-role="panel">
      <div class="bdm-head" data-role="head">
        <span class="bdm-dot" data-role="dot" data-phase="idle"></span>
        <span class="bdm-title">B站弹幕</span>
        <span class="bdm-room" data-role="roomLabel"></span>
        <span class="bdm-grow"></span>
        <button class="bdm-ico" data-act="toggle-settings" title="设置">&#9881;</button>
        <button class="bdm-ico" data-role="collapseBtn" data-act="collapse" title="收起 / 展开">&#9662;</button>
        <button class="bdm-ico" data-act="hide" title="隐藏面板（Alt+B 恢复）">&#10005;</button>
      </div>
      <div class="bdm-alert" data-role="alert" hidden>
        <span class="bdm-alert-text" data-role="alertText"></span>
        <button class="bdm-alert-btn" data-role="alertBtn" data-act="alert-action">重试</button>
      </div>
      <div class="bdm-body" data-role="body">
        <div class="bdm-list" data-role="list" aria-live="polite"></div>
        <div class="bdm-bar">
          <div class="bdm-offset">
            <button class="bdm-mini" data-act="off-minus-1000" title="延迟 -1 秒">-1s</button>
            <button class="bdm-mini" data-act="off-minus-500" title="延迟 -0.5 秒">-0.5s</button>
            <input class="bdm-range" data-role="offsetRange" type="range" min="0" max="120000" step="500" value="0" aria-label="弹幕延迟">
            <button class="bdm-mini" data-act="off-plus-500" title="延迟 +0.5 秒">+0.5s</button>
            <button class="bdm-mini" data-act="off-plus-1000" title="延迟 +1 秒">+1s</button>
          </div>
          <div class="bdm-meta">
            <span data-role="offsetLabel">延迟 0.0s</span>
            <span class="bdm-grow"></span>
            <span data-role="queueLabel">缓冲 0</span>
            <span data-role="statusLabel" title="">未连接</span>
          </div>
        </div>
      </div>
      <div class="bdm-settings" data-role="settings" hidden>
        <div class="bdm-field">
          <label class="bdm-label" for="bdm-room-input">B 站直播间号或链接</label>
          <input id="bdm-room-input" class="bdm-input" data-role="roomInput" type="text"
                 placeholder="例如 6 或 https://live.bilibili.com/6" spellcheck="false">
        </div>
        <div class="bdm-field">
          <label class="bdm-label">已保存的直播间（点击快速连接）</label>
          <div class="bdm-saved" data-role="savedRooms"></div>
        </div>
        <div class="bdm-row">
          <button class="bdm-btn primary" data-act="connect">连接</button>
          <button class="bdm-btn" data-act="reconnect">重新连接</button>
          <button class="bdm-btn" data-act="disconnect">断开</button>
          <button class="bdm-btn" data-act="offset-reset">延迟归零</button>
        </div>
        <div class="bdm-field">
          <span class="bdm-label">弹幕显示位置</span>
          <div class="bdm-seg" data-role="modeGroup">
            <button type="button" class="bdm-seg-btn" data-mode="overlay">画面内</button>
            <button type="button" class="bdm-seg-btn" data-mode="panel">右侧列表</button>
            <button type="button" class="bdm-seg-btn" data-mode="both">两者</button>
          </div>
        </div>
        <div class="bdm-field">
          <label class="bdm-label">字号 <span data-role="fontValue">15px</span></label>
          <input class="bdm-range" data-role="fontRange" type="range" min="11" max="26" step="1">
        </div>
        <div class="bdm-field">
          <label class="bdm-label">面板不透明度 <span data-role="opacityValue">88%</span></label>
          <input class="bdm-range" data-role="opacityRange" type="range" min="30" max="100" step="1">
        </div>
        <div class="bdm-field">
          <label class="bdm-label">画面内弹幕字号 <span data-role="dmFontValue">20px</span></label>
          <div class="bdm-seg" data-role="dmFontPresets">
            <button type="button" class="bdm-seg-btn" data-size="16">16</button>
            <button type="button" class="bdm-seg-btn" data-size="20">20</button>
            <button type="button" class="bdm-seg-btn" data-size="24">24</button>
            <button type="button" class="bdm-seg-btn" data-size="30">30</button>
            <button type="button" class="bdm-seg-btn" data-size="36">36</button>
          </div>
          <input class="bdm-range" data-role="dmFontRange" type="range" min="14" max="40" step="1">
        </div>
        <div class="bdm-field">
          <label class="bdm-label">画面内弹幕字重</label>
          <div class="bdm-seg" data-role="dmWeightGroup">
            <button type="button" class="bdm-seg-btn" data-weight="300">细</button>
            <button type="button" class="bdm-seg-btn" data-weight="400">常规</button>
            <button type="button" class="bdm-seg-btn" data-weight="500">中等</button>
            <button type="button" class="bdm-seg-btn" data-weight="700">加粗</button>
          </div>
        </div>
        <div class="bdm-field">
          <label class="bdm-label">画面内弹幕字体</label>
          <div class="bdm-font-grid" data-role="dmFontFamilyGroup">
            <button type="button" class="bdm-font-chip" data-font="system">系统默认</button>
            <button type="button" class="bdm-font-chip" data-font="yahei">微软雅黑</button>
            <button type="button" class="bdm-font-chip" data-font="simhei">黑体</button>
            <button type="button" class="bdm-font-chip" data-font="simsun">宋体</button>
            <button type="button" class="bdm-font-chip" data-font="kaiti">楷体</button>
            <button type="button" class="bdm-font-chip" data-font="sourcehan">思源黑体</button>
            <button type="button" class="bdm-font-chip" data-font="pingfang">苹方</button>
            <button type="button" class="bdm-font-chip" data-font="dengxian">等线</button>
            <button type="button" class="bdm-font-chip" data-font="fangsong">仿宋</button>
            <button type="button" class="bdm-font-chip" data-font="stxihei">华文细黑</button>
            <button type="button" class="bdm-font-chip" data-font="sourcehanserif">思源宋体</button>
            <button type="button" class="bdm-font-chip" data-font="yaheiLight">雅黑细体</button>
          </div>
        </div>
        <div class="bdm-field">
          <label class="bdm-label">画面内弹幕不透明度 <span data-role="dmOpacityValue">100%</span></label>
          <input class="bdm-range" data-role="dmOpacityRange" type="range" min="20" max="100" step="5">
        </div>
        <div class="bdm-field">
          <label class="bdm-label">画面内弹幕阴影 <span data-role="dmShadowValue">中</span></label>
          <input class="bdm-range" data-role="dmShadowRange" type="range" min="0" max="3" step="1">
        </div>
        <div class="bdm-field">
          <label class="bdm-label">弹幕滚动时长 <span data-role="dmSpeedValue">12 秒</span>（越大越慢）</label>
          <input class="bdm-range" data-role="dmSpeedRange" type="range" min="4" max="20" step="1">
        </div>
        <div class="bdm-field">
          <label class="bdm-label">弹幕颜色</label>
          <div class="bdm-seg" data-role="dmColorGroup">
            <button type="button" class="bdm-seg-btn" data-color-mode="original">跟随 B 站</button>
            <button type="button" class="bdm-seg-btn" data-color-mode="white">白色</button>
            <button type="button" class="bdm-seg-btn" data-color-mode="custom">自定义</button>
          </div>
          <div class="bdm-row bdm-color-row">
            <input class="bdm-color" data-role="dmColorPicker" type="color" value="#ffffff">
            <span class="bdm-color-hint">选择「自定义」后可取色</span>
          </div>
        </div>
        <div class="bdm-field">
          <label class="bdm-label">弹幕密度 <span data-role="dmDensityValue">100%</span></label>
          <input class="bdm-range" data-role="dmDensityRange" type="range" min="10" max="100" step="5">
        </div>
        <div class="bdm-field">
          <label class="bdm-label">显示区域</label>
          <div class="bdm-seg" data-role="dmAreaGroup">
            <button type="button" class="bdm-seg-btn" data-area="full">全屏</button>
            <button type="button" class="bdm-seg-btn" data-area="half">上半屏</button>
            <button type="button" class="bdm-seg-btn" data-area="quarter">上四分之一</button>
          </div>
        </div>
        <div class="bdm-field">
          <label class="bdm-label" for="bdm-offset-input">延迟（秒，0 – 600，可输入小数）</label>
          <input id="bdm-offset-input" class="bdm-input" data-role="offsetInput" type="number" min="0" max="600" step="0.1">
        </div>
        <label class="bdm-check"><input type="checkbox" data-role="scCheck"> 显示醒目留言（SC）</label>
        <div class="bdm-row">
          <button class="bdm-btn" data-act="copy-diag">复制诊断</button>
          <button class="bdm-btn" data-act="clear">清空弹幕</button>
          <button class="bdm-btn" data-act="reset-pos">重置面板位置</button>
        </div>
        <div class="bdm-diag" data-role="diag"></div>
        <p class="bdm-hint">
          默认在直播画面里显示弹幕；如果画面内没有出现，说明没定位到视频，会自动改用右侧列表。<br>
          抖音比 B 站慢几秒，就把延迟调高几秒。快捷键：Alt+[ / Alt+] 微调 0.2 秒，Alt+B 显示 / 隐藏面板。
        </p>
      </div>
    </div>
  `;

  let settings = cloneSettings(DEFAULTS);
  const queue = [];
  let port = null;
  let keepAliveTimer = null;
  let wantConnect = false;
  let currentStatus = { phase: 'idle', text: '未连接' };
  let saveTimer = null;
  let resizeSaveTimer = null;
  let dragState = null;
  let settingsOpen = false;
  let root = null;
  let dmLayer = null;
  let lastDanmakuAt = 0;
  let lastError = null;
  let lastHost = '';
  let lastSource = '';
  let lastTransport = '';
  let lastTokenLength = 0;
  let networkReceived = 0;
  let currentRoomTitle = '';
  const statSamples = [];
  let lastStat = { net: 0, shown: 0, dropped: 0 };
  let statTimer = null;
  let frame = null;
  let frameWindow = null;
  let frameReady = false;
  let frameToken = '';
  let frameTimeoutTimer = null;
  let pingTimer = null;
  let lastPongAt = 0;
  let frameHealth = null;
  let transportMode = 'pending'; // pending | frame | port
  let tickTimer = null;
  let diagTimer = null;
  let watchTimer = null;
  const el = {};

  /* ---------------- 工具函数 ---------------- */

  function cloneSettings(source) {
    return {
      ...source,
      panel: { ...(source.panel || {}) },
    };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeRoom(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    const fromUrl = text.match(/live\.bilibili\.com\/(?:blanc\/)?(\d+)/i);
    if (fromUrl) return fromUrl[1];
    const digits = text.match(/\d{1,12}/);
    return digits ? digits[0] : '';
  }

  function readableColor(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return '#f2f3f7';
    const red = (number >> 16) & 255;
    const green = (number >> 8) & 255;
    const blue = number & 255;
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    if (luminance >= 0.42) return `rgb(${red}, ${green}, ${blue})`;
    const lighten = (channel) => Math.round(channel + (255 - channel) * 0.72);
    return `rgb(${lighten(red)}, ${lighten(green)}, ${lighten(blue)})`;
  }

  function formatSeconds(ms) {
    return (ms / 1000).toFixed(1);
  }

  async function copyText(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // 退回到 execCommand
    }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      area.style.pointerEvents = 'none';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }

  /* ---------------- 存储 ---------------- */

  async function loadSettings() {
    let stored = {};
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      stored = result?.[STORAGE_KEY] || {};
    } catch {
      // 扩展上下文失效时使用默认值
    }
    settings = cloneSettings({
      ...DEFAULTS,
      ...stored,
      panel: { ...DEFAULTS.panel, ...(stored.panel || {}) },
    });
    settings.offsetMs = clamp(Math.round(Number(settings.offsetMs) || 0), 0, MAX_OFFSET);
    settings.fontSize = clamp(Math.round(Number(settings.fontSize) || DEFAULTS.fontSize), 11, 26);
    settings.dmFontSize = clamp(Math.round(Number(settings.dmFontSize) || DEFAULTS.dmFontSize), 14, 40);
    settings.dmSpeed = clamp(Math.round(Number(settings.dmSpeed) || DEFAULTS.dmSpeed), 4, 20);
    settings.dmOpacity = clamp(Number(settings.dmOpacity) || DEFAULTS.dmOpacity, 0.2, 1);
    settings.dmShadow = Number.isFinite(Number(settings.dmShadow))
      ? clamp(Math.round(Number(settings.dmShadow)), 0, 3)
      : DEFAULTS.dmShadow;
    if (!FONT_STACKS[settings.dmFontFamily]) settings.dmFontFamily = DEFAULTS.dmFontFamily;
    settings.dmFontWeight = [300, 400, 500, 600, 700].includes(Number(settings.dmFontWeight))
      ? Number(settings.dmFontWeight)
      : DEFAULTS.dmFontWeight;
    settings.savedRooms = Array.isArray(settings.savedRooms)
      ? settings.savedRooms
          .filter((room) => room && /^\d{1,12}$/.test(String(room.roomId)))
          .map((room) => ({ roomId: String(room.roomId), title: String(room.title || '').slice(0, 60) }))
          .slice(0, 10)
      : [];
    if (!settings.savedRooms.length && settings.roomId) {
      settings.savedRooms = [{ roomId: settings.roomId, title: '' }];
    }
    settings.dmDensity = clamp(Math.round(Number(settings.dmDensity) || DEFAULTS.dmDensity), 10, 100);
    if (!['original', 'white', 'custom'].includes(settings.dmColorMode)) {
      settings.dmColorMode = DEFAULTS.dmColorMode;
    }
    if (!/^#[0-9a-f]{6}$/i.test(String(settings.dmColor))) settings.dmColor = DEFAULTS.dmColor;
    if (!['full', 'half', 'quarter'].includes(settings.dmArea)) settings.dmArea = DEFAULTS.dmArea;
    settings.opacity = clamp(Number(settings.opacity) || DEFAULTS.opacity, 0.3, 1);
    if (!['overlay', 'panel', 'both'].includes(settings.displayMode)) {
      settings.displayMode = DEFAULTS.displayMode;
    }
  }

  function persist(patch = {}) {
    settings = { ...settings, ...patch };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        chrome.storage.local.set({ [STORAGE_KEY]: settings });
      } catch {
        // 忽略
      }
    }, 250);
  }

  /* ---------------- 界面搭建 ---------------- */

  function mountRoot() {
    const container = document.fullscreenElement || document.webkitFullscreenElement || document.body || document.documentElement;
    if (root && root.parentNode !== container) container.appendChild(root);
  }

  function buildUI() {
    // 扩展更新后重新注入时，先移除旧脚本留下的界面
    document.getElementById('bdm-root')?.remove();
    root = document.createElement('div');
    root.id = 'bdm-root';
    root.innerHTML = TEMPLATE;
    mountRoot();

    el.panel = root.querySelector('[data-role="panel"]');
    el.head = root.querySelector('[data-role="head"]');
    el.dot = root.querySelector('[data-role="dot"]');
    el.roomLabel = root.querySelector('[data-role="roomLabel"]');
    el.collapseBtn = root.querySelector('[data-role="collapseBtn"]');
    el.body = root.querySelector('[data-role="body"]');
    el.list = root.querySelector('[data-role="list"]');
    el.settings = root.querySelector('[data-role="settings"]');
    el.offsetRange = root.querySelector('[data-role="offsetRange"]');
    el.offsetLabel = root.querySelector('[data-role="offsetLabel"]');
    el.queueLabel = root.querySelector('[data-role="queueLabel"]');
    el.statusLabel = root.querySelector('[data-role="statusLabel"]');
    el.roomInput = root.querySelector('[data-role="roomInput"]');
    el.fontRange = root.querySelector('[data-role="fontRange"]');
    el.fontValue = root.querySelector('[data-role="fontValue"]');
    el.opacityRange = root.querySelector('[data-role="opacityRange"]');
    el.opacityValue = root.querySelector('[data-role="opacityValue"]');
    el.offsetInput = root.querySelector('[data-role="offsetInput"]');
    el.scCheck = root.querySelector('[data-role="scCheck"]');
    el.alert = root.querySelector('[data-role="alert"]');
    el.alertText = root.querySelector('[data-role="alertText"]');
    el.alertBtn = root.querySelector('[data-role="alertBtn"]');
    el.modeGroup = root.querySelector('[data-role="modeGroup"]');
    el.dmFontRange = root.querySelector('[data-role="dmFontRange"]');
    el.dmFontValue = root.querySelector('[data-role="dmFontValue"]');
    el.dmFontPresets = root.querySelector('[data-role="dmFontPresets"]');
    el.dmFontFamilyGroup = root.querySelector('[data-role="dmFontFamilyGroup"]');
    el.dmWeightGroup = root.querySelector('[data-role="dmWeightGroup"]');
    el.savedRooms = root.querySelector('[data-role="savedRooms"]');
    el.dmSpeedRange = root.querySelector('[data-role="dmSpeedRange"]');
    el.dmSpeedValue = root.querySelector('[data-role="dmSpeedValue"]');
    el.dmOpacityRange = root.querySelector('[data-role="dmOpacityRange"]');
    el.dmOpacityValue = root.querySelector('[data-role="dmOpacityValue"]');
    el.dmShadowRange = root.querySelector('[data-role="dmShadowRange"]');
    el.dmShadowValue = root.querySelector('[data-role="dmShadowValue"]');
    el.dmColorGroup = root.querySelector('[data-role="dmColorGroup"]');
    el.dmColorPicker = root.querySelector('[data-role="dmColorPicker"]');
    el.dmColorHint = root.querySelector('.bdm-color-hint');
    el.dmDensityRange = root.querySelector('[data-role="dmDensityRange"]');
    el.dmDensityValue = root.querySelector('[data-role="dmDensityValue"]');
    el.dmAreaGroup = root.querySelector('[data-role="dmAreaGroup"]');
    el.diag = root.querySelector('[data-role="diag"]');

    for (const chip of el.dmFontFamilyGroup.querySelectorAll('[data-font]')) {
      const stack = FONT_STACKS[chip.dataset.font];
      if (stack) chip.style.fontFamily = stack;
    }

    bindEvents();
    observeResize();
  }

  function applyAllSettings() {
    applyTypography();
    applyPanelBox();
    if (settings.collapsed) setCollapsed(true, false);

    el.roomInput.value = settings.roomId;
    el.fontRange.value = String(settings.fontSize);
    el.fontValue.textContent = `${settings.fontSize}px`;
    el.opacityRange.value = String(Math.round(settings.opacity * 100));
    el.opacityValue.textContent = `${Math.round(settings.opacity * 100)}%`;
    el.dmFontRange.value = String(settings.dmFontSize);
    el.dmFontValue.textContent = `${settings.dmFontSize}px`;
    applyFontPresetUI();
    applyFontFamilyUI();
    applyFontWeightUI();
    el.dmSpeedRange.value = String(settings.dmSpeed);
    el.dmSpeedValue.textContent = `${settings.dmSpeed} 秒`;
    el.dmOpacityRange.value = String(Math.round(settings.dmOpacity * 100));
    el.dmOpacityValue.textContent = `${Math.round(settings.dmOpacity * 100)}%`;
    el.dmShadowRange.value = String(settings.dmShadow);
    el.dmShadowValue.textContent = SHADOW_LABELS[settings.dmShadow];
    el.dmColorPicker.value = settings.dmColor;
    el.dmColorPicker.disabled = settings.dmColorMode !== 'custom';
    el.dmDensityRange.value = String(settings.dmDensity);
    el.dmDensityValue.textContent = `${settings.dmDensity}%`;
    el.scCheck.checked = Boolean(settings.showSC);
    updateOffsetUI();
    updateQueueLabel();
    applyModeUI();
    applyAreaUI();
    applyColorModeUI();
    dmLayer?.setEnabled(settings.displayMode !== 'panel');
    dmLayer?.setFontSize(settings.dmFontSize);
    dmLayer?.setSpeed(settings.dmSpeed);
    dmLayer?.setOpacity(settings.dmOpacity);
    dmLayer?.setShadow(settings.dmShadow);
    dmLayer?.setFontFamily(FONT_STACKS[settings.dmFontFamily] || FONT_STACKS.system);
    dmLayer?.setFontWeight(settings.dmFontWeight);
    dmLayer?.setColorMode(settings.dmColorMode, settings.dmColor);
    dmLayer?.setDensity(settings.dmDensity);
    dmLayer?.setAreaRatio(areaRatio(settings.dmArea));
    syncLayout();
    renderSavedRooms();

    root.style.display = settings.hidden ? 'none' : '';
  }

  function applyTypography() {
    root.style.setProperty('--bdm-font', `${settings.fontSize}px`);
    root.style.setProperty('--bdm-opacity', settings.opacity.toFixed(2));
    el.fontValue.textContent = `${settings.fontSize}px`;
    el.opacityValue.textContent = `${Math.round(settings.opacity * 100)}%`;
  }

  function applyPanelBox() {
    const panel = settings.panel;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const width = clamp(Number(panel.w) || 360, 240, Math.max(280, viewportWidth - 20));
    const height = clamp(Number(panel.h) || 340, 140, Math.max(200, viewportHeight - 20));
    let x = panel.x == null ? viewportWidth - width - 24 : Number(panel.x);
    let y = panel.y == null ? 96 : Number(panel.y);
    x = clamp(x, -width + 90, viewportWidth - 90);
    y = clamp(y, 0, viewportHeight - 48);

    root.style.left = `${Math.round(x)}px`;
    root.style.top = `${Math.round(y)}px`;

    panel.x = Math.round(x);
    panel.y = Math.round(y);
    panel.w = Math.round(width);
    panel.h = Math.round(height);

    if (!settings.collapsed) {
      el.panel.style.width = `${panel.w}px`;
      el.panel.style.height = root.classList.contains('has-list') ? `${panel.h}px` : '';
    }
  }

  function resetPanelPosition() {
    settings.panel.x = null;
    settings.panel.y = 96;
    settings.panel.w = 360;
    settings.panel.h = 340;
    applyPanelBox();
    persist();
  }

  function applyModeUI() {
    if (!el.modeGroup) return;
    for (const button of el.modeGroup.querySelectorAll('[data-mode]')) {
      button.classList.toggle('is-active', button.dataset.mode === settings.displayMode);
    }
  }

  function areaRatio(area) {
    if (area === 'half') return 0.5;
    if (area === 'quarter') return 0.25;
    return 1;
  }

  function applyAreaUI() {
    if (!el.dmAreaGroup) return;
    for (const button of el.dmAreaGroup.querySelectorAll('[data-area]')) {
      button.classList.toggle('is-active', button.dataset.area === settings.dmArea);
    }
  }

  function applyFontFamilyUI() {
    if (!el.dmFontFamilyGroup) return;
    for (const button of el.dmFontFamilyGroup.querySelectorAll('[data-font]')) {
      button.classList.toggle('is-active', button.dataset.font === settings.dmFontFamily);
    }
  }

  function applyFontWeightUI() {
    if (!el.dmWeightGroup) return;
    for (const button of el.dmWeightGroup.querySelectorAll('[data-weight]')) {
      button.classList.toggle('is-active', Number(button.dataset.weight) === settings.dmFontWeight);
    }
  }

  function setDanmakuWeight(value) {
    const weight = Number(value);
    if (![300, 400, 500, 600, 700].includes(weight)) return;
    settings.dmFontWeight = weight;
    applyFontWeightUI();
    dmLayer?.setFontWeight(weight);
    persist();
  }

  function setDanmakuFont(fontKey) {
    if (!FONT_STACKS[fontKey]) return;
    settings.dmFontFamily = fontKey;
    applyFontFamilyUI();
    dmLayer?.setFontFamily(FONT_STACKS[fontKey]);
    persist();
  }

  function truncateText(text, max) {
    const value = String(text || '');
    return value.length > max ? `${value.slice(0, max)}…` : value;
  }

  function renderSavedRooms() {
    if (!el.savedRooms) return;
    const rooms = Array.isArray(settings.savedRooms) ? settings.savedRooms : [];
    el.savedRooms.replaceChildren();

    if (!rooms.length) {
      const empty = document.createElement('span');
      empty.className = 'bdm-saved-empty';
      empty.textContent = '连接过的直播间会自动保存在这里';
      el.savedRooms.appendChild(empty);
      return;
    }

    for (const room of rooms) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'bdm-saved-chip';
      chip.dataset.roomId = room.roomId;
      chip.title = room.title ? `${room.title}（#${room.roomId}）` : `B 站直播间 #${room.roomId}`;

      const label = document.createElement('span');
      label.className = 'bdm-saved-name';
      label.textContent = room.title ? `${truncateText(room.title, 12)} · ${room.roomId}` : `#${room.roomId}`;

      const remove = document.createElement('span');
      remove.className = 'bdm-saved-remove';
      remove.dataset.removeRoom = room.roomId;
      remove.title = '从保存列表移除';
      remove.textContent = '×';

      chip.append(label, remove);
      el.savedRooms.appendChild(chip);
    }
  }

  function rememberRoom(roomId) {
    if (!roomId) return;
    const list = (settings.savedRooms || []).filter((room) => room.roomId !== roomId);
    list.unshift({ roomId, title: roomId === settings.roomId ? currentRoomTitle : '' });
    settings.savedRooms = list.slice(0, 10);
    persist();
    renderSavedRooms();
  }

  function removeSavedRoom(roomId) {
    settings.savedRooms = (settings.savedRooms || []).filter((room) => room.roomId !== roomId);
    persist();
    renderSavedRooms();
  }

  function updateSavedRoomTitle(roomId, title) {
    if (!roomId || !title) return;
    const room = (settings.savedRooms || []).find((item) => item.roomId === roomId);
    if (!room || room.title === title) return;
    room.title = title;
    persist();
    renderSavedRooms();
  }

  function applyFontPresetUI() {
    if (!el.dmFontPresets) return;
    for (const button of el.dmFontPresets.querySelectorAll('[data-size]')) {
      button.classList.toggle('is-active', Number(button.dataset.size) === settings.dmFontSize);
    }
  }

  function setFontSize(value) {
    settings.dmFontSize = clamp(Math.round(Number(value) || DEFAULTS.dmFontSize), 14, 40);
    el.dmFontRange.value = String(settings.dmFontSize);
    el.dmFontValue.textContent = `${settings.dmFontSize}px`;
    applyFontPresetUI();
    dmLayer?.setFontSize(settings.dmFontSize);
    persist();
  }

  function applyColorModeUI() {
    if (!el.dmColorGroup) return;
    for (const button of el.dmColorGroup.querySelectorAll('[data-color-mode]')) {
      button.classList.toggle('is-active', button.dataset.colorMode === settings.dmColorMode);
    }
    if (el.dmColorHint) {
      el.dmColorHint.textContent =
        settings.dmColorMode === 'custom' ? '点击左侧色块选择颜色' : '选择「自定义」后可取色';
    }
  }

  function setColorMode(mode) {
    if (!['original', 'white', 'custom'].includes(mode)) return;
    settings.dmColorMode = mode;
    el.dmColorPicker.disabled = mode !== 'custom';
    applyColorModeUI();
    dmLayer?.setColorMode(mode, settings.dmColor);
    persist();
  }

  function displayColor(color) {
    if (settings.dmColorMode === 'white') return '#f2f3f7';
    if (settings.dmColorMode === 'custom') return settings.dmColor;
    return readableColor(color);
  }

  function syncLayout() {
    if (!root || !el.panel) return;
    const overlayReady = Boolean(dmLayer && dmLayer.isReady());
    const showList =
      settings.displayMode === 'panel' ||
      settings.displayMode === 'both' ||
      (settings.displayMode === 'overlay' && !overlayReady);

    root.dataset.mode = settings.displayMode;
    root.classList.toggle('has-list', showList);

    if (!settings.collapsed) {
      el.panel.style.height = showList ? `${settings.panel.h}px` : '';
    }
  }

  function applyDisplayMode(mode) {
    if (!['overlay', 'panel', 'both'].includes(mode)) return;
    settings.displayMode = mode;
    persist({ displayMode: mode });
    applyModeUI();
    dmLayer?.setEnabled(mode !== 'panel');
    syncLayout();
  }

  function setCollapsed(collapsed, save = true) {
    settings.collapsed = collapsed;
    root.classList.toggle('is-collapsed', collapsed);
    el.collapseBtn.textContent = collapsed ? '\u25B8' : '\u25BE';

    if (collapsed) {
      el.panel.style.width = '';
      el.panel.style.height = '';
      setSettingsOpen(false);
    } else {
      el.panel.style.width = `${settings.panel.w}px`;
      syncLayout();
    }
    if (save) persist();
  }

  function setHidden(hidden) {
    settings.hidden = hidden;
    root.style.display = hidden ? 'none' : '';
    persist();
  }

  function setSettingsOpen(open) {
    settingsOpen = open;
    el.settings.hidden = !open;
    el.body.hidden = open;
    if (open) {
      el.roomInput.focus({ preventScroll: true });
      renderDiagnostics();
    }
  }

  /* ---------------- 延迟与队列 ---------------- */

  function setOffset(ms) {
    settings.offsetMs = clamp(Math.round(Number(ms) || 0), 0, MAX_OFFSET);
    updateOffsetUI();
    persist({ offsetMs: settings.offsetMs });
  }

  function updateOffsetUI() {
    const seconds = settings.offsetMs / 1000;
    el.offsetLabel.textContent = settings.offsetMs === 0 ? '延迟 0.0s（实时）' : `延迟 ${formatSeconds(settings.offsetMs)}s`;
    el.offsetRange.value = String(Math.min(settings.offsetMs, Number(el.offsetRange.max)));
    if (document.activeElement !== el.offsetInput) {
      el.offsetInput.value = seconds.toFixed(1);
    }
  }

  function updateQueueLabel() {
    const pending = queue.length;
    el.queueLabel.textContent = pending > 0 ? `缓冲 ${pending} 条` : '缓冲 0';
  }

  function enqueue(items) {
    let added = 0;
    const now = Date.now();
    for (const item of items) {
      if (!item || !item.text) continue;
      if (item.kind === 'sc' && !settings.showSC) continue;
      queue.push({
        kind: item.kind || 'danmaku',
        user: item.user || '',
        text: prettifyText(item.text),
        color: item.color || 0,
        price: item.price || 0,
        recvAt: now,
      });
      added += 1;
    }
    if (queue.length > MAX_QUEUE) {
      queue.splice(0, queue.length - MAX_QUEUE);
    }
    updateQueueLabel();
    if (added) {
      lastDanmakuAt = now;
      if (settings.offsetMs === 0) flushQueue();
    }
  }

  function flushQueue() {
    if (!queue.length) return;
    const now = Date.now();
    const delay = settings.offsetMs;
    const due = [];
    while (queue.length && due.length < 60 && queue[0].recvAt + delay <= now) {
      due.push(queue.shift());
    }
    if (due.length) {
      if (root.classList.contains('has-list')) appendRows(due);
      dmLayer?.show(due);
    }
    updateQueueLabel();
  }

  function renderRow(item) {
    const row = document.createElement('div');
    row.className = item.kind === 'sc' ? 'bdm-item bdm-item-sc' : 'bdm-item';

    if (item.kind === 'sc') {
      const badge = document.createElement('span');
      badge.className = 'bdm-price';
      badge.textContent = `\u00A5${item.price || ''}`;
      row.appendChild(badge);
    }

    const name = document.createElement('span');
    name.className = 'bdm-name';
    name.textContent = item.user || '匿名';

    const text = document.createElement('span');
    text.className = 'bdm-text';
    text.textContent = item.text;
    if (item.kind !== 'sc') text.style.color = displayColor(item.color);

    row.append(name, text);
    return row;
  }

  function appendRows(items) {
    const list = el.list;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 64;
    const fragment = document.createDocumentFragment();
    for (const item of items) fragment.appendChild(renderRow(item));
    list.appendChild(fragment);

    while (list.children.length > MAX_LINES) list.firstElementChild.remove();
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }

  function clearList() {
    queue.length = 0;
    el.list.replaceChildren();
    updateQueueLabel();
  }

  /* ---------------- 与后台通信 ---------------- */

  function showAlert(text, action, label, kind = 'error') {
    el.alertText.textContent = text;
    el.alert.dataset.action = action;
    el.alert.dataset.kind = kind;
    el.alertBtn.textContent = label;
    el.alert.hidden = false;
  }

  function hideAlert() {
    el.alert.hidden = true;
  }

  function setStatus(phase, text, meta = {}) {
    currentStatus = { phase, text };
    el.dot.dataset.phase = phase;
    el.dot.title = text;
    el.statusLabel.textContent = text;
    el.statusLabel.title = text;

    if (meta.realRoomId || meta.roomId) {
      const label = meta.realRoomId || meta.roomId;
      el.roomLabel.textContent = `#${label}`;
      el.roomLabel.title = `B 站直播间 ${label}`;
    } else if (phase === 'idle') {
      el.roomLabel.textContent = '';
    }

    if (phase === 'error') {
      showAlert(lastError?.message || text, 'retry', '重试');
      console.warn('[B站弹幕]', lastError || text);
    } else if (phase === 'idle') {
      if (settings.roomId) showAlert('已断开连接', 'retry', '重新连接', 'info');
      else showAlert('未连接：点开设置填写 B 站房间号', 'settings', '填写房间号', 'info');
    } else if (phase !== 'connected' && lastError) {
      showAlert(lastError.message, 'retry', '重试');
    } else {
      hideAlert();
      if (phase === 'connected') console.info('[B站弹幕] 已连接', meta.realRoomId || meta.roomId || '');
    }
  }

  function onPortMessage(message) {
    handleTransportMessage(message);
  }

  function handleTransportMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'status') {
      if (message.error) lastError = message.error;
      if (message.phase === 'connected') lastError = null;
      if (message.host) lastHost = message.host;
      if (message.source) lastSource = message.source;
      if (message.transport) lastTransport = message.transport;
      if (typeof message.tokenLength === 'number') lastTokenLength = message.tokenLength;
      if (message.roomTitle) {
        currentRoomTitle = message.roomTitle;
        const statusRoom = String(message.realRoomId || message.roomId || settings.roomId || '');
        if (statusRoom) updateSavedRoomTitle(statusRoom, message.roomTitle);
      }
      setStatus(message.phase || 'connecting', message.text || '', message);
    } else if (message.type === 'danmaku' && Array.isArray(message.items)) {
      networkReceived += message.items.length;
      enqueue(message.items);
    }
  }

  /* ---------- 扩展 iframe 连接宿主 ---------- */

  function createFrameTransport() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
      transportMode = 'port';
      return;
    }
    try {
      document.getElementById('bdm-frame-host')?.remove();
      frameToken = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

      const iframe = document.createElement('iframe');
      iframe.id = 'bdm-frame-host';
      iframe.src = chrome.runtime.getURL(`frame.html?token=${encodeURIComponent(frameToken)}`);
      // 放在视口内 2x2 的透明区域：避免被浏览器当成隐藏 iframe 节流定时器
      iframe.style.cssText =
        'position:fixed;left:0;bottom:0;width:2px;height:2px;border:0;opacity:0.01;pointer-events:none;z-index:-2147483647;';
      iframe.setAttribute('aria-hidden', 'true');
      iframe.setAttribute('tabindex', '-1');

      window.addEventListener('message', onFrameMessage);
      document.body.appendChild(iframe);
      frame = iframe;
      frameWindow = iframe.contentWindow;

      frameTimeoutTimer = setTimeout(() => {
        if (frameReady) return;
        console.warn('[B站弹幕] 连接宿主 iframe 未就绪，回退到后台连接');
        transportMode = 'port';
        if (wantConnect && settings.roomId) connectViaPort(settings.roomId);
      }, 4000);
    } catch (error) {
      console.warn('[B站弹幕] 无法创建连接宿主 iframe', error);
      transportMode = 'port';
    }
  }

  function frameSend(type, extra = {}) {
    try {
      frameWindow?.postMessage({ source: 'bdm-overlay', token: frameToken, type, ...extra }, '*');
    } catch {
      // iframe 已失效
    }
  }

  function onFrameMessage(event) {
    if (!frameWindow || event.source !== frameWindow) return;
    const data = event.data;
    if (!data || data.source !== 'bdm-frame' || data.token !== frameToken) return;

    if (data.type === 'ready') {
      frameReady = true;
      clearTimeout(frameTimeoutTimer);
      transportMode = 'frame';
      lastTransport = 'frame';
      lastPongAt = Date.now();
      // 页面侧定时保活：隐藏 iframe 里的定时器可能被节流，
      // 由可见的内容脚本每 15 秒推一次心跳/重连检查。
      if (!pingTimer) pingTimer = setInterval(framePing, 15000);
      // 如果之前已经用后台端口连上，切换过来，避免双份弹幕
      try {
        port?.postMessage({ type: 'unsubscribe' });
      } catch {
        // 忽略
      }
      if (wantConnect && settings.roomId) {
        frameSend('connect', { roomKey: settings.roomId });
        setStatus('connecting', '正在连接…', { roomId: settings.roomId });
      }
    } else if (data.type === 'event' && data.event) {
      handleTransportMessage({ ...data.event, transport: 'frame' });
    } else if (data.type === 'pong') {
      lastPongAt = Date.now();
      frameHealth = Array.isArray(data.states) && data.states[0] ? data.states[0] : null;
    }
  }

  function framePing() {
    if (!frameReady || transportMode !== 'frame') return;
    if (lastPongAt && Date.now() - lastPongAt > 45000) {
      console.warn('[B站弹幕] 连接宿主无响应，重建 iframe');
      recreateFrame();
      return;
    }
    frameSend('ping');
  }

  function recreateFrame() {
    try {
      frame?.remove();
    } catch {
      // 忽略
    }
    frame = null;
    frameWindow = null;
    frameReady = false;
    frameHealth = null;
    lastPongAt = 0;
    transportMode = 'pending';
    clearInterval(pingTimer);
    pingTimer = null;
    createFrameTransport();
  }

  function ensurePort() {
    if (port) return port;
    try {
      port = chrome.runtime.connect({ name: 'bdm' });
    } catch {
      setStatus('error', '扩展已更新，请刷新页面');
      return null;
    }

    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      if (wantConnect) {
        setStatus('reconnecting', '后台服务重连中…');
        setTimeout(() => {
          if (wantConnect && !port) connectToRoom(settings.roomId);
        }, 1200);
      }
    });

    keepAliveTimer = setInterval(() => {
      try {
        port?.postMessage({ type: 'ping' });
      } catch {
        // 端口已断开
      }
    }, 20000);

    return port;
  }

  function connectViaPort(roomId) {
    const socket = ensurePort();
    if (!socket) return false;
    socket.postMessage({ type: 'subscribe', roomId });
    lastTransport = 'port';
    setStatus('connecting', '正在连接…', { roomId });
    return true;
  }

  function connectToRoom(roomId) {
    const normalized = normalizeRoom(roomId);
    if (!normalized) {
      setStatus('error', '请输入正确的 B 站房间号');
      return false;
    }

    if (settings.roomId && settings.roomId !== normalized) {
      clearList();
      currentRoomTitle = '';
    }
    settings.roomId = normalized;
    el.roomInput.value = normalized;
    wantConnect = true;
    lastError = null;
    lastHost = '';
    lastSource = '';
    persist({ roomId: normalized, wantConnected: true });
    el.roomLabel.textContent = `#${normalized}`;
    rememberRoom(normalized);

    if (transportMode === 'frame' && frameReady) {
      lastTransport = 'frame';
      frameSend('connect', { roomKey: normalized });
      setStatus('connecting', '正在连接…', { roomId: normalized });
      return true;
    }

    if (transportMode === 'pending') {
      // 等连接宿主 iframe 就绪；超时会自动回退到后台端口
      setStatus('connecting', '正在准备连接…', { roomId: normalized });
      return true;
    }

    return connectViaPort(normalized);
  }

  function disconnect() {
    wantConnect = false;
    lastError = null;
    if (frameReady) frameSend('disconnect', { roomKey: settings.roomId });
    try {
      port?.postMessage({ type: 'unsubscribe' });
    } catch {
      // 忽略
    }
    setStatus('idle', '未连接');
    persist({ wantConnected: false });
  }

  function connectFromInput() {
    const roomId = normalizeRoom(el.roomInput.value);
    if (!roomId) {
      el.roomInput.focus();
      setStatus('error', '请输入正确的 B 站房间号');
      return;
    }
    connectToRoom(roomId);
    setSettingsOpen(false);
  }

  /* ---------------- 诊断 ---------------- */

  function recordStat() {
    const status = dmLayer ? dmLayer.getStatus() : null;
    if (!status) return;
    const sample = {
      net: Math.max(0, networkReceived - lastStat.net),
      shown: Math.max(0, status.shown - lastStat.shown),
      dropped: Math.max(0, status.dropped - lastStat.dropped),
    };
    lastStat = { net: networkReceived, shown: status.shown, dropped: status.dropped };
    statSamples.push(sample);
    if (statSamples.length > 10) statSamples.shift();
  }

  function renderDiagnostics() {    if (!el.diag || el.settings.hidden) return;
    const layerStatus = dmLayer ? dmLayer.getStatus() : null;
    const video = layerStatus && layerStatus.ready
      ? `已定位 ${layerStatus.width}×${layerStatus.height}`
      : '未找到';
    const last = lastDanmakuAt
      ? `${Math.max(0, Math.round((Date.now() - lastDanmakuAt) / 1000))} 秒前`
      : '暂无';
    const modeText = { overlay: '画面内', panel: '右侧列表', both: '两者' }[settings.displayMode] || settings.displayMode;
    const stats = layerStatus
      ? `网络收到 ${networkReceived} · 画面显示 ${layerStatus.shown} · 丢弃 ${layerStatus.dropped} · 队列 ${layerStatus.pending} · 缓冲 ${(layerStatus.lag / 1000).toFixed(1)}s（峰值 ${(layerStatus.maxLag / 1000).toFixed(1)}s）`
      : `网络收到 ${networkReceived}`;
    el.diag.textContent = [
      `状态：${currentStatus.text}`,
      `房间：${settings.roomId || '未填写'}`,
      `服务器：${lastHost || '—'}`,
      `接口：${lastSource || '—'}`,
      `Token：${lastTokenLength ? `${lastTokenLength} 位` : '空'}`,
      `连接方式：${
        lastTransport === 'frame'
          ? '扩展 iframe'
          : lastTransport === 'offscreen'
            ? 'offscreen 文档'
            : lastTransport === 'sw'
              ? '后台 Service Worker'
              : lastTransport === 'port'
                ? '后台端口'
                : '—'
      }`,
      `视频：${video}`,
      `链路：${
        frameHealth
          ? `WS ${frameHealth.wsState === 1 ? '在线' : '离线'} · ${
              frameHealth.lastFrameAgo >= 0
                ? `${Math.max(0, Math.round(frameHealth.lastFrameAgo / 1000))} 秒前有数据`
                : '暂无数据'
            }`
          : '—'
      }`,
      `最近弹幕：${last}`,
      `显示位置：${modeText}`,
      `弹幕统计：${stats}`,
      `分时（收到/显示/丢）：${statSamples.length ? statSamples.map((item) => `${item.net}/${item.shown}/${item.dropped}`).join(' · ') : '统计中…'}`,
      `上次错误：${lastError ? `${lastError.stage} · ${lastError.message}` : '无'}`,
      `版本：${VERSION}`,
    ].join('\n');
  }

  /* ---------------- 交互 ---------------- */

  function bindEvents() {
    root.addEventListener('pointerdown', (event) => event.stopPropagation());
    root.addEventListener('click', (event) => event.stopPropagation());
    el.list.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });

    root.addEventListener('click', (event) => {
      const button = event.target.closest('[data-act]');
      if (!button) return;
      const act = button.dataset.act;

      if (act === 'toggle-settings') {
        setSettingsOpen(!settingsOpen);
      } else if (act === 'collapse') {
        setCollapsed(!settings.collapsed);
      } else if (act === 'hide') {
        setHidden(true);
      } else if (act === 'connect') {
        connectFromInput();
      } else if (act === 'reconnect') {
        if (settings.roomId) connectToRoom(settings.roomId);
        else setSettingsOpen(true);
      } else if (act === 'alert-action') {
        if (el.alert.dataset.action === 'settings') setSettingsOpen(true);
        else if (settings.roomId) connectToRoom(settings.roomId);
        else setSettingsOpen(true);
      } else if (act === 'disconnect') {
        disconnect();
      } else if (act === 'copy-diag') {
        renderDiagnostics();
        copyText(el.diag.textContent || '').then((ok) => {
          button.textContent = ok ? '已复制' : '复制失败';
          setTimeout(() => {
            button.textContent = '复制诊断';
          }, 1500);
        });
      } else if (act === 'clear') {
        clearList();
      } else if (act === 'reset-pos') {
        resetPanelPosition();
      } else if (act === 'offset-reset') {
        setOffset(0);
      } else if (act.startsWith('off-minus-')) {
        setOffset(settings.offsetMs - Number(act.slice('off-minus-'.length)));
      } else if (act.startsWith('off-plus-')) {
        setOffset(settings.offsetMs + Number(act.slice('off-plus-'.length)));
      }
    });

    el.offsetRange.addEventListener('input', () => setOffset(Number(el.offsetRange.value)));

    el.offsetInput.addEventListener('change', () => {
      const seconds = Number(el.offsetInput.value);
      if (!Number.isFinite(seconds)) {
        updateOffsetUI();
        return;
      }
      setOffset(seconds * 1000);
      el.offsetInput.value = (settings.offsetMs / 1000).toFixed(1);
    });

    el.fontRange.addEventListener('input', () => {
      settings.fontSize = clamp(Number(el.fontRange.value) || DEFAULTS.fontSize, 11, 26);
      applyTypography();
      persist();
    });

    el.opacityRange.addEventListener('input', () => {
      settings.opacity = clamp((Number(el.opacityRange.value) || 88) / 100, 0.3, 1);
      applyTypography();
      persist();
    });

    el.dmFontRange.addEventListener('input', () => {
      setFontSize(el.dmFontRange.value);
    });

    el.dmFontPresets.addEventListener('click', (event) => {
      const button = event.target.closest('[data-size]');
      if (!button) return;
      setFontSize(button.dataset.size);
    });

    el.dmFontFamilyGroup.addEventListener('click', (event) => {
      const button = event.target.closest('[data-font]');
      if (!button) return;
      setDanmakuFont(button.dataset.font);
    });

    el.dmWeightGroup.addEventListener('click', (event) => {
      const button = event.target.closest('[data-weight]');
      if (!button) return;
      setDanmakuWeight(button.dataset.weight);
    });

    el.savedRooms.addEventListener('click', (event) => {
      const remove = event.target.closest('[data-remove-room]');
      if (remove) {
        removeSavedRoom(remove.dataset.removeRoom);
        return;
      }
      const chip = event.target.closest('[data-room-id]');
      if (!chip) return;
      const roomId = chip.dataset.roomId;
      el.roomInput.value = roomId;
      connectToRoom(roomId);
      setSettingsOpen(false);
    });

    el.dmSpeedRange.addEventListener('input', () => {
      settings.dmSpeed = clamp(Number(el.dmSpeedRange.value) || DEFAULTS.dmSpeed, 4, 20);
      el.dmSpeedValue.textContent = `${settings.dmSpeed} 秒`;
      dmLayer?.setSpeed(settings.dmSpeed);
      persist();
    });

    el.dmOpacityRange.addEventListener('input', () => {
      settings.dmOpacity = clamp((Number(el.dmOpacityRange.value) || 100) / 100, 0.2, 1);
      el.dmOpacityValue.textContent = `${Math.round(settings.dmOpacity * 100)}%`;
      dmLayer?.setOpacity(settings.dmOpacity);
      persist();
    });

    el.dmShadowRange.addEventListener('input', () => {
      settings.dmShadow = clamp(Math.round(Number(el.dmShadowRange.value) || 0), 0, 3);
      el.dmShadowValue.textContent = SHADOW_LABELS[settings.dmShadow];
      dmLayer?.setShadow(settings.dmShadow);
      persist();
    });

    el.dmColorGroup.addEventListener('click', (event) => {
      const button = event.target.closest('[data-color-mode]');
      if (!button) return;
      setColorMode(button.dataset.colorMode);
    });

    el.dmColorPicker.addEventListener('input', () => {
      settings.dmColor = el.dmColorPicker.value;
      if (settings.dmColorMode !== 'custom') {
        settings.dmColorMode = 'custom';
        el.dmColorPicker.disabled = false;
        applyColorModeUI();
      }
      dmLayer?.setColorMode('custom', settings.dmColor);
      persist();
    });

    el.dmDensityRange.addEventListener('input', () => {
      settings.dmDensity = clamp(Number(el.dmDensityRange.value) || DEFAULTS.dmDensity, 10, 100);
      el.dmDensityValue.textContent = `${settings.dmDensity}%`;
      dmLayer?.setDensity(settings.dmDensity);
      persist();
    });

    el.dmAreaGroup.addEventListener('click', (event) => {
      const button = event.target.closest('[data-area]');
      if (!button) return;
      settings.dmArea = button.dataset.area;
      applyAreaUI();
      dmLayer?.setAreaRatio(areaRatio(settings.dmArea));
      persist();
    });

    el.modeGroup.addEventListener('click', (event) => {
      const button = event.target.closest('[data-mode]');
      if (!button) return;
      applyDisplayMode(button.dataset.mode);
    });

    el.scCheck.addEventListener('change', () => {
      settings.showSC = el.scCheck.checked;
      persist();
    });

    el.roomInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        connectFromInput();
      }
    });

    bindDrag();
    bindKeyboard();

    document.addEventListener('fullscreenchange', mountRoot);
    document.addEventListener('webkitfullscreenchange', mountRoot);
    window.addEventListener('resize', applyPanelBox);
  }

  function bindDrag() {
    el.head.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const rect = root.getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        dx: event.clientX - rect.left,
        dy: event.clientY - rect.top,
      };
      el.head.setPointerCapture(event.pointerId);
      el.head.classList.add('is-dragging');
      event.preventDefault();
    });

    el.head.addEventListener('pointermove', (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      const rect = root.getBoundingClientRect();
      const x = clamp(event.clientX - dragState.dx, -rect.width + 90, window.innerWidth - 90);
      const y = clamp(event.clientY - dragState.dy, 0, window.innerHeight - 48);
      root.style.left = `${Math.round(x)}px`;
      root.style.top = `${Math.round(y)}px`;
    });

    const endDrag = (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      dragState = null;
      el.head.classList.remove('is-dragging');
      const rect = root.getBoundingClientRect();
      settings.panel.x = Math.round(rect.left);
      settings.panel.y = Math.round(rect.top);
      persist();
    };
    el.head.addEventListener('pointerup', endDrag);
    el.head.addEventListener('pointercancel', endDrag);
  }

  function bindKeyboard() {
    document.addEventListener('keydown', (event) => {
      if (!event.altKey) return;
      const target = event.target;
      if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return;

      if (event.code === 'BracketLeft') {
        setOffset(settings.offsetMs - 200);
        event.preventDefault();
      } else if (event.code === 'BracketRight') {
        setOffset(settings.offsetMs + 200);
        event.preventDefault();
      } else if (event.code === 'KeyB') {
        setHidden(!settings.hidden);
        event.preventDefault();
      }
    });
  }

  function observeResize() {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      if (settings.collapsed || !root.classList.contains('has-list')) return;
      const entry = entries[0];
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (width < 10 || height < 10) return;
      settings.panel.w = width;
      settings.panel.h = height;
      clearTimeout(resizeSaveTimer);
      resizeSaveTimer = setTimeout(() => persist(), 400);
    });
    observer.observe(el.panel);
  }

  /* ---------------- 来自 popup 的指令 ---------------- */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'bdmCmd') return undefined;

    if (message.cmd === 'getState') {
      sendResponse({
        ok: true,
        roomId: settings.roomId,
        offsetMs: settings.offsetMs,
        hidden: Boolean(settings.hidden),
        connected: wantConnect,
        status: currentStatus,
      });
    } else if (message.cmd === 'connect') {
      sendResponse({ ok: connectToRoom(message.roomId || settings.roomId) });
    } else if (message.cmd === 'disconnect') {
      disconnect();
      sendResponse({ ok: true });
    } else if (message.cmd === 'setOffset') {
      setOffset(message.value);
      sendResponse({ ok: true, offsetMs: settings.offsetMs });
    } else if (message.cmd === 'togglePanel') {
      setHidden(!settings.hidden);
      sendResponse({ ok: true, hidden: settings.hidden });
    } else if (message.cmd === 'clear') {
      clearList();
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false });
    }
    return undefined;
  });

  /* ---------------- 启动 ---------------- */

  function createDanmakuLayer() {
    if (!window.BdmDanmakuLayer) return null;
    try {
      return new window.BdmDanmakuLayer({ onAvailabilityChange: () => syncLayout() });
    } catch {
      return null;
    }
  }

  function dispose() {
    clearInterval(tickTimer);
    clearInterval(diagTimer);
    clearInterval(statTimer);
    clearInterval(watchTimer);
    clearInterval(keepAliveTimer);
    clearTimeout(saveTimer);
    clearTimeout(resizeSaveTimer);
    clearTimeout(frameTimeoutTimer);
    clearInterval(pingTimer);
    pingTimer = null;
    tickTimer = null;
    diagTimer = null;
    statTimer = null;
    watchTimer = null;
    keepAliveTimer = null;
    wantConnect = false;

    try {
      document.getElementById('bdm-frame-host')?.remove();
    } catch {
      // 忽略
    }
    frame = null;
    frameWindow = null;
    frameReady = false;
    transportMode = 'pending';

    try {
      port?.disconnect();
    } catch {
      // 忽略
    }
    port = null;

    try {
      dmLayer?.destroy();
    } catch {
      // 忽略
    }
    dmLayer = null;

    try {
      root?.remove();
    } catch {
      // 忽略
    }
    root = null;
    document.getElementById('bdm-dm-layer')?.remove();
  }

  window.__bdmDispose = dispose;

  async function init() {
    await loadSettings();
    dmLayer = createDanmakuLayer();
    buildUI();
    applyAllSettings();
    createFrameTransport();

    tickTimer = setInterval(flushQueue, TICK);
    diagTimer = setInterval(renderDiagnostics, 1500);
    statTimer = setInterval(recordStat, 60000);
    watchTimer = setInterval(() => {
      if (root && !root.isConnected) {
        mountRoot();
        applyPanelBox();
      }
      if (frame && !frame.isConnected) {
        console.warn('[B站弹幕] 连接宿主被页面移除，重建');
        recreateFrame();
      }
    }, 3000);

    if (settings.wantConnected && settings.roomId) {
      connectToRoom(settings.roomId);
    } else {
      setStatus('idle', '未连接');
    }
    console.info('[B站弹幕] 已启动', VERSION);
  }

  init();
})();
