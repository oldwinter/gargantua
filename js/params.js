/* ============================================================================
 *  GARGANTUA · 共享参数契约 / Shared parameter contract
 *  ---------------------------------------------------------------------------
 *  这是 UI 层（ui.js）与渲染层（renderer / shaders）之间唯一的接口。
 *  双方都必须通过 window.BH 访问，不允许各自另建副本。
 *
 *  用法：
 *    const s = BH.state;                  // 实时可读的当前参数对象
 *    BH.subscribe((changedKeys) => {...}); // 参数变化回调（不含 'quality'）
 *    BH.set('diskTemp', 9000);             // 程序化改参数（会触发通知 + 'change' 事件）
 *
 *  渲染循环每帧读 BH.state，不需要订阅。
 * ==========================================================================*/
(function () {
  'use strict';

  /* ------------------------------------------------------------------------
   *  参数定义表
   *  key       参数名（BH.state 的属性）
   *  type      'range' | 'select' | 'toggle'
   *  min/max/step  数值范围（'range' 用；对数是给 UI 的显示提示）
   *  def       默认值（必须落在范围内）
   *  label     中文标签
   *  unit      单位后缀（可空）
   *  group     分组 id（见 GROUPS）
   *  hint      鼠标悬停时显示的一行说明
   *  warp      该参数是"改变物理"的（需要重置时间累积），false 表示只是画面调整
   *  options   'select' 用：[{ value, label }]
   * ---------------------------------------------------------------------- */
  const DEFS = [
    /* ===== 1. 黑洞本体 ================================================== */
    {
      key: 'blackHoleMass', group: 'hole', type: 'range',
      min: 0.2, max: 3.0, step: 0.01, def: 1.0,
      label: '黑洞质量', unit: 'M',
      hint: '直接缩放史瓦西半径（引力半径 = 1 个长度单位）。质量越大，视界越大、盘越"贴身"。',
      warp: true,
    },
    {
      key: 'diskInner', group: 'hole', type: 'range',
      min: 1.5, max: 8.0, step: 0.05, def: 3.0,
      label: '吸积盘内缘', unit: 'r_s',
      hint: '以引力半径为单位的盘内半径。3.0 是光子球外的 ISCO（最内稳定圆轨道），也是电影里的取法。',
      warp: true,
    },
    {
      key: 'diskOuter', group: 'hole', type: 'range',
      min: 4.0, max: 30.0, step: 0.1, def: 12.0,
      label: '吸积盘外缘', unit: 'r_s',
      hint: '盘的外半径。外缘越大，盘面在画面上铺得越开，透镜后的顶部弧线也越高。',
      warp: true,
    },
    {
      key: 'diskThickness', group: 'hole', type: 'range',
      min: 0.0, max: 0.35, step: 0.005, def: 0.045,
      label: '盘厚度', unit: 'r_s',
      hint: '垂直方向的厚度。接近 0 是电影里那种纸片般的薄盘，加厚会让盘缘出现立体体积感。',
      warp: true,
    },
    {
      key: 'diskTemp', group: 'hole', type: 'range',
      min: 2000, max: 20000, step: 100, def: 8200,
      label: '盘面温度', unit: 'K',
      hint: '黑体温度，决定盘的颜色。8200K 偏白热（电影色），低一些会变成橙红，高一些会偏蓝。',
      warp: true,
    },

    /* ===== 2. 吸积盘外观 ================================================ */
    {
      key: 'diskBrightness', group: 'disk', type: 'range',
      min: 0.0, max: 4.0, step: 0.01, def: 1.0,
      label: '盘面亮度',
      hint: '吸积盘的发光强度。配合泛光强度可以做出很亮的"过曝"核心。',
    },
    {
      key: 'dopplerBeaming', group: 'disk', type: 'range',
      min: 0.0, max: 1.0, step: 0.01, def: 0.4,
      label: '多普勒集束', unit: '×',
      hint: '相对论集束效应。1.0 = 真实物理：朝向你的那一侧被大幅提亮、背离的一侧变暗。电影为了画面平衡弱化了这个效果。',
    },
    {
      key: 'diskTurbulence', group: 'disk', type: 'range',
      min: 0.0, max: 1.0, step: 0.01, def: 0.62,
      label: '湍流强度',
      hint: '盘面上细密的条纹/涡流对比度，模拟磁流体湍流造成的亮度不均。',
    },
    {
      key: 'diskSpeed', group: 'disk', type: 'range',
      min: 0.0, max: 3.0, step: 0.01, def: 1.0,
      label: '旋转速度', unit: '×',
      hint: '开普勒角速度的时间缩放。0 会冻结盘面的旋转动画。',
    },
    {
      key: 'diskOpacity', group: 'disk', type: 'range',
      min: 0.3, max: 1.0, step: 0.01, def: 0.96,
      label: '盘面不透明度',
      hint: '盘挡光的程度。降低后能透过盘面看到背后的星空和次级像。',
    },

    /* ===== 3. 引力透镜 ================================================== */
    {
      key: 'lensing', group: 'lens', type: 'range',
      min: 0.0, max: 2.0, step: 0.01, def: 1.0,
      label: '引力透镜强度', unit: '×',
      hint: '光线弯曲的倍率。1.0 = 广义相对论精确结果；0 会退化成没有弯曲的平面图。',
      warp: true,
    },
    {
      key: 'photonRing', group: 'lens', type: 'range',
      min: 0.0, max: 2.0, step: 0.01, def: 0.7,
      label: '光子环强度',
      hint: '黑洞阴影边缘那一道极细的亮环。它来自在光子球（1.5 r_s）附近绕行的光线，是相对论渲染最标志性的特征。',
    },
    {
      key: 'starBrightness', group: 'lens', type: 'range',
      min: 0.0, max: 3.0, step: 0.01, def: 1.0,
      label: '星空亮度',
      hint: '背景星场的整体亮度。透镜会把星点拉成细长的弧，这是最容易看出透镜效应的细节。',
    },
    {
      key: 'lensAberration', group: 'lens', type: 'range',
      min: 0.0, max: 1.0, step: 0.01, def: 0.35,
      label: '透镜色散',
      hint: '模拟强引力场下不同波长弯曲程度不同造成的边缘色差，会让爱因斯坦环出现淡淡的彩色。',
    },

    /* ===== 4. 后期处理 ================================================== */
    {
      key: 'exposure', group: 'post', type: 'range',
      min: 0.2, max: 3.0, step: 0.01, def: 0.9,
      label: '曝光',
      hint: '整体曝光（在 ACES 色调映射之前生效）。',
    },
    {
      key: 'bloomStrength', group: 'post', type: 'range',
      min: 0.0, max: 2.0, step: 0.01, def: 0.45,
      label: '泛光强度',
      hint: '吸积盘周围的辉光。电影镜头里的柔光就是靠这个，太低会显得干硬。',
    },
    {
      key: 'bloomRadius', group: 'post', type: 'range',
      min: 0.0, max: 2.0, step: 0.01, def: 1.0,
      label: '泛光半径',
      hint: '辉光扩散的范围。',
    },
    {
      key: 'chromatic', group: 'post', type: 'range',
      min: 0.0, max: 1.0, step: 0.01, def: 0.18,
      label: '镜头色散',
      hint: '画面边缘的横向色差，模拟真实摄影镜头。',
    },
    {
      key: 'vignette', group: 'post', type: 'range',
      min: 0.0, max: 1.0, step: 0.01, def: 0.45,
      label: '暗角',
      hint: '四周压暗，让视线集中到黑洞上。',
    },
    {
      key: 'grain', group: 'post', type: 'range',
      min: 0.0, max: 0.5, step: 0.01, def: 0.06,
      label: '胶片颗粒',
      hint: '叠加一点噪点，消除色带并增加电影质感。',
    },
    {
      key: 'temporalAA', group: 'post', type: 'toggle', def: true,
      label: '时间累积抗锯齿',
      hint: '静止时逐帧累积采样（最多 64 帧），星点和盘的细节会越来越锐利干净。转动视角时自动清零。',
    },
    {
      key: 'autoRotate', group: 'post', type: 'toggle', def: true,
      label: '自动旋转',
      hint: '镜头缓慢环绕黑洞。手动拖动时自动暂停。',
    },

    /* ===== 5. 画质 ====================================================== */
    {
      key: 'quality', group: 'quality', type: 'select', def: 'high',
      label: '渲染质量',
      hint: '步数越多，光线追踪越精确（爱因斯坦环、高阶像更准确），但更吃显卡。',
      options: [
        { value: 'low', label: '低 · 160 步' },
        { value: 'medium', label: '中 · 240 步' },
        { value: 'high', label: '高 · 340 步' },
        { value: 'ultra', label: '极高 · 512 步' },
      ],
      quality: true,
    },
    {
      key: 'renderScale', group: 'quality', type: 'range',
      min: 0.4, max: 1.0, step: 0.05, def: 0.85,
      label: '分辨率缩放', unit: '×',
      hint: '内部渲染分辨率相对窗口的比例。调低可以显著提升帧率（配合时间累积，静态时依然很清晰）。',
      quality: true,
    },
  ];

  /* 侧边栏分组顺序与标题 */
  const GROUPS = [
    { id: 'hole', title: '黑洞本体', icon: '◍' },
    { id: 'disk', title: '吸积盘', icon: '◠' },
    { id: 'lens', title: '引力透镜', icon: '◟' },
    { id: 'post', title: '镜头与后期', icon: '◐' },
    { id: 'quality', title: '画质', icon: '◈' },
  ];

  /* 质量档位 → 光线积分步数。
     下限不能太低：步数不足时透镜拱形光环会被截断成虚线。
     160 步是可用的最低值，再低就不像黑洞了。 */
  const QUALITY_STEPS = { low: 160, medium: 240, high: 340, ultra: 512 };

  /* ------------------------------------------------------------------------
   *  state：默认值实例化
   * ---------------------------------------------------------------------- */
  const state = {};
  const defsByKey = {};
  for (const d of DEFS) {
    state[d.key] = d.def;
    defsByKey[d.key] = d;
  }

  const listeners = new Set();

  function emit(keys) {
    const changed = keys && keys.length ? keys : Object.keys(state);
    for (const fn of listeners) {
      try { fn(changed, state); } catch (err) { console.error('[BH] listener error:', err); }
    }
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('bh:params', { detail: { changed, state } }));
    }
  }

  /* ------------------------------------------------------------------------
   *  API
   * ---------------------------------------------------------------------- */
  const BH = {
    /** 参数定义表（只读使用） */
    DEFS,
    GROUPS,
    /** 实时参数对象：渲染循环每帧直接读 */
    state,

    /** 取定义 */
    def(key) { return defsByKey[key]; },

    /**
     * 修改参数。会做范围夹取 + 类型转换，然后通知订阅者。
     * @param {string} key
     * @param {number|string|boolean} value
     * @returns {boolean} 值是否真的变了
     */
    set(key, value) {
      const d = defsByKey[key];
      if (!d) { console.warn('[BH] unknown param:', key); return false; }

      let v = value;
      if (d.type === 'range') {
        v = Number(v);
        if (!Number.isFinite(v)) return false;
        v = Math.min(d.max, Math.max(d.min, v));
      } else if (d.type === 'toggle') {
        v = (v === true || v === 'true' || v === 1 || v === '1');
      } else if (d.type === 'select') {
        if (!d.options.some((o) => o.value === v)) return false;
      }

      if (state[key] === v) return false;
      state[key] = v;
      emit([key]);
      return true;
    },

    /** 批量修改：{ key: value, ... } */
    setMany(obj) {
      const changed = [];
      for (const k of Object.keys(obj)) {
        const d = defsByKey[k];
        if (!d) continue;
        let v = obj[k];
        if (d.type === 'range') {
          v = Number(v);
          if (!Number.isFinite(v)) continue;
          v = Math.min(d.max, Math.max(d.min, v));
        }
        if (state[k] === v) continue;
        state[k] = v;
        changed.push(k);
      }
      if (changed.length) emit(changed);
      return changed;
    },

    /** 恢复默认值（全部参数） */
    reset() {
      const changed = [];
      for (const d of DEFS) {
        if (state[d.key] !== d.def) { state[d.key] = d.def; changed.push(d.key); }
      }
      if (changed.length) emit(changed);
      return changed;
    },

    /** 恢复某一分组 */
    resetGroup(groupId) {
      const changed = [];
      for (const d of DEFS) {
        if (d.group !== groupId) continue;
        if (state[d.key] !== d.def) { state[d.key] = d.def; changed.push(d.key); }
      }
      if (changed.length) emit(changed);
      return changed;
    },

    /**
     * 订阅参数变化。
     * @param {(changed: string[], state: object) => void} fn
     * @returns {() => void} 取消订阅
     */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** 当前积分步数 */
    steps() { return QUALITY_STEPS[state.quality] || QUALITY_STEPS.high; },

    /** 该参数是否影响物理积分（影响则需要重置累积缓冲） */
    isWarp(key) { return !!(defsByKey[key] && defsByKey[key].warp); },
  };

  window.BH = BH;
})();
