/* ============================================================================
 *  GARGANTUA · 轨道相机 / Orbit camera
 *  ---------------------------------------------------------------------------
 *  鼠标拖动 = 环绕旋转；滚轮 = 推拉；带惯性阻尼；可选自动旋转。
 *  对外只暴露一个极简接口：camera.update(dt) 后读 camera.* 的向量。
 * ==========================================================================*/
(function () {
  'use strict';

  const TAU = Math.PI * 2;

  /* 极角限制：避免穿到盘的正上方 / 正下方导致画面突变 */
  const POLAR_MIN = 0.055;
  const POLAR_MAX = Math.PI - 0.055;

  class OrbitCamera {
    constructor(canvas) {
      this.canvas = canvas;

      /* ---- 目标状态 ---- */
      this.azimuth = 0.62;          // 水平角（弧度）
      this.polar = 1.475;           // 极角（0=正上方, PI/2=盘面内, PI=正下方）
      this.distance = 26.0;         // 距黑洞中心
      this.fov = 42 * Math.PI / 180;

      /* ---- 惯性 ---- */
      this.velAzimuth = 0;
      this.velPolar = 0;
      this.damping = 0.86;

      /* ---- 自动旋转 ---- */
      this.autoRotate = true;
      this.autoSpeed = 0.055;       // rad/s
      this.userInteracting = false;
      this.idleTimer = 0;

      /* ---- 尺度自适应 ----
         黑洞质量会直接缩放吸积盘的世界尺寸。如果相机距离固定不变，
         调大质量就会把镜头"埋"进盘里。所以这里按盘的外缘半径
         自动把相机推到合适的距离。 */
      this.baseDistance = 26.0;     // 参考距离（质量=1 时）
      this.userZoom = 1.0;          // 用户滚轮产生的缩放系数
      this.sceneRadius = 12.0;      // 吸积盘外缘的世界半径（由渲染器设置）

      /* ---- 平滑过渡（双击复位用）---- */
      this.target = null;

      /* ---- 输出向量 ---- */
      this.position = [0, 0, 0];
      this.right = [1, 0, 0];
      this.up = [0, 1, 0];
      this.forward = [0, 0, -1];
      this.tanHalfFov = Math.tan(this.fov * 0.5);
      this.aspect = 1;

      this._bind();
      this.update(0);
    }

    /* ---------------------------------------------------------------- 输入 */
    _bind() {
      const c = this.canvas;
      if (!c) return;

      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      let pointerId = null;

      const onDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        dragging = true;
        pointerId = e.pointerId;
        lastX = e.clientX;
        lastY = e.clientY;
        this.userInteracting = true;
        this.idleTimer = 0;
        this.velAzimuth = 0;
        this.velPolar = 0;
        this.target = null;
        try { c.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        c.style.cursor = 'grabbing';
        e.preventDefault();
      };

      const onMove = (e) => {
        if (!dragging || e.pointerId !== pointerId) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;

        const sens = 0.0032;
        const dAz = -dx * sens;
        const dPol = -dy * sens;

        this.azimuth += dAz;
        this.polar += dPol;

        /* 记录速度用于惯性 */
        this.velAzimuth = dAz;
        this.velPolar = dPol;

        this._clamp();
        this.idleTimer = 0;
        e.preventDefault();
      };

      const onUp = (e) => {
        if (!dragging) return;
        dragging = false;
        try { c.releasePointerCapture(pointerId); } catch (_) { /* ignore */ }
        pointerId = null;
        this.userInteracting = false;
        c.style.cursor = 'grab';
      };

      c.addEventListener('pointerdown', onDown, { passive: false });
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);

      /* ---- 滚轮缩放 ---- */
      const onWheel = (e) => {
        e.preventDefault();
        const factor = Math.exp(Math.sign(e.deltaY) * 0.075 * Math.min(Math.abs(e.deltaY) / 100 + 0.35, 2.2));
        this.userZoom *= factor;
        this.userZoom = Math.min(3.4, Math.max(0.16, this.userZoom));
        this.target = null;
        this.idleTimer = 0;
      };
      c.addEventListener('wheel', onWheel, { passive: false });

      /* ---- 双击复位 ---- */
      c.addEventListener('dblclick', (e) => {
        e.preventDefault();
        this.resetView();
      });

      /* ---- 触摸双指缩放 ---- */
      let pinchDist = 0;
      c.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
          pinchDist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
        }
      }, { passive: true });

      c.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2) {
          const d = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
          if (pinchDist > 0) {
            this.userZoom *= pinchDist / Math.max(d, 1);
            this.userZoom = Math.min(3.4, Math.max(0.16, this.userZoom));
          }
          pinchDist = d;
          e.preventDefault();
        }
      }, { passive: false });

      c.addEventListener('touchend', () => { pinchDist = 0; }, { passive: true });

      /* ---- 阻止右键菜单，方便后续扩展 ---- */
      c.addEventListener('contextmenu', (e) => e.preventDefault());

      c.style.cursor = 'grab';
      c.style.touchAction = 'none';
    }

    /* ---------------------------------------------------------------- 控制 */
    _clamp() {
      /* 极角夹取 */
      this.polar = Math.min(POLAR_MAX, Math.max(POLAR_MIN, this.polar));
      /* 方位角归一化，避免浮点膨胀 */
      if (this.azimuth > TAU) this.azimuth -= TAU;
      if (this.azimuth < -TAU) this.azimuth += TAU;
    }

    resetView() {
      this.target = {
        azimuth: 0.62,
        polar: 1.475,
        t: 0,
      };
      this.userZoom = 1.0;
      this.velAzimuth = 0;
      this.velPolar = 0;
    }

    setAutoRotate(on) { this.autoRotate = !!on; }

    /**
     * 记录吸积盘的世界半径。相机距离每帧按视口宽高比重算，
     * 保证竖屏（手机）下盘也不会被裁掉。
     * @param {number} diskOuterWorld 吸积盘外缘的世界半径
     */
    setSceneScale(diskOuterWorld) {
      this.sceneRadius = Math.max(1, diskOuterWorld);
    }

    /**
     * 计算"刚好装下整个盘"的距离。
     * 竖直半视场角固定，水平半视场角随宽高比变化，
     * 所以取两者中较小的那个来约束，竖屏时相机会自动后退。
     */
    _fitDistance() {
      const tanV = Math.tan(this.fov * 0.5);
      const tanH = tanV * this.aspect;
      const tanMin = Math.max(Math.min(tanV, tanH), 1e-3);
      /* 盘被引力透镜后的像会略微超出盘本身的半径，留 12% 余量 */
      return (this.sceneRadius * 1.12) / tanMin;
    }

    /** 平滑逼近目标（指数插值） */
    _applyTarget(dt) {
      const t = this.target;
      if (!t) return;
      t.t += dt;
      const k = 1 - Math.exp(-dt * 7.0);

      this.azimuth += (t.azimuth - this.azimuth) * k;
      this.polar += (t.polar - this.polar) * k;

      const nearA = Math.abs(t.azimuth - this.azimuth) < 1e-3;
      const nearP = Math.abs(t.polar - this.polar) < 1e-3;
      if ((nearA && nearP) || t.t > 3.0) {
        this.azimuth = t.azimuth;
        this.polar = t.polar;
        this.target = null;
      }
    }

    /* ---------------------------------------------------------------- 更新 */
    update(dt) {
      dt = Math.min(Math.max(dt, 0), 0.1);

      this._applyTarget(dt);

      /* 惯性 */
      if (!this.userInteracting) {
        if (Math.abs(this.velAzimuth) > 1e-5 || Math.abs(this.velPolar) > 1e-5) {
          this.azimuth += this.velAzimuth;
          this.polar += this.velPolar;
          const decay = Math.pow(this.damping, dt * 60);
          this.velAzimuth *= decay;
          this.velPolar *= decay;
          this._clamp();
        } else {
          this.velAzimuth = 0;
          this.velPolar = 0;
        }
      }

      /* 自动旋转：用户松手 2.2 秒后恢复 */
      this.idleTimer += dt;
      if (this.autoRotate && !this.userInteracting && !this.target && this.idleTimer > 2.2) {
        this.azimuth += this.autoSpeed * dt;
      }

      this._clamp();

      /* ---- 距离 = 自适应取景距离 × 用户缩放 ---- */
      this.baseDistance = this._fitDistance();
      this.distance = Math.min(600, Math.max(3.0, this.baseDistance * this.userZoom));

      /* ---- 球坐标 → 笛卡尔 ---- */
      const sp = Math.sin(this.polar);
      const cp = Math.cos(this.polar);
      const sa = Math.sin(this.azimuth);
      const ca = Math.cos(this.azimuth);

      const px = this.distance * sp * ca;
      const py = this.distance * cp;
      const pz = this.distance * sp * sa;

      this.position[0] = px;
      this.position[1] = py;
      this.position[2] = pz;

      /* ---- 构建正交基：始终看向原点 ---- */
      let fx = -px, fy = -py, fz = -pz;
      const fl = Math.hypot(fx, fy, fz) || 1;
      fx /= fl; fy /= fl; fz /= fl;
      this.forward[0] = fx;
      this.forward[1] = fy;
      this.forward[2] = fz;

      /* right = normalize(cross(forward, worldUp)) */
      let rx = fz * 0 - fy * 0; // 简化：cross(f, (0,1,0)) = (f.z*1 - f.y*0, ...)
      rx = fz;
      let ry = 0;
      let rz = -fx;
      const rl = Math.hypot(rx, ry, rz) || 1;
      rx /= rl; ry /= rl; rz /= rl;

      /* 若视线接近竖直（|forward.y| ~ 1），right 退化，改用世界 X 轴 */
      if (rl < 1e-4) {
        rx = 1; ry = 0; rz = 0;
      }
      this.right[0] = rx;
      this.right[1] = ry;
      this.right[2] = rz;

      /* up = cross(right, forward) */
      this.up[0] = ry * fz - rz * fy;
      this.up[1] = rz * fx - rx * fz;
      this.up[2] = rx * fy - ry * fx;

      const ul = Math.hypot(this.up[0], this.up[1], this.up[2]) || 1;
      this.up[0] /= ul; this.up[1] /= ul; this.up[2] /= ul;

      this.tanHalfFov = Math.tan(this.fov * 0.5);
    }

    setViewport(w, h) {
      this.aspect = h > 0 ? w / h : 1;
    }

    /**
     * 把世界坐标点投到屏幕像素坐标（用于 UI 定位，可选）
     * @returns {[number, number] | null}
     */
    project(world, w, h) {
      const dx = world[0] - this.position[0];
      const dy = world[1] - this.position[1];
      const dz = world[2] - this.position[2];
      const zf = dx * this.forward[0] + dy * this.forward[1] + dz * this.forward[2];
      if (zf <= 1e-4) return null;
      const xr = dx * this.right[0] + dy * this.right[1] + dz * this.right[2];
      const yu = dx * this.up[0] + dy * this.up[1] + dz * this.up[2];
      const tanF = this.tanHalfFov;
      const nx = xr / (zf * tanF * this.aspect);
      const ny = yu / (zf * tanF);
      return [(nx * 0.5 + 0.5) * w, (0.5 - ny * 0.5) * h];
    }
  }

  window.OrbitCamera = OrbitCamera;
})();
