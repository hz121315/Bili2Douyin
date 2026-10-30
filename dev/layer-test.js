/*
 * 弹幕层测试：不依赖 B 站连接，验证
 * 1) 一批 30 条是否全部上屏、是否有先后顺序
 * 2) 高密度输入（约 25 条/秒）时队列是否稳定、缓冲延迟是否被压住
 * 3) 显示区域（上四分之一）、自定义颜色、密度是否生效
 */

(() => {
  const output = document.getElementById('out');
  const log = (line) => {
    const div = document.createElement('div');
    div.textContent = line;
    output.appendChild(div);
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const video = document.getElementById('fake-video');
  Object.defineProperty(video, 'readyState', { value: 4 });
  Object.defineProperty(video, 'videoWidth', { value: 1920 });
  Object.defineProperty(video, 'videoHeight', { value: 1080 });

  const layer = new window.BdmDanmakuLayer({});
  layer.setFontSize(20);
  layer.setSpeed(12);
  layer.setEnabled(true);

  const layerRoot = document.getElementById('bdm-dm-layer');
  if (!layerRoot) {
    log('layer root 未创建');
    return;
  }

  const additions = [];
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1 && node.classList.contains('bdm-dm-item')) {
          additions.push({ at: performance.now(), text: node.textContent, node });
        }
      }
    }
  });
  observer.observe(layerRoot, { childList: true, subtree: true });

  const makeItems = (count, prefix) =>
    Array.from({ length: count }, (_, index) => ({
      kind: 'danmaku',
      text: `${prefix} #${index + 1}`,
      color: 0x66ccff,
    }));

  (async () => {
    const result = {};

    // 1) 一次 30 条
    layer.show(makeItems(30, '测试弹幕'));
    await wait(3500);
    let phase = additions.slice();
    const gaps = [];
    for (let i = 1; i < phase.length; i += 1) gaps.push(phase[i].at - phase[i - 1].at);
    const durations = phase.map((entry) => entry.node.getAnimations()[0]?.effect?.getTiming?.().duration).filter((v) => typeof v === 'number');
    result.burst = {
      added: phase.length,
      minGap: gaps.length ? Math.round(Math.min(...gaps)) : 0,
      sameTickPairs: gaps.filter((gap) => gap < 10).length,
      avgDuration: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      stats: layer.getStatus(),
    };

    // 2) 高密度：每 200ms 送 5 条，持续 5 秒（约 25 条/秒）
    const phase2Start = additions.length;
    let maxPending = 0;
    let maxLag = 0;
    const sampler = setInterval(() => {
      const status = layer.getStatus();
      maxPending = Math.max(maxPending, status.pending);
      maxLag = Math.max(maxLag, status.lag);
    }, 80);

    for (let i = 0; i < 25; i += 1) {
      layer.show(makeItems(5, `高频${i + 1}`));
      await wait(200);
    }
    await wait(1500);
    clearInterval(sampler);
    phase = additions.slice(phase2Start);
    result.highRate = {
      added: phase.length,
      expected: 125,
      maxPending,
      maxLag,
      final: layer.getStatus(),
    };

    // 3) 上四分之一区域
    layer.setAreaRatio(0.25);
    await wait(300);
    layer.show(makeItems(6, '区域测试'));
    await wait(900);
    const items = [...document.querySelectorAll('#bdm-dm-layer .bdm-dm-item')];
    const tops = items.map((node) => node.getBoundingClientRect().top - layerRoot.getBoundingClientRect().top);
    result.area = {
      limit: Math.round(layerRoot.getBoundingClientRect().height * 0.25),
      maxTop: tops.length ? Math.round(Math.max(...tops)) : -1,
      count: items.length,
    };

    // 4) 自定义颜色
    layer.setAreaRatio(1);
    layer.setColorMode('custom', '#ff3b3b');
    layer.show([{ kind: 'danmaku', text: '颜色测试', color: 0xffffff }]);
    await wait(1800);
    const colored = [...document.querySelectorAll('#bdm-dm-layer .bdm-dm-item')].find((node) => node.textContent === '颜色测试');
    result.color = colored ? getComputedStyle(colored).color : 'none';

    // 5) 密度 30%
    const before = layer.getStatus();
    layer.setDensity(30);
    layer.show(makeItems(200, '密度测试'));
    await wait(2500);
    const after = layer.getStatus();
    result.density = {
      receivedDelta: after.received - before.received,
      droppedDelta: after.dropped - before.dropped,
      shownDelta: after.shown - before.shown,
      percent: layer.density,
    };

    // 6) 同屏上限压力：1000 条，检查是否为了新弹幕丢弃/清老弹幕
    layer.setDensity(100);
    layer.setSpeed(20);
    const beforeStress = layer.getStatus();
    layer.show(makeItems(1000, '压测'));
    await wait(3000);
    const afterStress = layer.getStatus();
    result.stress = {
      receivedDelta: afterStress.received - beforeStress.received,
      shownDelta: afterStress.shown - beforeStress.shown,
      droppedDelta: afterStress.dropped - beforeStress.dropped,
      active: afterStress.active,
      pending: afterStress.pending,
      lastVisible: [...document.querySelectorAll('#bdm-dm-layer .bdm-dm-item')].some((node) => node.textContent === '压测 #1000'),
    };

    window.__result = result;
    log(JSON.stringify(result, null, 2));
  })();
})();
