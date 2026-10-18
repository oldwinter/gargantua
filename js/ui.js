/* ============================================================================
 *  GARGANTUA · 卡冈图雅 — UI 外壳 / UI shell
 *  ---------------------------------------------------------------------------
 *  职责：
 *    1. 依据 BH.GROUPS / BH.DEFS 生成整个参数控制树（绝不硬编码任何 key）
 *    2. 双向绑定：控件 → BH.set()，BH.subscribe() → 控件（带拖拽防抖守卫）
 *    3. 对外暴露 window.BH.ui = { hideLoading, showError, setHud, setPresets }
 *
 *  本文件不依赖任何库，不使用 ES module，file:// 下可直接运行。
 *  渲染层缺失（renderer.js / app.js 未加载或抛错）时本文件仍须正常工作。
 * ==========================================================================*/
(function () {
  'use strict';

  /* -------------------------------------------------------------------------
   *  0. 契约引用
   *      params.js 先于本文件加载，因此此处通常已就绪。
   *      但 app.js 可能重建 window.BH，所以 init() 时会重新取一次。
   * ----------------------------------------------------------------------- */
  var BH = window.BH;

  /* -------------------------------------------------------------------------
   *  1. 常量
   * ----------------------------------------------------------------------- */
  var HUD_MIN_INTERVAL = 250;        /* ms —— HUD 最高约 4 次/秒的 DOM 写入 */
  var LOADING_AUTOHIDE_MS = 6000;    /* 首屏遮罩最长存活时间 */
  var LOADING_FADE_MS = 260;         /* 与 CSS --t-slow 对齐 */
  var FLASH_MS = 600;                /* 预设高亮闪烁时长 */
  var NARROW_MQ = '(max-width: 819px)';
  var LS_SIDEBAR = 'bh.ui.sidebar.collapsed';
  var LS_GROUPS = 'bh.ui.groups.collapsed';

  /* 六个预设：数值全部落在 DEFS 声明的区间内（BH.setMany 仍会做夹取） */
  var BUILTIN_PRESETS = [
    {
      id: 'film',
      label: '电影版',
      values: {
        blackHoleMass: 1.0, diskInner: 3.0, diskOuter: 12.0,
        diskThickness: 0.045, diskTemp: 8200, diskBrightness: 1.35,
        dopplerBeaming: 0.35, diskTurbulence: 0.62, exposure: 1.0,
        bloomStrength: 0.85, vignette: 0.45
      }
    },
    {
      id: 'physics',
      label: '真实物理',
      values: {
        dopplerBeaming: 1.0, diskTemp: 11000, diskThickness: 0.02,
        lensing: 1.0, diskInner: 3.0, chromatic: 0.05, bloomStrength: 0.55
      }
    },
    {
      id: 'dark',
      label: '极简暗黑',
      values: {
        starBrightness: 0.5, diskBrightness: 0.8, bloomStrength: 0.35,
        vignette: 0.7, grain: 0.12, chromatic: 0.0, exposure: 0.85
      }
    },
    {
      id: 'ember',
      label: '炽热红盘',
      values: {
        diskTemp: 3400, diskBrightness: 1.8, bloomStrength: 1.1, exposure: 1.05
      }
    },
    {
      id: 'blue',
      label: '蓝白巨星',
      values: {
        blackHoleMass: 2.4, diskTemp: 17000, diskOuter: 18.0,
        diskBrightness: 1.6, lensing: 1.35, bloomStrength: 1.2
      }
    },
    {
      id: 'ring',
      label: '薄环奇观',
      values: {
        diskInner: 3.0, diskOuter: 20.0, diskThickness: 0.0,
        diskTurbulence: 0.85, lensing: 1.6, starBrightness: 1.6,
        bloomStrength: 0.6
      }
    }
  ];

  /* -------------------------------------------------------------------------
   *  2. 小工具
   * ----------------------------------------------------------------------- */
  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function clamp01(x) {
    return x < 0 ? 0 : (x > 1 ? 1 : x);
  }

  function nowMs() {
    if (window.performance && typeof window.performance.now === 'function') {
      return window.performance.now();
    }
    return Date.now();
  }

  /* localStorage 在部分浏览器的 file:// 下会抛 SecurityError —— 全部吞掉 */
  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function lsSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* 忽略 */ }
  }

  /* -------------------------------------------------------------------------
   *  3. 数值格式化
   *     - step >= 1 或值为整数      → 整数（8200 → "8200"）
   *     - step < 0.01（如 0.005）   → 3 位小数，避免读数与实际位置不符
   *     - 其余                      → 2 位小数
   * ----------------------------------------------------------------------- */
  function formatValue(def, raw) {
    var n = Number(raw);
    if (!isFinite(n)) return String(raw == null ? '' : raw);

    if (def.step >= 1) return String(Math.round(n));
    if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
    if (def.step < 0.01) {
      /* 0.005 步长：保留 3 位再剪掉多余的尾零（0.350 → 0.35，1.000 → 1） */
      return n.toFixed(3).replace(/\.?0+$/, '');
    }
    return n.toFixed(2);
  }

  function fillPercent(def, raw) {
    var n = Number(raw);
    var span = def.max - def.min;
    if (!isFinite(n) || !(span > 0)) return 0;
    return clamp01((n - def.min) / span) * 100;
  }

  /* -------------------------------------------------------------------------
   *  4. 模块状态
   * ----------------------------------------------------------------------- */
  var dom = {
    groups: null,
    presets: null,
    resetAll: null,
    toggle: null,
    scrim: null,
    head: null,
    loading: null,
    hud: null,
    hudFps: null,
    hudRes: null,
    hudSamples: null,
    error: null,
    errorTitle: null,
    errorDetail: null,
    errorDismiss: null
  };

  /* key → { def, row, input, num, unit, hint } */
  var controls = Object.create(null);
  /* groupId → { section, headBtn, body } */
  var groupRefs = Object.create(null);

  var activeKey = null;        /* 正在被用户拖动的控件，订阅回调跳过写回 */
  var loadingHidden = false;
  var loadingPending = false;  /* init 之前就调用了 hideLoading */
  var pendingError = null;     /* init 之前就调用了 showError */
  var loadingTimer = 0;
  var flashTimer = 0;
  var unsub = null;
  var initialized = false;

  var hudData = { fps: null, width: null, height: null, samples: null, maxSamples: 64 };
  var hudDirty = false;
  var hudTimer = 0;
  var hudLastWrite = 0;

  /* -------------------------------------------------------------------------
   *  5. 控件构造
   * ----------------------------------------------------------------------- */
  function buildRangeRow(def) {
    var row = el('div', 'row');
    row.setAttribute('data-key', def.key);
    row.setAttribute('data-type', 'range');

    var top = el('div', 'row-top');
    var id = 'ctl-' + def.key;
    var hintId = 'hint-' + def.key;

    var label = el('label', 'row-label', def.label);
    label.setAttribute('for', id);

    var value = el('span', 'row-value');
    var num = el('span', 'num', '');
    value.appendChild(num);
    var unit = null;
    if (def.unit) {
      unit = el('span', 'unit', def.unit);
      value.appendChild(unit);
    }

    top.appendChild(label);
    top.appendChild(value);
    row.appendChild(top);

    var input = document.createElement('input');
    input.className = 'range';
    input.type = 'range';
    input.id = id;
    input.min = String(def.min);
    input.max = String(def.max);
    input.step = String(def.step);
    input.value = String(BH.state[def.key]);
    input.setAttribute('aria-label', def.unit ? def.label + '（' + def.unit + '）' : def.label);
    if (def.hint) input.setAttribute('aria-describedby', hintId);
    input.style.setProperty('--fill', fillPercent(def, BH.state[def.key]).toFixed(2) + '%');
    row.appendChild(input);

    if (def.hint) {
      var hint = el('p', 'hint', def.hint);
      hint.id = hintId;
      row.appendChild(hint);
    }

    controls[def.key] = {
      def: def, row: row, input: input,
      num: num, unit: unit, hint: def.hint ? row.querySelector('.hint') : null
    };

    input.addEventListener('input', function () {
      activeKey = def.key;
      try {
        BH.set(def.key, Number(input.value));
      } finally {
        syncRange(def.key);
        activeKey = null;
      }
    });

    /* 松手/失焦后做一次完整同步，确保与 BH.state 完全一致 */
    input.addEventListener('change', function () {
      syncRange(def.key);
    });

    return row;
  }

  function buildToggleRow(def) {
    var row = el('div', 'row');
    row.setAttribute('data-key', def.key);
    row.setAttribute('data-type', 'toggle');

    var top = el('div', 'row-top');
    var id = 'ctl-' + def.key;
    var hintId = 'hint-' + def.key;

    /* <label for> 对 button 是合法的 labelable 元素：点标签即切换开关 */
    var label = el('label', 'row-label', def.label);
    label.setAttribute('for', id);

    var btn = el('button', 'switch');
    btn.type = 'button';
    btn.id = id;
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-checked', BH.state[def.key] ? 'true' : 'false');
    btn.setAttribute('aria-label', def.label);
    if (def.hint) btn.setAttribute('aria-describedby', hintId);
    btn.appendChild(el('span', 'switch-knob'));

    top.appendChild(label);
    top.appendChild(btn);
    row.appendChild(top);

    if (def.hint) {
      var hint = el('p', 'hint', def.hint);
      hint.id = hintId;
      row.appendChild(hint);
    }

    controls[def.key] = {
      def: def, row: row, input: btn,
      num: null, unit: null, hint: def.hint ? row.querySelector('.hint') : null
    };

    btn.addEventListener('click', function () {
      BH.set(def.key, btn.getAttribute('aria-checked') !== 'true');
    });

    return row;
  }

  function buildSelectRow(def) {
    var row = el('div', 'row');
    row.setAttribute('data-key', def.key);
    row.setAttribute('data-type', 'select');

    var top = el('div', 'row-top');
    var id = 'ctl-' + def.key;
    var hintId = 'hint-' + def.key;

    var label = el('label', 'row-label', def.label);
    label.setAttribute('for', id);
    top.appendChild(label);
    row.appendChild(top);

    var wrap = el('div', 'select-wrap');
    var select = document.createElement('select');
    select.className = 'select';
    select.id = id;
    select.setAttribute('aria-label', def.label);
    if (def.hint) select.setAttribute('aria-describedby', hintId);

    var opts = def.options || [];
    for (var i = 0; i < opts.length; i++) {
      var o = document.createElement('option');
      o.value = String(opts[i].value);
      o.textContent = String(opts[i].label);
      if (opts[i].value === BH.state[def.key]) o.selected = true;
      select.appendChild(o);
    }
    wrap.appendChild(select);
    row.appendChild(wrap);

    if (def.hint) {
      var hint = el('p', 'hint', def.hint);
      hint.id = hintId;
      row.appendChild(hint);
    }

    controls[def.key] = {
      def: def, row: row, input: select,
      num: null, unit: null, hint: def.hint ? row.querySelector('.hint') : null
    };

    select.addEventListener('change', function () {
      BH.set(def.key, select.value);
    });

    return row;
  }

  function buildRow(def) {
    if (def.type === 'toggle') return buildToggleRow(def);
    if (def.type === 'select') return buildSelectRow(def);
    return buildRangeRow(def);
  }

  /* -------------------------------------------------------------------------
   *  6. 分组构造
   * ----------------------------------------------------------------------- */
  function buildGroup(group) {
    var section = el('section', 'group');
    section.setAttribute('data-group', group.id);

    var head = el('div', 'group-head');

    var toggle = el('button', 'group-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-controls', 'grp-body-' + group.id);
    toggle.setAttribute('aria-label', group.title + ' 分组（点击折叠）');

    var icon = el('span', 'group-icon', group.icon || '·');
    icon.setAttribute('aria-hidden', 'true');
    var title = el('span', 'group-title', group.title);
    var chevron = el('span', 'group-chevron');
    chevron.setAttribute('aria-hidden', 'true');

    toggle.appendChild(icon);
    toggle.appendChild(title);
    toggle.appendChild(chevron);

    var resetBtn = el('button', 'group-reset', '↺');
    resetBtn.type = 'button';
    resetBtn.setAttribute('aria-label', '恢复「' + group.title + '」默认值');
    resetBtn.title = '恢复本组默认值';

    head.appendChild(toggle);
    head.appendChild(resetBtn);
    section.appendChild(head);

    var body = el('div', 'group-body');
    body.id = 'grp-body-' + group.id;
    section.appendChild(body);

    /* 填入属于该分组的参数（顺序 = DEFS 声明顺序） */
    var defs = BH.DEFS || [];
    for (var i = 0; i < defs.length; i++) {
      if (defs[i].group !== group.id) continue;
      body.appendChild(buildRow(defs[i]));
    }

    groupRefs[group.id] = { section: section, head: toggle, body: body, reset: resetBtn };

    toggle.addEventListener('click', function () {
      var collapsed = section.classList.toggle('collapsed');
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      saveGroupState();
    });

    resetBtn.addEventListener('click', function () {
      BH.resetGroup(group.id);
    });

    return section;
  }

  /* -------------------------------------------------------------------------
   *  7. 分组折叠状态持久化
   * ----------------------------------------------------------------------- */
  function saveGroupState() {
    var ids = [];
    for (var id in groupRefs) {
      if (!Object.prototype.hasOwnProperty.call(groupRefs, id)) continue;
      if (groupRefs[id].section.classList.contains('collapsed')) ids.push(id);
    }
    lsSet(LS_GROUPS, ids.join(','));
  }

  function restoreGroupState() {
    var raw = lsGet(LS_GROUPS);
    if (!raw) return;
    var ids = raw.split(',');
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (!id || !groupRefs[id]) continue;
      groupRefs[id].section.classList.add('collapsed');
      groupRefs[id].head.setAttribute('aria-expanded', 'false');
    }
  }

  /* -------------------------------------------------------------------------
   *  8. 同步（BH.state → DOM）
   * ----------------------------------------------------------------------- */
  function syncRange(key) {
    var c = controls[key];
    if (!c) return;
    var def = c.def;
    var v = BH.state[key];

    if (c.input.value !== String(v) && key !== activeKey) {
      c.input.value = String(v);
    }
    if (c.num) c.num.textContent = formatValue(def, v);
    c.input.style.setProperty('--fill', fillPercent(def, v).toFixed(2) + '%');
    c.input.setAttribute('aria-valuetext', formatValue(def, v) + (def.unit ? ' ' + def.unit : ''));
  }

  function syncToggle(key) {
    var c = controls[key];
    if (!c) return;
    c.input.setAttribute('aria-checked', BH.state[key] ? 'true' : 'false');
  }

  function syncSelect(key) {
    var c = controls[key];
    if (!c) return;
    var v = String(BH.state[key]);
    if (c.input.value !== v) c.input.value = v;
  }

  function syncOne(key) {
    var c = controls[key];
    if (!c) return;
    if (c.def.type === 'toggle') syncToggle(key);
    else if (c.def.type === 'select') syncSelect(key);
    else syncRange(key);
  }

  function syncAll() {
    for (var key in controls) {
      if (!Object.prototype.hasOwnProperty.call(controls, key)) continue;
      syncOne(key);
    }
  }

  /* -------------------------------------------------------------------------
   *  9. 预设
   * ----------------------------------------------------------------------- */
  function flashHead() {
    if (!dom.head) return;
    dom.head.classList.remove('flash');
    /* 强制回流以重启 CSS 动画 */
    void dom.head.offsetWidth;
    dom.head.classList.add('flash');
    if (flashTimer) window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(function () {
      flashTimer = 0;
      if (dom.head) dom.head.classList.remove('flash');
    }, FLASH_MS + 40);
  }

  function applyPreset(values) {
    if (!values) return;
    if (typeof BH.setMany === 'function') BH.setMany(values);
    flashHead();
  }

  function renderPresets(list) {
    if (!dom.presets) return;
    dom.presets.textContent = '';

    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p || !p.values) continue;
      var btn = el('button', 'preset-btn', p.label || p.id || ('预设 ' + (i + 1)));
      btn.type = 'button';
      btn.setAttribute('aria-label', '应用预设：' + (p.label || p.id));
      (function (values) {
        btn.addEventListener('click', function () { applyPreset(values); });
      })(p.values);
      dom.presets.appendChild(btn);
    }
  }

  /* -------------------------------------------------------------------------
   *  10. HUD（限流到约 4 次/秒）
   * ----------------------------------------------------------------------- */
  function writeHud() {
    /* init 之前 HUD 节点还不存在：保持 hudDirty，等 init 后再写 */
    if (!initialized) return;

    hudLastWrite = nowMs();
    if (!hudDirty) return;
    hudDirty = false;

    if (dom.hudFps) {
      var fps = hudData.fps;
      var fpsText = (typeof fps === 'number' && isFinite(fps))
        ? (fps >= 100 ? String(Math.round(fps))
          : fps >= 10 ? String(Math.round(fps * 10) / 10)
            : String(Math.round(fps * 100) / 100))
        : '—';
      if (dom.hudFps.textContent !== fpsText) dom.hudFps.textContent = fpsText;
    }

    if (dom.hudRes) {
      var w = hudData.width;
      var h = hudData.height;
      var resText = (typeof w === 'number' && typeof h === 'number' && isFinite(w) && isFinite(h))
        ? (Math.round(w) + ' × ' + Math.round(h))
        : '—';
      if (dom.hudRes.textContent !== resText) dom.hudRes.textContent = resText;
    }

    if (dom.hudSamples) {
      var maxS = (typeof hudData.maxSamples === 'number' && hudData.maxSamples > 0)
        ? Math.round(hudData.maxSamples) : 64;
      var s = (typeof hudData.samples === 'number' && isFinite(hudData.samples))
        ? Math.max(0, Math.min(maxS, Math.round(hudData.samples))) : 0;
      var sText = s + '/' + maxS;
      if (dom.hudSamples.textContent !== sText) dom.hudSamples.textContent = sText;
    }
  }

  function scheduleHud() {
    if (hudTimer) return;
    var wait = HUD_MIN_INTERVAL - (nowMs() - hudLastWrite);
    if (wait <= 0) {
      writeHud();
      return;
    }
    hudTimer = window.setTimeout(function () {
      hudTimer = 0;
      writeHud();
    }, wait);
  }

  /**
   * 渲染层每帧调用。写入被限流到约 4 次/秒，重复调用完全安全。
   * @param {{fps?:number,width?:number,height?:number,samples?:number,maxSamples?:number}} info
   */
  function setHud(info) {
    if (!info || typeof info !== 'object') return;
    if (typeof info.fps === 'number' && isFinite(info.fps)) hudData.fps = info.fps;
    if (typeof info.width === 'number' && isFinite(info.width)) hudData.width = info.width;
    if (typeof info.height === 'number' && isFinite(info.height)) hudData.height = info.height;
    if (typeof info.samples === 'number' && isFinite(info.samples)) hudData.samples = info.samples;
    if (typeof info.maxSamples === 'number' && isFinite(info.maxSamples) && info.maxSamples > 0) {
      hudData.maxSamples = info.maxSamples;
    }
    hudDirty = true;
    scheduleHud();
  }

  /* -------------------------------------------------------------------------
   *  11. 加载遮罩 / 错误遮罩
   *      —— 全部惰性解析 DOM：渲染层可能在 init() 之前就调用这些 API。
   * ----------------------------------------------------------------------- */
  function resolveLoadingDom() {
    if (!dom.loading) dom.loading = $('loading');
    return dom.loading;
  }

  function resolveErrorDom() {
    if (!dom.error) dom.error = $('error-overlay');
    if (!dom.errorTitle) dom.errorTitle = $('error-title');
    if (!dom.errorDetail) dom.errorDetail = $('error-detail');
    if (!dom.errorDismiss) dom.errorDismiss = $('error-dismiss');
  }

  function hideLoading() {
    if (loadingHidden) return;

    /* init 之前调用（DOM 还没建树）：记下来，等 init 结算 */
    if (!initialized) {
      loadingPending = true;
      return;
    }

    var node = resolveLoadingDom();
    if (!node) return;

    loadingHidden = true;
    loadingPending = false;
    if (loadingTimer) {
      window.clearTimeout(loadingTimer);
      loadingTimer = 0;
    }

    node.classList.add('hide');
    node.setAttribute('aria-hidden', 'true');

    window.setTimeout(function () {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }, LOADING_FADE_MS);
  }

  /**
   * 渲染层在 WebGL2 不可用等致命场景调用。可在 init() 之前安全调用。
   * @param {string} title 短标题
   * @param {string} [detail] 详细说明（可含换行）
   */
  function showError(title, detail) {
    if (!initialized) {
      pendingError = { title: title, detail: detail };
      loadingPending = true;
      return;
    }

    hideLoading();
    resolveErrorDom();

    if (dom.errorTitle) {
      dom.errorTitle.textContent = title ? String(title) : '无法启动渲染器';
    }
    if (dom.errorDetail) {
      dom.errorDetail.textContent = detail
        ? String(detail)
        : '当前浏览器或显卡不支持 WebGL2。请使用较新的 Chrome / Edge / Firefox / Safari，并确认已启用硬件加速。';
    }
    if (dom.error) {
      dom.error.hidden = false;
      dom.error.setAttribute('aria-hidden', 'false');
    }
    if (dom.errorDismiss && typeof dom.errorDismiss.focus === 'function') {
      try { dom.errorDismiss.focus(); } catch (e) { /* 忽略 */ }
    }
  }

  function hideError() {
    resolveErrorDom();
    if (!dom.error) return;
    dom.error.hidden = true;
    dom.error.setAttribute('aria-hidden', 'true');
  }

  /* -------------------------------------------------------------------------
   *  12. 侧栏开合
   * ----------------------------------------------------------------------- */
  function isNarrow() {
    if (window.matchMedia) {
      return window.matchMedia(NARROW_MQ).matches;
    }
    return window.innerWidth < 820;
  }

  function applyCollapsed(collapsed, persist) {
    if (collapsed) document.body.classList.add('sidebar-collapsed');
    else document.body.classList.remove('sidebar-collapsed');

    if (dom.toggle) {
      dom.toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      dom.toggle.setAttribute('aria-label', collapsed ? '展开参数面板' : '收起参数面板');
    }
    if (persist) lsSet(LS_SIDEBAR, collapsed ? '1' : '0');
  }

  function toggleSidebar() {
    var collapsed = !document.body.classList.contains('sidebar-collapsed');
    applyCollapsed(collapsed, true);
  }

  function restoreSidebarState() {
    var stored = lsGet(LS_SIDEBAR);
    var collapsed;

    if (stored === '1' || stored === '0') {
      collapsed = (stored === '1');
    } else {
      /* 无记录：窄屏默认收起抽屉，宽屏默认展开 */
      collapsed = isNarrow();
    }

    /* 窄屏首次进入一律收起，避免一打开就盖住画面 */
    if (isNarrow()) collapsed = true;

    applyCollapsed(collapsed, false);
  }

  function onViewportChange() {
    if (isNarrow() && !document.body.classList.contains('sidebar-collapsed')) {
      applyCollapsed(true, false);
    }
  }

  /* -------------------------------------------------------------------------
   *  13. 初始化
   * ----------------------------------------------------------------------- */
  function cacheDom() {
    dom.groups = $('groups');
    dom.presets = $('presets');
    dom.resetAll = $('reset-all');
    dom.toggle = $('sidebar-toggle');
    dom.scrim = $('sidebar-scrim');
    dom.head = $('sidebar-head');
    dom.loading = $('loading');
    dom.hud = $('hud');
    dom.hudFps = $('hud-fps');
    dom.hudRes = $('hud-res');
    dom.hudSamples = $('hud-samples');
    dom.error = $('error-overlay');
    dom.errorTitle = $('error-title');
    dom.errorDetail = $('error-detail');
    dom.errorDismiss = $('error-dismiss');
  }

  function buildTree() {
    if (!dom.groups) return;
    dom.groups.textContent = '';

    var groups = BH.GROUPS || [];
    var defs = BH.DEFS || [];

    /* 兜底：若 DEFS 里出现未在 GROUPS 声明的分组，追加到末尾，绝不丢控件 */
    var known = Object.create(null);
    for (var g = 0; g < groups.length; g++) known[groups[g].id] = true;

    var extra = [];
    for (var d = 0; d < defs.length; d++) {
      if (!known[defs[d].group]) {
        known[defs[d].group] = true;
        extra.push({ id: defs[d].group, title: defs[d].group, icon: '·' });
      }
    }

    var ordered = groups.concat(extra);
    for (var i = 0; i < ordered.length; i++) {
      dom.groups.appendChild(buildGroup(ordered[i]));
    }
  }

  function wireGlobalControls() {
    if (dom.resetAll) {
      dom.resetAll.addEventListener('click', function () {
        BH.reset();
      });
    }

    if (dom.toggle) {
      dom.toggle.addEventListener('click', toggleSidebar);
    }

    if (dom.scrim) {
      dom.scrim.addEventListener('click', function () {
        if (isNarrow()) applyCollapsed(true, false);
      });
    }

    if (dom.errorDismiss) {
      dom.errorDismiss.addEventListener('click', hideError);
    }

    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' && ev.key !== 'Esc') return;
      if (dom.error && !dom.error.hidden) {
        hideError();
        return;
      }
      if (isNarrow() && !document.body.classList.contains('sidebar-collapsed')) {
        applyCollapsed(true, false);
      }
    });
  }

  function wireResize() {
    var handler = function () { onViewportChange(); };
    if (window.matchMedia) {
      var mq = window.matchMedia(NARROW_MQ);
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', handler);
      } else if (typeof mq.addListener === 'function') {
        mq.addListener(handler);
      }
    }
    window.addEventListener('resize', handler);
  }

  function wireContract() {
    if (typeof BH.subscribe !== 'function') return;
    unsub = BH.subscribe(function (changed) {
      if (!changed || !changed.length) {
        syncAll();
        return;
      }
      for (var i = 0; i < changed.length; i++) syncOne(changed[i]);
    });
  }

  function armLoadingSafety() {
    if (loadingTimer) window.clearTimeout(loadingTimer);
    loadingTimer = window.setTimeout(function () {
      loadingTimer = 0;
      hideLoading();
    }, LOADING_AUTOHIDE_MS);
  }

  function init() {
    if (initialized) return;
    initialized = true;

    /* app.js 可能替换过 window.BH —— 以最新的为准 */
    if (window.BH) BH = window.BH;

    cacheDom();

    /* 契约缺失：保留静态外壳，不抛错、不刷屏 */
    if (!BH || !BH.DEFS || !BH.state) {
      armLoadingSafety();
      return;
    }

    buildTree();
    renderPresets(BUILTIN_PRESETS);
    restoreGroupState();
    wireGlobalControls();
    wireResize();
    wireContract();
    restoreSidebarState();
    syncAll();
    armLoadingSafety();

    /* 首帧 HUD 占位（若渲染层已提前推过数据则保留其值） */
    if (dom.hudFps && !hudDirty) dom.hudFps.textContent = '—';
    if (dom.hudRes && !hudDirty) dom.hudRes.textContent = '—';
    if (dom.hudSamples && !hudDirty) dom.hudSamples.textContent = '0/64';

    /* 结算 init 之前累积的调用 */
    if (loadingPending) {
      loadingPending = false;
      hideLoading();
    }
    if (pendingError) {
      var pe = pendingError;
      pendingError = null;
      showError(pe.title, pe.detail);
    }
    if (hudDirty) scheduleHud();
  }

  /* -------------------------------------------------------------------------
   *  14. 对外 API
   * ----------------------------------------------------------------------- */
  function setPresets(list) {
    if (!list || typeof list.length !== 'number') return;
    renderPresets(list);
  }

  function destroy() {
    if (unsub) { unsub(); unsub = null; }
    if (loadingTimer) { window.clearTimeout(loadingTimer); loadingTimer = 0; }
    if (hudTimer) { window.clearTimeout(hudTimer); hudTimer = 0; }
    if (flashTimer) { window.clearTimeout(flashTimer); flashTimer = 0; }
  }

  window.BH = window.BH || {};
  window.BH.ui = {
    hideLoading: hideLoading,
    showError: showError,
    setHud: setHud,
    setPresets: setPresets,
    /* 额外便利方法（渲染层可用可不用） */
    hideError: hideError,
    destroy: destroy
  };

  /* 脚本位于 </body> 之前，DOM 已就绪；仍做一次兜底 */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
