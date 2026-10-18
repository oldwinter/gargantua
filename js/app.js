/* ============================================================================
 *  GARGANTUA · 应用引导 / App bootstrap
 *  ---------------------------------------------------------------------------
 *  职责：创建相机与渲染器、驱动主循环、自适应分辨率、把统计信息喂给 UI。
 * ==========================================================================*/
(function () {
  'use strict';

  const state = {
    renderer: null,
    camera: null,
    canvas: null,
    running: false,
    lastTime: 0,
    fps: 0,
    fpsAccum: 0,
    fpsFrames: 0,
    hudAccum: 0,
    maxSamples: 64,
    adaptive: true,
    dprCap: 2,
    lowFpsStreak: 0,
    highFpsStreak: 0,
    lastQualityRebuild: 0,
    errors: [],
  };

  /* ---------------------------------------------------------------------- */
  function detectDPR() {
    const d = window.devicePixelRatio || 1;
    return Math.min(d, state.dprCap);
  }

  /* ---------------------------------------------------------------------- */
  function showFatal(title, detail) {
    console.error('[GARGANTUA]', title, detail);
    state.errors.push(title + (detail ? ': ' + detail : ''));
    if (window.BH && window.BH.ui && typeof window.BH.ui.showError === 'function') {
      window.BH.ui.showError(title, detail);
    } else {
      /* 兜底：UI 还没就绪时直接画到页面上 */
      const div = document.createElement('div');
      div.style.cssText =
        'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
        'flex-direction:column;gap:14px;padding:40px;background:#05060a;color:#e8ecf4;' +
        'font-family:system-ui,sans-serif;text-align:center;z-index:9999;';
      div.innerHTML =
        '<div style="font-size:13px;letter-spacing:.3em;color:#ffb865">GARGANTUA</div>' +
        '<div style="font-size:20px;font-weight:600">' + escapeHtml(title) + '</div>' +
        '<div style="font-size:13px;color:#7c8698;max-width:560px;line-height:1.7">' +
        escapeHtml(detail || '') + '</div>';
      document.body.appendChild(div);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  /* ---------------------------------------------------------------------- */
  function resize() {
    const r = state.renderer;
    const c = state.canvas;
    if (!r || !c) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    r.setRenderScale(window.BH ? window.BH.state.renderScale : 0.85);
    r.resize(w, h, detectDPR());
    c.style.width = w + 'px';
    c.style.height = h + 'px';
  }

  /* ---------------------------------------------------------------------- */
  /** 帧率过低时自动降分辨率；持续高帧率时缓慢升回 */
  function adapt(dt) {
    if (!state.adaptive || !state.renderer) return;
    const fps = state.fps;
    if (fps <= 0) return;

    if (fps < 32) {
      state.lowFpsStreak += dt;
      state.highFpsStreak = 0;
    } else if (fps > 56) {
      state.highFpsStreak += dt;
      state.lowFpsStreak = 0;
    } else {
      state.lowFpsStreak = Math.max(0, state.lowFpsStreak - dt * 0.5);
      state.highFpsStreak = Math.max(0, state.highFpsStreak - dt * 0.5);
    }

    const cur = state.renderer.renderScale;

    if (state.lowFpsStreak > 1.4 && cur > 0.45) {
      state.lowFpsStreak = 0;
      const next = Math.max(0.45, cur - 0.1);
      state.renderer.setRenderScale(next);
      if (window.BH) window.BH.set('renderScale', next);
      console.info('[GARGANTUA] 自动降低分辨率 →', next.toFixed(2));
    } else if (state.highFpsStreak > 3.0 && cur < 1.0) {
      state.highFpsStreak = 0;
      const next = Math.min(1.0, cur + 0.05);
      state.renderer.setRenderScale(next);
      if (window.BH) window.BH.set('renderScale', next);
      console.info('[GARGANTUA] 自动提升分辨率 →', next.toFixed(2));
    }
  }

  /* ---------------------------------------------------------------------- */
  function loop(now) {
    if (!state.running) return;
    requestAnimationFrame(loop);

    const raw = (now - state.lastTime) / 1000;
    state.lastTime = now;
    if (!Number.isFinite(raw) || raw <= 0) return;
    /* 标签页切回来时会有巨大的 dt，钳一下 */
    const dt = Math.min(raw, 0.1);

    /* ---- 相机 ---- */
    const cam = state.camera;
    if (cam) {
      cam.setAutoRotate(window.BH ? window.BH.state.autoRotate : true);
      cam.update(dt);
    }

    /* ---- 渲染 ---- */
    const r = state.renderer;
    if (r) {
      try {
        r.render(dt);
      } catch (err) {
        state.running = false;
        showFatal('渲染循环出错', err && err.message ? err.message : String(err));
        return;
      }
    }

    /* ---- FPS ---- */
    state.fpsAccum += raw;
    state.fpsFrames++;
    if (state.fpsAccum >= 0.4) {
      state.fps = state.fpsFrames / state.fpsAccum;
      state.fpsAccum = 0;
      state.fpsFrames = 0;
    }

    adapt(raw);

    /* ---- HUD（限流）---- */
    state.hudAccum += raw;
    if (state.hudAccum >= 0.25) {
      state.hudAccum = 0;
      const info = r ? r.getInfo() : null;
      if (window.BH && window.BH.ui && typeof window.BH.ui.setHud === 'function') {
        window.BH.ui.setHud({
          fps: state.fps,
          width: info ? info.sceneWidth : 0,
          height: info ? info.sceneHeight : 0,
          samples: r ? r.sampleCount : 0,
          maxSamples: state.maxSamples,
        });
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  function init() {
    state.canvas = document.getElementById('glcanvas');
    if (!state.canvas) {
      showFatal('页面结构缺失', '找不到 <canvas id="glcanvas">，请检查 index.html。');
      return;
    }

    if (!window.BH) {
      showFatal('参数模块未加载', 'js/params.js 没有正确加载。');
      return;
    }

    if (!window.OrbitCamera) {
      showFatal('相机模块未加载', 'js/camera.js 没有正确加载。');
      return;
    }

    if (!window.GargantuaRenderer || !window.SHADERS) {
      showFatal('渲染模块未加载', 'js/shaders.js 或 js/renderer.js 没有正确加载。');
      return;
    }

    /* ---- 相机 ---- */
    try {
      state.camera = new window.OrbitCamera(state.canvas);
    } catch (err) {
      showFatal('相机初始化失败', err && err.message ? err.message : String(err));
      return;
    }

    /* ---- 渲染器 ---- */
    let renderer;
    try {
      renderer = new window.GargantuaRenderer(state.canvas, state.camera);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (msg.indexOf('WEBGL2_UNAVAILABLE') >= 0) {
        showFatal('无法创建 WebGL2 上下文',
          '你的浏览器或显卡驱动不支持 WebGL2。请使用最新版 Chrome / Edge / Firefox，' +
          '并在浏览器设置中确认已启用硬件加速。');
      } else {
        showFatal('渲染器初始化失败', msg);
      }
      return;
    }
    state.renderer = renderer;
    state.maxSamples = window.GARGANTUA_MAX_SAMPLES || 64;

    /* ---- 首帧尺寸 ---- */
    resize();

    /* ---- 参数订阅 ---- */
    window.BH.subscribe((changed) => {
      /* 质量档位 → 重建主着色器 */
      if (changed.indexOf('quality') >= 0) {
        try {
          renderer.rebuildMainProgram();
          renderer.resetAccumulation();
        } catch (err) {
          console.warn('[GARGANTUA] 重建着色器失败：', err);
        }
      }
      /* 分辨率缩放 → 重建目标 */
      if (changed.indexOf('renderScale') >= 0) {
        resize();
      }
      /* 物理参数变化 → 累积清零（在 render 里靠签名自动处理，这里保险起见） */
      for (const k of changed) {
        if (window.BH.isWarp(k)) { renderer.resetAccumulation(); break; }
      }
    });

    /* ---- 窗口事件 ---- */
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 90);
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        state.lastTime = performance.now();
      }
    });

    /* ---- 上下文丢失 ---- */
    state.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      state.running = false;
      showFatal('WebGL 上下文丢失', '显卡驱动可能重置了。请刷新页面。');
    });

    /* ---- 启动 ---- */
    state.running = true;
    state.lastTime = performance.now();
    requestAnimationFrame(loop);

    /* 隐藏加载层（给 UI 一点时间淡出） */
    setTimeout(() => {
      if (window.BH.ui && typeof window.BH.ui.hideLoading === 'function') {
        window.BH.ui.hideLoading();
      }
    }, 320);

    /* ---- 对外暴露 ---- */
    window.BH.app = {
      get stats() {
        const info = renderer.getInfo();
        return {
          fps: state.fps,
          samples: renderer.sampleCount,
          maxSamples: state.maxSamples,
          width: info.sceneWidth,
          height: info.sceneHeight,
          renderer: info.renderer,
          floatTargets: info.floatTargets,
        };
      },
      get renderer() { return state.renderer; },
      get camera() { return state.camera; },
      resetView() { state.camera && state.camera.resetView(); },
      setAdaptive(on) { state.adaptive = !!on; },
      errors: state.errors,
    };

    console.info(
      '%c GARGANTUA ',
      'background:#ffb865;color:#05060a;font-weight:700;letter-spacing:.2em',
      '\n' + renderer.getInfo().renderer
    );
  }

  /* ---------------------------------------------------------------------- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
