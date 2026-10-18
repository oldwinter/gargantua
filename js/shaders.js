/* ============================================================================
 *  GARGANTUA · 着色器集 / GLSL ES 3.00 shader set
 *  ---------------------------------------------------------------------------
 *  全部为 WebGL2 (GLSL ES 3.00) 着色器。渲染器在编译前会把
 *  "__MAX_STEPS__" 替换成实际的积分步数（96 / 176 / 288 / 448）。
 *
 *  核心：Schwarzschild 度规下的零测地线积分。
 *  在笛卡尔坐标下，光线方程可以写成（Binet 公式的矢量形式）：
 *
 *        d²x/dλ²  =  -3 · M · h² · x / r⁵      ,  h = |x × dx/dλ| = const
 *
 *  这是精确的（不是近似），因为中心力场保证了角动量 h 守恒。
 *  M = r_s / 2，光子球在 r = 3M = 1.5 r_s，视界在 r = r_s。
 *  用速度 Verlet 积分，步长随半径自适应。
 * ==========================================================================*/
(function () {
  'use strict';

  /* ------------------------------------------------------------------------
   *  全屏三角形顶点着色器（无需顶点缓冲，用 gl_VertexID 生成）
   * ---------------------------------------------------------------------- */
  const fullscreenVS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

  /* ------------------------------------------------------------------------
   *  公共 GLSL 片段：噪声 / 黑体辐射 / 星场
   * ---------------------------------------------------------------------- */
  const COMMON = `
#define PI  3.14159265359
#define TAU 6.28318530718

// ---------- 哈希 ----------
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

// ---------- 三维值噪声 ----------
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);

  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));

  float nx00 = mix(n000, n100, f.x);
  float nx10 = mix(n010, n110, f.x);
  float nx01 = mix(n001, n101, f.x);
  float nx11 = mix(n011, n111, f.x);
  float nxy0 = mix(nx00, nx10, f.y);
  float nxy1 = mix(nx01, nx11, f.y);
  return mix(nxy0, nxy1, f.z);
}

// 3 倍频 fbm，返回值约在 [0,1]
float fbm3(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec3(17.3, 9.1, 23.7);
    a *= 0.5;
  }
  return s * 1.1428571; // 归一化到 ~[0,1]
}

// ---------- 黑体辐射颜色（线性空间 RGB） ----------
vec3 blackbody(float kelvin) {
  float t = clamp(kelvin, 800.0, 40000.0) / 100.0;
  float r, g, b;

  if (t <= 66.0) {
    r = 255.0;
  } else {
    r = 329.698727446 * pow(max(t - 60.0, 1e-3), -0.1332047592);
  }

  if (t <= 66.0) {
    g = 99.4708025861 * log(max(t, 1.0)) - 161.1195681661;
  } else {
    g = 288.1221695283 * pow(max(t - 60.0, 1e-3), -0.0755148492);
  }

  if (t >= 66.0) {
    b = 255.0;
  } else if (t <= 19.0) {
    b = 0.0;
  } else {
    b = 138.5177312231 * log(max(t - 10.0, 1e-3)) - 305.0447927307;
  }

  vec3 srgb = clamp(vec3(r, g, b) / 255.0, 0.0, 1.0);
  // sRGB -> 线性
  return pow(srgb, vec3(2.2));
}

// ---------- 星场 ----------
// 单格星点（用于暗弱层，星点始终远离格子边界，不会被裁切）
vec3 starCellSparse(vec2 g, float seedOff, float brightScale) {
  vec2 gi = floor(g);
  vec2 gf = fract(g);
  vec3 h = hash33(vec3(gi, seedOff));
  if (h.z < 0.45) return vec3(0.0);

  vec2 sp = vec2(0.32 + 0.36 * h.x, 0.32 + 0.36 * h.y);
  float d2 = dot(gf - sp, gf - sp);
  float rad = 0.030 + 0.022 * h.x;
  float core = exp(-d2 / (rad * rad));
  if (core < 0.004) return vec3(0.0);

  float temp = mix(3200.0, 14000.0, pow(h.y, 1.6));
  return blackbody(temp) * core * brightScale * (0.30 + 1.0 * h.z);
}

// 九宫格星点（用于亮星层，允许跨格子）
vec3 starCellWide(vec2 g, float seedOff, float brightScale) {
  vec2 gi = floor(g);
  vec3 acc = vec3(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 c = gi + vec2(float(x), float(y));
      vec3 h = hash33(vec3(c, seedOff));
      if (h.z < 0.93) continue;

      vec2 sp = c + vec2(0.15 + 0.70 * h.x, 0.15 + 0.70 * h.y);
      vec2 dv = g - sp;
      float d2 = dot(dv, dv);
      float rad = 0.030 + 0.022 * h.x;
      float core = exp(-d2 / (rad * rad));
      float glow = 0.0045 / (1.0 + d2 * 900.0);
      float temp = mix(2800.0, 17000.0, pow(h.y, 1.4));
      acc += blackbody(temp) * (core + glow) * brightScale * (0.30 + 1.0 * h.z);
    }
  }
  return acc;
}

// 输入已归一化方向，返回线性 HDR 星空颜色
vec3 starfield(vec3 d, float brightMul) {
  float u = atan(d.z, d.x) * 0.15915494 + 0.5;
  float v = acos(clamp(d.y, -1.0, 1.0)) * 0.31830989;

  vec3 col = vec3(0.0);

  // 注意：u 覆盖 360°，v 只覆盖 180°，所以 u 方向的格子数要乘 2 才是方形格子，
  // 否则星点会被横向拉成一条一条的短划线。
  // 亮星层
  float dWide = 170.0;
  col += starCellWide(vec2(u * dWide * 2.0, v * dWide), 3.7, 1.00) * brightMul;

  // 中等星层
  float dMid = 430.0;
  col += starCellSparse(vec2(u * dMid * 2.0, v * dMid), 11.3, 0.60) * brightMul;

  // 细密星尘层
  float dFine = 950.0;
  col += starCellSparse(vec2(u * dFine * 2.0, v * dFine), 27.9, 0.30) * brightMul;

  // 极淡的银河带（冷色尘埃），给纯黑背景一点层次
  vec3 bandN = normalize(vec3(0.32, 0.79, -0.52));
  float band = exp(-pow(dot(d, bandN) * 3.4, 2.0));
  float neb = fbm3(d * 3.2) * fbm3(d * 7.9 + 13.0);
  col += band * neb * vec3(0.018, 0.026, 0.052) * brightMul;

  return col;
}
`;

  /* ------------------------------------------------------------------------
   *  黑洞主渲染通道
   * ---------------------------------------------------------------------- */
  const blackholeFS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 fragColor;

uniform vec2  uResolution;
uniform float uTime;
uniform vec2  uJitter;        // 亚像素抖动（时间累积抗锯齿用），单位：像素

uniform vec3  uCamPos;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec3  uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;

uniform float uRs;            // 史瓦西半径（世界单位）
uniform float uM;             // uRs * 0.5
uniform float uDiskInner;     // 世界单位
uniform float uDiskOuter;
uniform float uDiskThickness;
uniform float uDiskTemp;
uniform float uDiskBrightness;
uniform float uDoppler;
uniform float uTurbulence;
uniform float uDiskSpeed;
uniform float uDiskOpacity;
uniform float uLensing;
uniform float uStarBrightness;
uniform float uLensAberration;
uniform float uPhotonRing;

#ifndef MAX_STEPS
#define MAX_STEPS 288
#endif

${COMMON}

// ---------------------------------------------------------------------------
//  吸积盘发光：给定盘面上的点 p 与光线方向 rayDir（相机 → 盘）
// ---------------------------------------------------------------------------
vec3 diskEmission(vec3 p, vec3 rayDir, out float outAlpha) {
  float r = length(p.xz);
  outAlpha = 0.0;
  if (r < uDiskInner * 0.999 || r > uDiskOuter * 1.001) return vec3(0.0);

  float rn = (r - uDiskInner) / max(uDiskOuter - uDiskInner, 1e-3);

  // 内外缘软过渡
  float edgeIn  = smoothstep(0.0, 0.055, rn);
  float edgeOut = 1.0 - smoothstep(0.72, 1.0, rn);
  float edge = edgeIn * edgeOut;
  if (edge <= 0.0005) return vec3(0.0);

  // ---- 径向温度分布：Shakura–Sunyaev 薄盘 T ∝ r^(-3/4) ----
  // 这条才是让盘从内圈的炽白过渡到外圈的琥珀色的关键。
  // 用常数温度会让整块盘变成一个颜色的灰白圆盘，完全没有电影里的层次。
  float x = clamp(uDiskInner / r, 0.0, 1.0);
  float tf = pow(x, 0.75);
  tf = max(tf, 0.03);
  // 内缘额外提亮，做出电影里那种炽白的内环
  float hot = smoothstep(0.0, 0.10, rn) * (1.0 - smoothstep(0.10, 0.34, rn));

  // ---- 差速旋转的湍流条纹 ----
  float omegaK = sqrt(uM / max(r * r * r, 1e-4));      // 开普勒角速度
  float ang = -uTime * uDiskSpeed * omegaK * 9.0;
  float ca = cos(ang);
  float sa = sin(ang);
  vec3 rp = vec3(ca * p.x - sa * p.z, 0.0, sa * p.x + ca * p.z);

  float lr = log(max(r, 1e-3));
  // 噪声频率要克制：太高的倍频在半分辨率下会直接走样成"沙粒感"。
  // 另外径向比角向密得多，才能拉出盘面那种沿轨道流动的细丝，
  // 而不是一团团各向同性的斑块。
  float n1 = fbm3(vec3(rp.x * 1.35, rp.z * 1.35, lr * 16.0));
  float n2 = fbm3(vec3(rp.x * 3.10, rp.z * 3.10, lr * 42.0));
  float n3 = fbm3(vec3(rp.x * 6.20, rp.z * 6.20, lr * 96.0));

  float detail = n1 * 0.62 + n2 * 0.27 + n3 * 0.11;     // ~[0,1]
  // 对比度收窄一些，盘面才不会有那种"霉斑"感
  float turb = mix(1.0, 0.56 + 0.92 * detail, uTurbulence);

  // 细密同心环（盘面的细丝结构）—— 电影里那种一丝一丝的层次感
  float rings = 0.90 + 0.10 * sin(lr * 62.0 + n2 * 9.0);
  rings *= 0.96 + 0.04 * sin(lr * 147.0 + n3 * 22.0);
  turb *= rings;

  // ---- 相对论效应：多普勒集束 + 引力红移 ----
  vec3 rhat = normalize(vec3(p.x, 0.0, p.z));
  vec3 vhat = cross(vec3(0.0, 1.0, 0.0), rhat);        // 轨道速度方向
  float beta = clamp(sqrt(uM / max(r, 1e-3)), 0.0, 0.96);
  vec3 nobs = -normalize(rayDir);                      // 由发光点指向相机
  float cosT = dot(vhat, nobs);
  float gamma = inversesqrt(max(1.0 - beta * beta, 1e-4));
  float dopp = 1.0 / max(gamma * (1.0 - beta * cosT), 1e-3);
  float grav = sqrt(max(1.0 - uRs / max(r, uRs * 1.001), 0.02));
  float g = dopp * grav;

  // 用 uDoppler 在"真实物理"和"电影调色"之间插值
  float beam = mix(1.0, pow(g, 3.0), uDoppler);
  float tempShift = mix(1.0, g, uDoppler * 0.85);

  // ---- 组装 ----
  // 温度：内圈炽白（1.0×设定温度），外圈掉到 ~0.22×，自然呈现从白热到琥珀橙的过渡。
  // 这个是整个画面色彩层次的来源，不能省成常数。
  float temp = uDiskTemp * (0.22 + 0.78 * tf) * tempShift;
  // 亮度：陡降但留个底，让外盘仍然可见且能透出次级像
  float radialFall = pow(tf, 1.45);
  float intensity = uDiskBrightness * (0.045 + 0.92 * radialFall) * turb * beam;

  // 内缘炽白核：电影里最抢眼的就是那一道近乎纯白的亮边
  intensity += uDiskBrightness * hot * 0.55;

  vec3 col = blackbody(temp) * intensity * edge;

  outAlpha = clamp(uDiskOpacity * edge * (0.40 + 0.62 * turb), 0.0, 1.0);
  return col;
}

void main() {
  // ---- 相机射线 ----
  vec2 ndc = vUv * 2.0 - 1.0;
  // 亚像素抖动
  vec2 jit = (uJitter / uResolution) * 2.0;
  vec3 dir = normalize(
      uCamFwd
    + uCamRight * ((ndc.x + jit.x) * uTanHalfFov * uAspect)
    + uCamUp    * ((ndc.y + jit.y) * uTanHalfFov)
  );

  // ---- 测地线积分 ----
  vec3 pos = uCamPos;
  vec3 vel = dir;

  // 角动量：因为加速度始终沿径向，x × v 精确守恒。
  // 在初始条件处算出 h²，整个积分过程中保持不变即可（这是精确的，不是近似）。
  // 注意：绝对不能对 vel 做归一化，否则会破坏 x × v 与 h² 的一致性。
  vec3 hvec = cross(pos, vel);
  float h2 = dot(hvec, hvec);
  float lens = max(uLensing, 0.0);

  // 逃逸半径必须同时覆盖盘的尺度与相机距离，否则相机会被误判为"已逃逸"
  float escapeR = max(max(uDiskOuter * 2.1, length(uCamPos) * 1.6), 55.0);

  vec3  accum = vec3(0.0);
  float trans = 1.0;

  bool captured = false;
  bool escaped  = false;

  /* 最近接近距离：用来还原光子环。
     b ≈ 3√3·M 的光子会在 r = 3M 附近绕行很多圈，它们的近拱点全部挤在
     光子球上，于是黑洞阴影边缘出现一圈极细的亮环 —— 这是卡冈图雅
     最标志性的特征，也是"能看出这是相对论渲染"的关键细节。 */
  float minR = 1e9;

  for (int i = 0; i < MAX_STEPS; i++) {
    float r = length(pos);
    minR = min(minR, r);

    if (r < uRs * 1.002) { captured = true; break; }
    if (r > escapeR && dot(pos, vel) > 0.0) { escaped = true; break; }
    if (trans < 0.004) break;

    /* 自适应步长：同时约束"径向位移"和"角向转角"。
       仅按 r 取步长是低效的——近径向的光线 (h≈0) 根本不需要细步，
       而掠过光子球的光线需要极细的步。用 dφ = h/r²·dt 直接限制转角，
       在同样的步数预算下精度高得多。 */
    float hMag = sqrt(h2) + 1e-4;
    float dtRad = r * 0.080;                 // 径向位移上限
    float dtAng = 0.070 * r * r / hMag;      // 角向转角上限（dφ ≈ 0.07 rad）
    float dt = clamp(min(dtRad, dtAng), 0.006, 3.0);

    /* 薄盘不需要在盘面附近细化：我们用的是"平面符号变化 + 线性插值求交点"，
       交点位置是解析的，步长大一点也不会漏掉盘面。真正需要细化的是
       厚盘（体积吸收积分），所以只在盘有明显厚度时才启用。 */
    if (uDiskThickness > 0.05 * uRs) {
      float cylR = length(pos.xz);
      if (cylR > uDiskInner * 0.85 && cylR < uDiskOuter * 1.15 && abs(pos.y) < uDiskOuter * 0.22) {
        dt = min(dt, clamp(r * 0.045, 0.008, 0.50));
      }
    }

    // 加速度 a = -3 M h² x / r⁵  （乘 lensing 以允许调节弯曲强度）
    float r2 = r * r;
    float inv5 = 1.0 / (r2 * r2 * r);
    vec3 acc = -3.0 * uM * h2 * lens * inv5 * pos;

    // 速度 Verlet（h² 固定，速度不做归一化）
    vec3 velHalf = vel + acc * (dt * 0.5);

    vec3 prev = pos;
    vec3 next = pos + velHalf * dt;

    float nr2 = dot(next, next);
    float inv5n = 1.0 / (nr2 * nr2 * sqrt(nr2));
    vec3 accN = -3.0 * uM * h2 * lens * inv5n * next;
    vel = velHalf + accN * (dt * 0.5);

    // ---- 盘面相交检测 ----
    // 1) 穿过 y = 0 平面（薄盘，精确插值交点）
    bool crossed = (prev.y * next.y) < 0.0;
    if (crossed) {
      float t = prev.y / (prev.y - next.y);
      vec3 hit = mix(prev, next, t);
      float a;
      vec3 em = diskEmission(hit, vel, a);
      if (a > 0.0) {
        accum += trans * em * a;
        trans *= (1.0 - a);
      }
    } else if (uDiskThickness > 0.001) {
      // 2) 厚盘：光线在薄层内时，按垂直距离加权贡献
      float slab = uDiskThickness * 0.5;
      float dPrev = abs(prev.y);
      float dNext = abs(next.y);
      float dMin = min(dPrev, dNext);
      if (dMin < slab) {
        float w = 1.0 - dMin / slab;
        w = w * w;
        vec3 mid = mix(prev, next, 0.5);
        float a;
        vec3 em = diskEmission(mid, vel, a);
        if (a > 0.0) {
          float aw = a * w * 0.35;
          accum += trans * em * aw;
          trans *= (1.0 - aw);
        }
      }
    }

    pos = next;
  }

  // ---- 背景星空 ----
  if (!captured && trans > 0.004) {
    vec3 outDir = normalize(vel);

    /* 引力透镜色散：
       星点是高频特征，如果对 R/G/B 分别沿不同方向采样，会直接变成
       满屏的彩色噪点。所以这里改成"整体轻微缩放 + 通道色温偏移"，
       视觉上产生边缘彩晕，但不会撕裂星点。 */
    vec3 col;
    if (uLensAberration > 0.001) {
      float amt = uLensAberration * 0.006;
      vec3 base = starfield(outDir, uStarBrightness);
      // 沿视线径向做一次极小的缩放采样，取亮度差作为彩晕来源
      vec3 radial = outDir - normalize(uCamPos) * amt * 0.35;
      vec3 halo = starfield(normalize(radial), uStarBrightness);
      col = base + (halo - base) * vec3(0.55, 0.05, -0.45);
      col = max(col, vec3(0.0));
    } else {
      col = starfield(outDir, uStarBrightness);
    }

    accum += trans * col;
  }

  /* ---- 光子环 ----
     在光子球 r = 1.5·r_s 附近加一圈极细的高亮环。
     真实的环来自绕行光线的堆叠，但有限步数下高阶像会偏暗，
     这里补一层解析光晕，让阴影边缘那道细亮线立住。 */
  if (uPhotonRing > 0.001) {
    float photonR = 1.5 * uRs;
    float band = exp(-pow((minR - photonR) / (0.055 * uRs), 2.0));
    /* 只有确实从视界外缘掠过（而不是径直掉进去）的光线才算 */
    band *= smoothstep(1.0, 1.25, minR / uRs);
    vec3 ringCol = blackbody(uDiskTemp * 1.15) * band * uPhotonRing * 0.55;
    accum += trans * ringCol;
  }

  // 视界内：纯黑
  fragColor = vec4(max(accum, vec3(0.0)), 1.0);
}
`;

  /* ------------------------------------------------------------------------
   *  时间累积（渐进式抗锯齿）
   * ---------------------------------------------------------------------- */
  const accumulateFS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uCurrent;
uniform sampler2D uHistory;
uniform float uBlend;   // 1/(n+1)

void main() {
  vec3 cur = texture(uCurrent, vUv).rgb;
  vec3 hist = texture(uHistory, vUv).rgb;

  // 邻域方差裁剪：抑制拖影，同时保留亮度变化
  vec2 texel = 1.0 / vec2(textureSize(uCurrent, 0));
  vec3 m1 = vec3(0.0);
  vec3 m2 = vec3(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 c = texture(uCurrent, vUv + vec2(float(x), float(y)) * texel).rgb;
      m1 += c;
      m2 += c * c;
    }
  }
  m1 /= 9.0;
  m2 /= 9.0;
  vec3 sigma = sqrt(max(m2 - m1 * m1, vec3(0.0)));

  vec3 lo = m1 - sigma * 1.35;
  vec3 hi = m1 + sigma * 1.35;
  vec3 clipped = clamp(hist, lo, hi);

  fragColor = vec4(mix(clipped, cur, uBlend), 1.0);
}
`;

  /* ------------------------------------------------------------------------
   *  Bloom：亮度提取 + 下采样
   * ---------------------------------------------------------------------- */
  const brightPassFS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2  uTexel;
uniform float uThreshold;
uniform float uSoftKnee;

vec3 prefilter(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float knee = uThreshold * uSoftKnee + 1e-5;
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-5);
  return c * contrib;
}

void main() {
  // 4 点盒式下采样
  vec3 s = texture(uSource, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  s += texture(uSource, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  s += texture(uSource, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  s += texture(uSource, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  s *= 0.25;
  fragColor = vec4(prefilter(s), 1.0);
}
`;

  const downsampleFS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2  uTexel;

void main() {
  // 13 抽头降采样（Kawase / COD 风格），抗闪烁
  vec3 a = texture(uSource, vUv + uTexel * vec2(-2.0,  2.0)).rgb;
  vec3 b = texture(uSource, vUv + uTexel * vec2( 0.0,  2.0)).rgb;
  vec3 c = texture(uSource, vUv + uTexel * vec2( 2.0,  2.0)).rgb;
  vec3 d = texture(uSource, vUv + uTexel * vec2(-2.0,  0.0)).rgb;
  vec3 e = texture(uSource, vUv).rgb;
  vec3 f = texture(uSource, vUv + uTexel * vec2( 2.0,  0.0)).rgb;
  vec3 g = texture(uSource, vUv + uTexel * vec2(-2.0, -2.0)).rgb;
  vec3 h = texture(uSource, vUv + uTexel * vec2( 0.0, -2.0)).rgb;
  vec3 i = texture(uSource, vUv + uTexel * vec2( 2.0, -2.0)).rgb;
  vec3 j = texture(uSource, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  vec3 k = texture(uSource, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  vec3 l = texture(uSource, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 m = texture(uSource, vUv + uTexel * vec2( 1.0, -1.0)).rgb;

  vec3 o = e * 0.125;
  o += (a + c + g + i) * 0.03125;
  o += (b + d + f + h) * 0.0625;
  o += (j + k + l + m) * 0.125;

  fragColor = vec4(o, 1.0);
}
`;

  const upsampleFS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;     // 更粗糙的一层
uniform vec2  uTexel;
uniform float uRadius;

// 9 抽头帐篷滤波，结果由调用方用加性混合叠加到目标层上
void main() {
  vec4 d = vec4(uTexel, -uTexel.y, 0.0) * uRadius;

  vec3 s = texture(uSource, vUv - d.xy).rgb;
  s += texture(uSource, vUv - d.wy).rgb * 2.0;
  s += texture(uSource, vUv - d.zy).rgb;
  s += texture(uSource, vUv + d.zw).rgb * 2.0;
  s += texture(uSource, vUv).rgb * 4.0;
  s += texture(uSource, vUv + d.xw).rgb * 2.0;
  s += texture(uSource, vUv + d.zy).rgb;
  s += texture(uSource, vUv + d.wy).rgb * 2.0;
  s += texture(uSource, vUv + d.xy).rgb;
  s *= 0.0625;

  fragColor = vec4(s, 1.0);
}
`;

  /* ------------------------------------------------------------------------
   *  合成 / 色调映射
   * ---------------------------------------------------------------------- */
  const compositeFS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2  uResolution;
uniform float uTime;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uChromatic;
uniform float uVignette;
uniform float uGrain;

// ACES Filmic 色调映射（Narkowicz 近似）
vec3 acesFilm(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 linearToSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(0.41666)) - 0.055, step(0.0031308, c));
}

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = vUv;
  vec2 centered = uv - 0.5;
  float r2 = dot(centered, centered);

  // ---- 横向色差 ----
  vec3 scene;
  if (uChromatic > 0.0005) {
    float amt = uChromatic * 0.0028 * r2 * 4.0;
    scene.r = texture(uScene, uv - centered * amt).r;
    scene.g = texture(uScene, uv).g;
    scene.b = texture(uScene, uv + centered * amt).b;
  } else {
    scene = texture(uScene, uv).rgb;
  }

  // ---- 泛光 ----
  vec3 bloom = texture(uBloom, uv).rgb;
  vec3 hdr = scene + bloom * uBloomStrength;

  // ---- 曝光 + 饱和度 ----
  // ACES 会把高光压向白色，先补一点饱和度，避免整块盘变成米黄色
  hdr *= uExposure;
  {
    float lum = dot(hdr, vec3(0.2126, 0.7152, 0.0722));
    hdr = mix(vec3(lum), hdr, 1.22);
    hdr = max(hdr, vec3(0.0));
  }

  // ---- 色调映射 ----
  vec3 col = acesFilm(hdr);

  // ---- 暗角 ----
  float vig = 1.0 - uVignette * pow(clamp(r2 * 2.4, 0.0, 1.0), 1.35);
  col *= vig;

  // ---- 胶片颗粒 ----
  if (uGrain > 0.0005) {
    float n = hash(uv * uResolution + fract(uTime) * 431.7) - 0.5;
    col += n * uGrain * 0.14;
  }

  col = linearToSRGB(col);
  fragColor = vec4(col, 1.0);
}
`;

  /* ------------------------------------------------------------------------
   *  直通拷贝（保留给调试用：把中间缓冲直接贴到屏幕）
   * ---------------------------------------------------------------------- */
  const copyFS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSource;
void main() { fragColor = vec4(texture(uSource, vUv).rgb, 1.0); }
`;

  window.SHADERS = {
    fullscreenVS,
    blackholeFS,
    accumulateFS,
    brightPassFS,
    downsampleFS,
    upsampleFS,
    compositeFS,
    copyFS,
  };
})();
