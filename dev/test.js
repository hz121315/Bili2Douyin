/*
 * 开发自测入口：写入测试房间号后，按顺序加载弹幕层和 content.js。
 * 用法：chrome-extension://<扩展ID>/dev/test.html?room=3044248[&offset=5]
 * 已保存的延迟、字号等设置会被保留，方便测试刷新后的恢复逻辑。
 */

const params = new URLSearchParams(location.search);
const room = params.get('room') || '3044248';
const offsetFromUrl = params.has('offset') ? Number(params.get('offset')) * 1000 : undefined;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`加载失败：${src}`));
    document.body.appendChild(script);
  });
}

chrome.storage.local
  .get('bdmSettings')
  .then(({ bdmSettings }) => {
    const next = {
      fontSize: 15,
      opacity: 0.88,
      showSC: true,
      ...(bdmSettings || {}),
      roomId: room,
      wantConnected: true,
    };
    if (Number.isFinite(offsetFromUrl)) next.offsetMs = offsetFromUrl;
    return chrome.storage.local.set({ bdmSettings: next });
  })
  .then(() => loadScript('../danmaku-layer.js'))
  .then(() => loadScript('../content.js'))
  .catch((error) => console.error('[bdm dev]', error));
