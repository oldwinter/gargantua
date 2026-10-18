/* ============================================================================
 *  GARGANTUA · WebGL2 渲染器 / Renderer
 *  ---------------------------------------------------------------------------
 *  管线：
 *    1. raytrace   → scene      (RGBA16F, 内部渲染分辨率)
 *    2. accumulate → accumA/B   (RGBA16F)  —— 乒乓式时间累积抗锯齿
 *    3. brightpass → bloom[0]   (1/2 分辨率)
 *    4. downsample → bloom[1..N]           —— 逐级 1/2
 *    5. upsample   → bloom[N-1..0]         —— 逐级加性叠加回来
 *    6. composite  → 默认帧缓冲（ACES 色调映射 + 色差 + 暗角 + 颗粒）
 *
 *  设计要点（都是踩过的坑）：
 *    · 任何一次 draw 的采样源都不能是它正在写入的纹理（反馈环 → 未定义行为），
 *      所以累积用两张缓冲乒乓，泛光上采样用加性混合而不是读回自身。
 *    · 全屏三角形着色器是纯光线追踪，MSAA 对它毫无帮助（没有几何边缘），
 *      抗锯齿只能靠亚像素抖动 + 时间累积。
 *    · "#version" 必须是第一行，宏只能插在它之后。
 * ==========================================================================*/
(function () {
  'use strict';

  const MAX_SAMPLES = 64;
  const BLOOM_LEVELS = 6;

  /* 累积的历史权重下限：保证盘面持续旋转时不会拖出明显残影 */
  const MIN_BLEND = 0.10;

  /* ---------------------------------------------------------------------- */
  /*  GLSL 编译辅助                                                         */
  /* ---------------------------------------------------------------------- */

  function annotateSource(src, log) {
    const m = /ERROR:\s*\d+:(\d+)/.exec(log || '');
    if (!m) return '';
    const line = parseInt(m[1], 10);
    const lines = src.split('\n');
    const from = Math.max(0, line - 4);
    const to = Math.min(lines.length, line + 3);
    const out = [];
    for (let i = from; i < to; i++) {
      out.push((i + 1 === line ? '>> ' : '   ') + String(i + 1).padStart(4) + ' | ' + lines[i]);
    }
    return '\n' + out.join('\n');
  }

  function compileShader(gl, type, source) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) || '(no info log)';
      gl.deleteShader(sh);
      throw new Error('Shader compile failed:\n' + log + annotateSource(source, log));
    }
    return sh;
  }

  function createProgram(gl, vsSrc, fsSrc) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog) || '(no info log)';
      gl.deleteProgram(prog);
      throw new Error('Program link failed:\n' + log);
    }
    return prog;
  }

  function getUniforms(gl, prog) {
    const u = Object.create(null);
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i);
      if (!info) continue;
      let name = info.name;
      if (name.endsWith('[0]')) name = name.slice(0, -3);
      u[name] = gl.getUniformLocation(prog, info.name);
    }
    return u;
  }

  /* ---------------------------------------------------------------------- */
  /*  渲染目标                                                              */
  /* ---------------------------------------------------------------------- */

  class RenderTarget {
    constructor(gl, w, h, opts) {
      opts = opts || {};
      this.gl = gl;
      this.width = Math.max(1, Math.floor(w));
      this.height = Math.max(1, Math.floor(h));
      this.internalFormat = opts.internalFormat || gl.RGBA16F;
      this.type = opts.type || gl.HALF_FLOAT;
      this.filter = opts.filter || gl.LINEAR;

      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, this.internalFormat, this.width, this.height, 0,
        gl.RGBA, this.type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this.filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      this.fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error('Framebuffer incomplete (0x' + status.toString(16) + ') at ' +
          this.width + 'x' + this.height);
      }
    }

    bind() {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, this.width, this.height);
    }

    dispose() {
      const gl = this.gl;
      if (this.tex) gl.deleteTexture(this.tex);
      if (this.fbo) gl.deleteFramebuffer(this.fbo);
      this.tex = null;
      this.fbo = null;
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  渲染器                                                                */
  /* ---------------------------------------------------------------------- */

  class Renderer {
    constructor(canvas, camera) {
      this.canvas = canvas;
      this.camera = camera;

      const gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false,
      });
      if (!gl) throw new Error('WEBGL2_UNAVAILABLE');
      this.gl = gl;

      this.colorBufferFloat = !!gl.getExtension('EXT_color_buffer_float');
      gl.getExtension('OES_texture_float_linear');

      if (!this.colorBufferFloat) {
        console.warn('[GARGANTUA] EXT_color_buffer_float 不可用，退化为 LDR 渲染目标（泛光效果会打折扣）。');
      }

      this.hdrFormat = this.colorBufferFloat ? gl.RGBA16F : gl.RGBA8;
      this.hdrType = this.colorBufferFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

      this.renderScale = 0.85;
      this.sampleCount = 0;
      this.frame = 0;
      this.time = 0;
      this.cssWidth = 0;
      this.cssHeight = 0;
      this.dpr = 1;

      this._lastViewSig = '';
      this._jitterSeq = 0;
      this._pingpong = 0;
      this._programs = {};
      this._uniforms = {};
      this._vao = null;
      this._targets = { scene: null, accumA: null, accumB: null, bloom: [] };

      this._buildPrograms();
      this._vao = gl.createVertexArray();
      this._initialized = true;
    }

    /* ------------------------------------------------------------------ */
    _buildPrograms() {
      const gl = this.gl;
      const S = window.SHADERS;
      if (!S) throw new Error('window.SHADERS 未定义：请确认 js/shaders.js 在 renderer.js 之前加载。');

      this._programs.blackhole = createProgram(gl, S.fullscreenVS, this._patch(S.blackholeFS));
      this._programs.accumulate = createProgram(gl, S.fullscreenVS, S.accumulateFS);
      this._programs.brightPass = createProgram(gl, S.fullscreenVS, S.brightPassFS);
      this._programs.downsample = createProgram(gl, S.fullscreenVS, S.downsampleFS);
      this._programs.upsample = createProgram(gl, S.fullscreenVS, S.upsampleFS);
      this._programs.composite = createProgram(gl, S.fullscreenVS, S.compositeFS);

      for (const k of Object.keys(this._programs)) {
        this._uniforms[k] = getUniforms(gl, this._programs[k]);
      }
    }

    /** 注入积分步数宏。#version 必须是第一行，所以宏插在它后面。 */
    _patch(src) {
      const steps = (window.BH && window.BH.steps) ? window.BH.steps() : 340;
      const define = '#define MAX_STEPS ' + steps + '\n';
      const m = /^(\s*#version[^\n]*\n)/.exec(src);
      return m ? src.slice(0, m[0].length) + define + src.slice(m[0].length)
               : define + src;
    }

    /** 质量档位变化后重建主着色器（步数是编译期常量，循环可被完全展开） */
    rebuildMainProgram() {
      const gl = this.gl;
      const next = createProgram(gl, window.SHADERS.fullscreenVS,
        this._patch(window.SHADERS.blackholeFS));
      /* 只有新程序编译成功才替换旧的 */
      if (this._programs.blackhole) gl.deleteProgram(this._programs.blackhole);
      this._programs.blackhole = next;
      this._uniforms.blackhole = getUniforms(gl, next);
      this.resetAccumulation();
    }

    /* ------------------------------------------------------------------ */
    _disposeTargets() {
      const t = this._targets;
      for (const k of ['scene', 'accumA', 'accumB']) {
        if (t[k]) { t[k].dispose(); t[k] = null; }
      }
      for (const b of t.bloom) b.dispose();
      t.bloom = [];
    }

    _ensureTargets(w, h) {
      const t = this._targets;
      if (t.scene && t.scene.width === w && t.scene.height === h) return;

      this._disposeTargets();
      const gl = this.gl;
      const fmt = { internalFormat: this.hdrFormat, type: this.hdrType };

      t.scene = new RenderTarget(gl, w, h, fmt);
      t.accumA = new RenderTarget(gl, w, h, fmt);
      t.accumB = new RenderTarget(gl, w, h, fmt);

      let bw = Math.max(1, w >> 1);
      let bh = Math.max(1, h >> 1);
      for (let i = 0; i < BLOOM_LEVELS; i++) {
        if (bw < 8 || bh < 8) break;
        t.bloom.push(new RenderTarget(gl, bw, bh, fmt));
        bw >>= 1;
        bh >>= 1;
      }
      if (t.bloom.length === 0) {
        t.bloom.push(new RenderTarget(gl, Math.max(4, w >> 1), Math.max(4, h >> 1), fmt));
      }

      this.resetAccumulation();
    }

    /* ------------------------------------------------------------------ */
    resize(cssWidth, cssHeight, dpr) {
      const maxPixels = 2.6e6; /* 上限，避免 4K 屏把显卡打爆 */
      let w = Math.max(2, Math.floor(cssWidth * dpr * this.renderScale));
      let h = Math.max(2, Math.floor(cssHeight * dpr * this.renderScale));

      const px = w * h;
      if (px > maxPixels) {
        const k = Math.sqrt(maxPixels / px);
        w = Math.max(2, Math.floor(w * k));
        h = Math.max(2, Math.floor(h * k));
      }

      /* 画布本身按 CSS 尺寸 × DPR，保证 UI 元素清晰 */
      const cw = Math.max(1, Math.floor(cssWidth * dpr));
      const ch = Math.max(1, Math.floor(cssHeight * dpr));
      if (this.canvas.width !== cw || this.canvas.height !== ch) {
        this.canvas.width = cw;
        this.canvas.height = ch;
      }

      this._ensureTargets(w, h);
      this.cssWidth = cssWidth;
      this.cssHeight = cssHeight;
      this.dpr = dpr;
      this.camera.setViewport(cssWidth, cssHeight);
      this.resetAccumulation();
    }

    setRenderScale(scale) {
      const s = Math.min(1, Math.max(0.4, scale));
      if (Math.abs(s - this.renderScale) < 1e-4) return;
      this.renderScale = s;
      if (this.cssWidth) this.resize(this.cssWidth, this.cssHeight, this.dpr);
    }

    resetAccumulation() {
      this.sampleCount = 0;
      this._jitterSeq = 0;
      this._pingpong = 0;
    }

    /* ------------------------------------------------------------------ */
    _drawQuad() {
      const gl = this.gl;
      gl.bindVertexArray(this._vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    _setTex(unit, tex) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    }

    /* ------------------------------------------------------------------ */
    /** 相机 + 物理参数签名：变化则重置累积（否则会拖影） */
    _viewSignature(s) {
      const c = this.camera;
      const q = (v) => Math.round(v * 1e4) / 1e4;
      return [
        q(c.azimuth), q(c.polar), q(c.distance),
        s.blackHoleMass, s.diskInner, s.diskOuter, s.diskThickness,
        s.diskTemp, s.lensing, s.diskTurbulence, s.diskBrightness,
        s.dopplerBeaming, s.diskOpacity, s.starBrightness, s.lensAberration,
      ].join('|');
    }

    /* ------------------------------------------------------------------ */
    render(dt) {
      if (!this._initialized) return;
      const gl = this.gl;
      const s = (window.BH && window.BH.state) || {};
      const t = this._targets;
      if (!t.scene) return;

      this.time += dt;
      this.frame++;

      const sig = this._viewSignature(s);
      const viewChanged = sig !== this._lastViewSig;
      if (viewChanged) {
        this._lastViewSig = sig;
        this.sampleCount = 0;
      }

      const useAA = !!s.temporalAA;
      const converged = this.sampleCount >= MAX_SAMPLES;
      const n = this.sampleCount;

      /* ---- 亚像素抖动：Halton(2,3) ---- */
      let jx = 0;
      let jy = 0;
      if (useAA && !converged) {
        const k = (this._jitterSeq % 64) + 1;
        this._jitterSeq++;
        jx = halton(k, 2) - 0.5;
        jy = halton(k, 3) - 0.5;
      }

      const W = t.scene.width;
      const H = t.scene.height;
      const cam = this.camera;

      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);

      /* ================================================================
       *  PASS 1 — 测地线光线追踪
       * ============================================================== */
      t.scene.bind();
      gl.useProgram(this._programs.blackhole);
      const u = this._uniforms.blackhole;

      const rs = Math.max(0.05, s.blackHoleMass || 1.0);

      if (u.uResolution) gl.uniform2f(u.uResolution, W, H);
      if (u.uTime) gl.uniform1f(u.uTime, this.time);
      if (u.uJitter) gl.uniform2f(u.uJitter, jx, jy);
      if (u.uCamPos) gl.uniform3f(u.uCamPos, cam.position[0], cam.position[1], cam.position[2]);
      if (u.uCamRight) gl.uniform3f(u.uCamRight, cam.right[0], cam.right[1], cam.right[2]);
      if (u.uCamUp) gl.uniform3f(u.uCamUp, cam.up[0], cam.up[1], cam.up[2]);
      if (u.uCamFwd) gl.uniform3f(u.uCamFwd, cam.forward[0], cam.forward[1], cam.forward[2]);
      if (u.uTanHalfFov) gl.uniform1f(u.uTanHalfFov, cam.tanHalfFov);
      if (u.uAspect) gl.uniform1f(u.uAspect, cam.aspect);

      if (u.uRs) gl.uniform1f(u.uRs, rs);
      if (u.uM) gl.uniform1f(u.uM, rs * 0.5);

      const diskInner = Math.max(1.05 * rs, (s.diskInner || 3.0) * rs);
      const diskOuter = Math.max(diskInner * 1.25, (s.diskOuter || 12.0) * rs);

      /* 相机距离要跟着黑洞的物理尺度走，否则调大质量会把镜头埋进盘里 */
      if (this._lastSceneScale !== diskOuter) {
        this._lastSceneScale = diskOuter;
        cam.setSceneScale(diskOuter);
      }

      if (u.uDiskInner) gl.uniform1f(u.uDiskInner, diskInner);
      if (u.uDiskOuter) gl.uniform1f(u.uDiskOuter, diskOuter);
      if (u.uDiskThickness) gl.uniform1f(u.uDiskThickness, (s.diskThickness || 0) * rs);
      if (u.uDiskTemp) gl.uniform1f(u.uDiskTemp, num(s.diskTemp, 8200));
      if (u.uDiskBrightness) gl.uniform1f(u.uDiskBrightness, num(s.diskBrightness, 1.35));
      if (u.uDoppler) gl.uniform1f(u.uDoppler, num(s.dopplerBeaming, 0.4));
      if (u.uTurbulence) gl.uniform1f(u.uTurbulence, num(s.diskTurbulence, 0.62));
      if (u.uDiskSpeed) gl.uniform1f(u.uDiskSpeed, num(s.diskSpeed, 1.0));
      if (u.uDiskOpacity) gl.uniform1f(u.uDiskOpacity, num(s.diskOpacity, 0.96));
      if (u.uLensing) gl.uniform1f(u.uLensing, num(s.lensing, 1.0));
      if (u.uStarBrightness) gl.uniform1f(u.uStarBrightness, num(s.starBrightness, 1.0));
      if (u.uLensAberration) gl.uniform1f(u.uLensAberration, num(s.lensAberration, 0.35));
      if (u.uPhotonRing) gl.uniform1f(u.uPhotonRing, num(s.photonRing, 0.7));

      this._drawQuad();

      /* ================================================================
       *  PASS 2 — 时间累积（乒乓）
       * ============================================================== */
      let finalTex = t.scene;

      if (useAA && n > 0) {
        const src = this._pingpong === 0 ? t.accumA : t.accumB;
        const dst = this._pingpong === 0 ? t.accumB : t.accumA;

        /* 新样本的权重：随帧数下降，但不低于 MIN_BLEND，
           以免盘面持续旋转时被平均成一片糊。 */
        const blend = Math.max(1.0 / (n + 1), MIN_BLEND);

        dst.bind();
        gl.useProgram(this._programs.accumulate);
        const ua = this._uniforms.accumulate;
        this._setTex(0, t.scene.tex);
        if (ua.uCurrent) gl.uniform1i(ua.uCurrent, 0);
        this._setTex(1, src.tex);
        if (ua.uHistory) gl.uniform1i(ua.uHistory, 1);
        if (ua.uBlend) gl.uniform1f(ua.uBlend, viewChanged ? 1.0 : blend);
        this._drawQuad();

        this._pingpong = 1 - this._pingpong;
        finalTex = dst;
      } else if (useAA) {
        /* 第一帧：直接拷贝到 A，建立历史。
           之后 _pingpong 必须指回 0，让下一帧以 accumA 作为历史源。 */
        t.accumA.bind();
        gl.useProgram(this._programs.accumulate);
        const ua = this._uniforms.accumulate;
        this._setTex(0, t.scene.tex);
        if (ua.uCurrent) gl.uniform1i(ua.uCurrent, 0);
        this._setTex(1, t.scene.tex);
        if (ua.uHistory) gl.uniform1i(ua.uHistory, 1);
        if (ua.uBlend) gl.uniform1f(ua.uBlend, 1.0);
        this._drawQuad();
        this._pingpong = 0;
        finalTex = t.accumA;
      }

      if (useAA && this.sampleCount < MAX_SAMPLES) this.sampleCount++;

      /* ================================================================
       *  PASS 3 — Bloom
       * ============================================================== */
      const levels = t.bloom;
      const bloomStrength = num(s.bloomStrength, 0.85);
      const bloomOn = bloomStrength > 0.001 && levels.length > 0;

      if (bloomOn) {
        /* ---- 亮度提取 ---- */
        levels[0].bind();
        gl.useProgram(this._programs.brightPass);
        const ub = this._uniforms.brightPass;
        this._setTex(0, finalTex.tex);
        if (ub.uSource) gl.uniform1i(ub.uSource, 0);
        if (ub.uTexel) gl.uniform2f(ub.uTexel, 1 / finalTex.width, 1 / finalTex.height);
        if (ub.uThreshold) gl.uniform1f(ub.uThreshold, 0.85);
        if (ub.uSoftKnee) gl.uniform1f(ub.uSoftKnee, 0.6);
        this._drawQuad();

        /* ---- 逐级下采样 ---- */
        gl.useProgram(this._programs.downsample);
        const ud = this._uniforms.downsample;
        if (ud.uSource) gl.uniform1i(ud.uSource, 0);
        for (let i = 1; i < levels.length; i++) {
          levels[i].bind();
          this._setTex(0, levels[i - 1].tex);
          if (ud.uTexel) {
            gl.uniform2f(ud.uTexel, 1 / levels[i - 1].width, 1 / levels[i - 1].height);
          }
          this._drawQuad();
        }

        /* ---- 逐级上采样：加性混合回上一层 ----
           读 levels[i]，写 levels[i-1]，两者不同纹理，没有反馈环。 */
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(this._programs.upsample);
        const uu = this._uniforms.upsample;
        if (uu.uSource) gl.uniform1i(uu.uSource, 0);
        const radius = num(s.bloomRadius, 1.0);
        for (let i = levels.length - 1; i > 0; i--) {
          levels[i - 1].bind();
          this._setTex(0, levels[i].tex);
          if (uu.uTexel) {
            gl.uniform2f(uu.uTexel, 1 / levels[i].width, 1 / levels[i].height);
          }
          if (uu.uRadius) gl.uniform1f(uu.uRadius, radius);
          this._drawQuad();
        }
        gl.disable(gl.BLEND);
      }

      /* ================================================================
       *  PASS 4 — 合成到屏幕
       * ============================================================== */
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(this._programs.composite);
      const uc = this._uniforms.composite;

      this._setTex(0, finalTex.tex);
      if (uc.uScene) gl.uniform1i(uc.uScene, 0);
      this._setTex(1, bloomOn ? levels[0].tex : finalTex.tex);
      if (uc.uBloom) gl.uniform1i(uc.uBloom, 1);

      if (uc.uResolution) gl.uniform2f(uc.uResolution, this.canvas.width, this.canvas.height);
      if (uc.uTime) gl.uniform1f(uc.uTime, this.time);
      if (uc.uExposure) gl.uniform1f(uc.uExposure, num(s.exposure, 1.0));
      if (uc.uBloomStrength) gl.uniform1f(uc.uBloomStrength, bloomOn ? bloomStrength : 0.0);
      if (uc.uChromatic) gl.uniform1f(uc.uChromatic, num(s.chromatic, 0.18));
      if (uc.uVignette) gl.uniform1f(uc.uVignette, num(s.vignette, 0.45));
      if (uc.uGrain) gl.uniform1f(uc.uGrain, num(s.grain, 0.06));

      this._drawQuad();
      gl.bindVertexArray(null);
    }

    /* ------------------------------------------------------------------ */
    getInfo() {
      const gl = this.gl;
      let renderer = gl.getParameter(gl.RENDERER);
      try {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      } catch (_) { /* 某些浏览器禁止读取 */ }
      return {
        renderer: renderer,
        version: gl.getParameter(gl.VERSION),
        floatTargets: this.colorBufferFloat,
        sceneWidth: this._targets.scene ? this._targets.scene.width : 0,
        sceneHeight: this._targets.scene ? this._targets.scene.height : 0,
        bloomLevels: this._targets.bloom.length,
      };
    }

    dispose() {
      this._disposeTargets();
      const gl = this.gl;
      for (const k of Object.keys(this._programs)) {
        if (this._programs[k]) gl.deleteProgram(this._programs[k]);
      }
      this._programs = {};
      if (this._vao) gl.deleteVertexArray(this._vao);
      this._initialized = false;
    }
  }

  /* ---- 小工具 ---- */
  function num(v, dflt) {
    return (typeof v === 'number' && Number.isFinite(v)) ? v : dflt;
  }

  /** Halton 低差异序列，用于亚像素抖动 */
  function halton(index, base) {
    let f = 1;
    let r = 0;
    let i = index;
    while (i > 0) {
      f /= base;
      r += f * (i % base);
      i = Math.floor(i / base);
    }
    return r;
  }

  window.GargantuaRenderer = Renderer;
  window.GARGANTUA_MAX_SAMPLES = MAX_SAMPLES;
})();
