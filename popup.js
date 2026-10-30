/* popup：把操作转发给当前抖音页面里的浮层 */

const $ = (id) => document.getElementById(id);

let tabId = null;
let offsetMs = 0;
let available = false;

async function injectContentScript() {
  if (!tabId) return false;
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['danmaku-layer.js', 'content.js'],
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    return true;
  } catch {
    return false;
  }
}

async function send(cmd, extra = {}) {
  if (!tabId) throw new Error('没有可用的标签页');
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'bdmCmd', cmd, ...extra });
  } catch {
    // 页面可能是安装扩展之前打开的，补注入一次再重试
    const injected = await injectContentScript();
    if (!injected) throw new Error('无法连接当前页面');
    return chrome.tabs.sendMessage(tabId, { type: 'bdmCmd', cmd, ...extra });
  }
}

function renderOffset() {
  $('offsetLabel').textContent = `${(offsetMs / 1000).toFixed(1)}s`;
}

function setPhase(phase) {
  $('dot').dataset.phase = phase || 'idle';
}

function showUnavailable() {
  available = false;
  document.body.classList.add('unavailable');
  $('status').textContent = '请先打开抖音直播间';
  setPhase('idle');
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;

  try {
    const state = await send('getState');
    if (!state?.ok) {
      showUnavailable();
      return;
    }

    available = true;
    document.body.classList.remove('unavailable');

    if (state.roomId) $('room').value = state.roomId;
    offsetMs = Number(state.offsetMs) || 0;
    renderOffset();

    const status = state.status || { phase: 'idle', text: '未连接' };
    $('status').textContent = status.text || '未连接';
    setPhase(status.phase);
  } catch {
    showUnavailable();
  }
}

document.querySelectorAll('[data-delta]').forEach((button) => {
  button.addEventListener('click', async () => {
    if (!available) return;
    offsetMs = Math.max(0, Math.min(600000, offsetMs + Number(button.dataset.delta)));
    renderOffset();
    try {
      const result = await send('setOffset', { value: offsetMs });
      if (result?.ok) {
        offsetMs = Number(result.offsetMs) || offsetMs;
        renderOffset();
      }
    } catch {
      // 页面已关闭
    }
  });
});

$('connect').addEventListener('click', async () => {
  if (!available) return;
  const roomId = $('room').value.trim();
  if (!roomId) {
    $('room').focus();
    return;
  }
  try {
    const result = await send('connect', { roomId });
    if (!result?.ok) {
      $('status').textContent = '房间号无效';
      setPhase('error');
      return;
    }
    setTimeout(refresh, 400);
  } catch {
    showUnavailable();
  }
});

$('room').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('connect').click();
});

$('disconnect').addEventListener('click', async () => {
  if (!available) return;
  try {
    await send('disconnect');
    setTimeout(refresh, 300);
  } catch {
    showUnavailable();
  }
});

$('togglePanel').addEventListener('click', async () => {
  if (!available) return;
  try {
    await send('togglePanel');
    window.close();
  } catch {
    showUnavailable();
  }
});

refresh();
