import * as THREE from "three";
import {
  vertexShader,
  blackHoleFragmentShader,
  bloomExtractShader,
  bloomBlurShader,
  compositeFragmentShader,
} from "./shaders.js?v=6";

const PRESETS = {
  interstellar: {
    rs: 1.0,
    lensing: 1.0,
    spin: 0.85,
    photonRing: 1.25,
    diskEnabled: true,
    diskTemp: 4800,
    doppler: 0.36,
    diskInner: 2.85,
    diskOuter: 9.6,
    diskThickness: 0.16,
    diskSpeed: 1.0,
    diskDetail: 1.0,
    diskBrightness: 1.35,
    starDensity: 1.2,
    starBrightness: 1.3,
    nebula: 1.0,
    skyDrift: 0.15,
    bloom: 0.85,
    anamorphic: 0.55,
    roll: -16,
    fov: 46,
    camTheta: 0.45,
    camPhi: 0.115,
    camDist: 13.5,
  },
  kipThorne: {
    rs: 1.05,
    lensing: 1.08,
    spin: 0.96,
    photonRing: 1.45,
    diskEnabled: true,
    diskTemp: 6400,
    doppler: 1.05,
    diskInner: 2.72,
    diskOuter: 10.2,
    diskThickness: 0.14,
    diskSpeed: 1.35,
    diskDetail: 1.2,
    diskBrightness: 1.25,
    starDensity: 1.25,
    starBrightness: 1.35,
    nebula: 0.9,
    skyDrift: 0.15,
    bloom: 0.9,
    anamorphic: 0.65,
    roll: -12,
    fov: 45,
    camTheta: 0.7,
    camPhi: 0.095,
    camDist: 12.8,
  },
  einsteinRing: {
    rs: 1.0,
    lensing: 1.12,
    spin: 0.75,
    photonRing: 1.55,
    diskEnabled: true,
    diskTemp: 5600,
    doppler: 0.45,
    diskInner: 2.85,
    diskOuter: 9.2,
    diskThickness: 0.18,
    diskSpeed: 1.0,
    diskDetail: 1.1,
    diskBrightness: 1.2,
    starDensity: 1.65,
    starBrightness: 1.75,
    nebula: 1.35,
    skyDrift: 0.25,
    bloom: 0.8,
    anamorphic: 0.35,
    roll: 0,
    fov: 50,
    camTheta: 1.1,
    camPhi: 0.68,
    camDist: 14.2,
  },
  photonSkim: {
    rs: 1.1,
    lensing: 1.05,
    spin: 0.92,
    photonRing: 1.65,
    diskEnabled: true,
    diskTemp: 5900,
    doppler: 0.58,
    diskInner: 2.75,
    diskOuter: 10.8,
    diskThickness: 0.2,
    diskSpeed: 1.25,
    diskDetail: 1.25,
    diskBrightness: 1.3,
    starDensity: 1.4,
    starBrightness: 1.5,
    nebula: 1.15,
    skyDrift: 0.2,
    bloom: 0.95,
    anamorphic: 0.75,
    roll: -24,
    fov: 62,
    camTheta: 0.2,
    camPhi: 0.065,
    camDist: 6.4,
  },
  quasar: {
    rs: 1.15,
    lensing: 1.1,
    spin: 0.98,
    photonRing: 1.8,
    diskEnabled: true,
    diskTemp: 11500,
    doppler: 0.72,
    diskInner: 2.72,
    diskOuter: 11.5,
    diskThickness: 0.34,
    diskSpeed: 1.65,
    diskDetail: 1.35,
    diskBrightness: 1.65,
    starDensity: 1.3,
    starBrightness: 1.4,
    nebula: 1.25,
    skyDrift: 0.18,
    bloom: 1.15,
    anamorphic: 0.85,
    roll: 19,
    fov: 48,
    camTheta: -0.5,
    camPhi: 0.18,
    camDist: 14.0,
  },
  nakedLens: {
    rs: 1.25,
    lensing: 1.35,
    spin: 0.9,
    photonRing: 1.9,
    diskEnabled: false,
    diskTemp: 5800,
    doppler: 0.35,
    diskInner: 2.85,
    diskOuter: 9.6,
    diskThickness: 0.15,
    diskSpeed: 1.0,
    diskDetail: 1.0,
    diskBrightness: 1.2,
    starDensity: 2.1,
    starBrightness: 2.2,
    nebula: 1.75,
    skyDrift: 0.45,
    bloom: 0.75,
    anamorphic: 0.3,
    roll: -8,
    fov: 48,
    camTheta: 0.0,
    camPhi: 0.04,
    camDist: 11.5,
  },
};

const state = {
  ...PRESETS.interstellar,
  quality: 0.85,
  autoOrbit: false,
};

const cameraCtrl = {
  theta: PRESETS.interstellar.camTheta,
  phi: PRESETS.interstellar.camPhi,
  distance: PRESETS.interstellar.camDist,
  roll: PRESETS.interstellar.roll,
  targetTheta: PRESETS.interstellar.camTheta,
  targetPhi: PRESETS.interstellar.camPhi,
  targetDistance: PRESETS.interstellar.camDist,
  targetRoll: PRESETS.interstellar.roll,
  isDragging: false,
  dragMode: "orbit",
  lastX: 0,
  lastY: 0,
};

function createSeamlessNoiseTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);

  function hash2(ix, iy, seed) {
    const x = ((ix % size) + size) % size;
    const y = ((iy % size) + size) % size;
    let n = x * 374761393 + y * 668265263 + seed * 1442695041;
    n = (n ^ (n >> 13)) * 1274126177;
    return ((n ^ (n >> 16)) >>> 0) / 4294967295;
  }

  function tileableValueNoise(u, v, freq, seed) {
    const x = u * freq;
    const y = v * freq;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);

    const wrap = (val) => ((val % freq) + freq) % freq;
    const n00 = hash2(wrap(ix), wrap(iy), seed);
    const n10 = hash2(wrap(ix + 1), wrap(iy), seed);
    const n01 = hash2(wrap(ix), wrap(iy + 1), seed);
    const n11 = hash2(wrap(ix + 1), wrap(iy + 1), seed);

    const nx0 = n00 + sx * (n10 - n00);
    const nx1 = n01 + sx * (n11 - n01);
    return nx0 + sy * (nx1 - nx0);
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;

      const c1 =
        0.55 * tileableValueNoise(u, v, 8, 11) +
        0.30 * tileableValueNoise(u, v, 16, 23) +
        0.15 * tileableValueNoise(u, v, 32, 37);

      const c2 =
        0.50 * tileableValueNoise(u, v, 12, 53) +
        0.32 * tileableValueNoise(u, v, 24, 71) +
        0.18 * tileableValueNoise(u, v, 48, 89);

      const c3 = hash2(x, y, 101);
      const c4 = hash2(x, y, 199);

      const idx = (y * size + x) * 4;
      data[idx] = Math.floor(Math.min(1, Math.max(0, c1)) * 255);
      data[idx + 1] = Math.floor(Math.min(1, Math.max(0, c2)) * 255);
      data[idx + 2] = Math.floor(c3 * 255);
      data[idx + 3] = Math.floor(c4 * 255);
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

const container = document.getElementById("canvas-container");
const renderer = new THREE.WebGLRenderer({
  antialias: false,
  powerPreference: "high-performance",
  preserveDrawingBuffer: false,
});
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);

const isWebGL2 = renderer.capabilities.isWebGL2;
const rtType = isWebGL2 ? THREE.HalfFloatType : THREE.UnsignedByteType;

function makeRenderTarget(w, h) {
  return new THREE.WebGLRenderTarget(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)), {
    type: rtType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

let rtScene = makeRenderTarget(1, 1);
let rtBloomExtract = makeRenderTarget(1, 1);
let rtBloomWideA = makeRenderTarget(1, 1);
let rtBloomWideB = makeRenderTarget(1, 1);
let rtBloomAnaA = makeRenderTarget(1, 1);
let rtBloomAnaB = makeRenderTarget(1, 1);

const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quadGeo = new THREE.PlaneGeometry(2, 2);

const noiseTexture = createSeamlessNoiseTexture(256);

const blackHoleUniforms = {
  uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
  uTime: { value: 0 },
  uCamPos: { value: new THREE.Vector3(0, 1.5, 13.5) },
  uCamMat: { value: new THREE.Matrix3() },
  uFovTan: { value: Math.tan(THREE.MathUtils.degToRad(state.fov * 0.5)) },

  uRs: { value: state.rs },
  uSpin: { value: state.spin },
  uLensing: { value: state.lensing },
  uPhotonRing: { value: state.photonRing },

  uDiskEnabled: { value: state.diskEnabled ? 1.0 : 0.0 },
  uDiskInner: { value: state.diskInner },
  uDiskOuter: { value: state.diskOuter },
  uDiskThickness: { value: state.diskThickness },
  uDiskTemp: { value: state.diskTemp },
  uDoppler: { value: state.doppler },
  uDiskSpeed: { value: state.diskSpeed },
  uDiskDetail: { value: state.diskDetail },
  uDiskBrightness: { value: state.diskBrightness },

  uStarDensity: { value: state.starDensity },
  uStarBrightness: { value: state.starBrightness },
  uNebulaIntensity: { value: state.nebula },
  uSkyRotation: { value: 0.0 },
  uQuality: { value: state.quality },
  uNoiseTex: { value: noiseTexture },
};

const matBlackHole = new THREE.ShaderMaterial({
  vertexShader,
  fragmentShader: blackHoleFragmentShader,
  uniforms: blackHoleUniforms,
  depthWrite: false,
  depthTest: false,
});

const matBloomExtract = new THREE.ShaderMaterial({
  vertexShader,
  fragmentShader: bloomExtractShader,
  uniforms: {
    tDiffuse: { value: null },
    uThreshold: { value: 0.72 },
  },
  depthWrite: false,
  depthTest: false,
});

const matBloomBlur = new THREE.ShaderMaterial({
  vertexShader,
  fragmentShader: bloomBlurShader,
  uniforms: {
    tDiffuse: { value: null },
    uDirection: { value: new THREE.Vector2(1, 0) },
    uTexelSize: { value: new THREE.Vector2(1 / 512, 1 / 512) },
  },
  depthWrite: false,
  depthTest: false,
});

const matComposite = new THREE.ShaderMaterial({
  vertexShader,
  fragmentShader: compositeFragmentShader,
  uniforms: {
    tScene: { value: null },
    tBloomWide: { value: null },
    tBloomAnamorphic: { value: null },
    uBloomStrength: { value: state.bloom },
    uAnamorphicStrength: { value: state.anamorphic },
    uExposure: { value: 1.08 },
    uTime: { value: 0 },
  },
  depthWrite: false,
  depthTest: false,
});

const quadMesh = new THREE.Mesh(quadGeo, matBlackHole);
const postScene = new THREE.Scene();
postScene.add(quadMesh);

function resizeRenderTargets() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const fullW = Math.max(1, Math.floor(window.innerWidth * dpr));
  const fullH = Math.max(1, Math.floor(window.innerHeight * dpr));

  renderer.setSize(window.innerWidth, window.innerHeight);

  const scale = state.quality;
  const sceneW = Math.max(320, Math.floor(fullW * scale));
  const sceneH = Math.max(180, Math.floor(fullH * scale));

  rtScene.setSize(sceneW, sceneH);
  blackHoleUniforms.uResolution.value.set(sceneW, sceneH);

  const bloomW = Math.max(160, Math.floor(sceneW * 0.5));
  const bloomH = Math.max(90, Math.floor(sceneH * 0.5));
  rtBloomExtract.setSize(bloomW, bloomH);
  rtBloomWideA.setSize(bloomW, bloomH);
  rtBloomWideB.setSize(bloomW, bloomH);

  const anaW = Math.max(160, Math.floor(sceneW * 0.5));
  const anaH = Math.max(64, Math.floor(sceneH * 0.28));
  rtBloomAnaA.setSize(anaW, anaH);
  rtBloomAnaB.setSize(anaW, anaH);
}

resizeRenderTargets();
window.addEventListener("resize", resizeRenderTargets);

function updateCameraMatrix() {
  const cosPhi = Math.cos(cameraCtrl.phi);
  const sinPhi = Math.sin(cameraCtrl.phi);
  const cosTheta = Math.cos(cameraCtrl.theta);
  const sinTheta = Math.sin(cameraCtrl.theta);

  const dist = cameraCtrl.distance * state.rs;
  const camPos = blackHoleUniforms.uCamPos.value;
  camPos.set(
    dist * cosPhi * sinTheta,
    dist * sinPhi,
    dist * cosPhi * cosTheta
  );

  const forward = camPos.clone().negate().normalize();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(forward, worldUp).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();

  const rollRad = THREE.MathUtils.degToRad(cameraCtrl.roll);
  const cosR = Math.cos(rollRad);
  const sinR = Math.sin(rollRad);

  const rolledRight = right.clone().multiplyScalar(cosR).add(up.clone().multiplyScalar(sinR));
  const rolledUp = up.clone().multiplyScalar(cosR).sub(right.clone().multiplyScalar(sinR));
  const back = forward.clone().negate();

  blackHoleUniforms.uCamMat.value.set(
    rolledRight.x, rolledUp.x, back.x,
    rolledRight.y, rolledUp.y, back.y,
    rolledRight.z, rolledUp.z, back.z
  );
}

// Mouse & Touch Interaction
container.addEventListener("contextmenu", (e) => e.preventDefault());

container.addEventListener("pointerdown", (e) => {
  cameraCtrl.isDragging = true;
  cameraCtrl.lastX = e.clientX;
  cameraCtrl.lastY = e.clientY;
  cameraCtrl.dragMode = e.button === 2 || e.shiftKey ? "roll" : "orbit";
  container.setPointerCapture(e.pointerId);
});

container.addEventListener("pointermove", (e) => {
  if (!cameraCtrl.isDragging) return;
  const dx = e.clientX - cameraCtrl.lastX;
  const dy = e.clientY - cameraCtrl.lastY;
  cameraCtrl.lastX = e.clientX;
  cameraCtrl.lastY = e.clientY;

  if (cameraCtrl.dragMode === "roll") {
    cameraCtrl.targetRoll = THREE.MathUtils.clamp(cameraCtrl.targetRoll + dx * 0.25, -90, 90);
    syncRollUI(Math.round(cameraCtrl.targetRoll));
  } else {
    cameraCtrl.targetTheta -= dx * 0.0055;
    cameraCtrl.targetPhi = THREE.MathUtils.clamp(
      cameraCtrl.targetPhi + dy * 0.0045,
      -Math.PI * 0.485,
      Math.PI * 0.485
    );
  }
});

function stopDrag(e) {
  if (!cameraCtrl.isDragging) return;
  cameraCtrl.isDragging = false;
  if (e && e.pointerId !== undefined && container.hasPointerCapture(e.pointerId)) {
    container.releasePointerCapture(e.pointerId);
  }
}

container.addEventListener("pointerup", stopDrag);
container.addEventListener("pointercancel", stopDrag);

container.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const zoomFactor = Math.exp(e.deltaY * 0.0011);
    cameraCtrl.targetDistance = THREE.MathUtils.clamp(
      cameraCtrl.targetDistance * zoomFactor,
      3.2,
      38.0
    );
  },
  { passive: false }
);

container.addEventListener("dblclick", () => {
  cameraCtrl.targetTheta = PRESETS.interstellar.camTheta;
  cameraCtrl.targetPhi = PRESETS.interstellar.camPhi;
  cameraCtrl.targetDistance = PRESETS.interstellar.camDist;
  cameraCtrl.targetRoll = PRESETS.interstellar.roll;
  syncRollUI(cameraCtrl.targetRoll);
});

// UI Controls Binding
const sliderConfigs = [
  { id: "param-rs", valId: "val-rs", key: "rs", fmt: (v) => `${v.toFixed(2)} Rs`, uniform: "uRs" },
  {
    id: "param-lensing",
    valId: "val-lensing",
    key: "lensing",
    fmt: (v) => (Math.abs(v - 1.0) < 0.02 ? `${v.toFixed(2)}x (GR)` : `${v.toFixed(2)}x`),
    uniform: "uLensing",
  },
  { id: "param-spin", valId: "val-spin", key: "spin", fmt: (v) => `${v.toFixed(2)}c`, uniform: "uSpin" },
  {
    id: "param-photon-ring",
    valId: "val-photon-ring",
    key: "photonRing",
    fmt: (v) => v.toFixed(2),
    uniform: "uPhotonRing",
  },
  {
    id: "param-disk-temp",
    valId: "val-disk-temp",
    key: "diskTemp",
    fmt: (v) => `${Math.round(v)} K`,
    uniform: "uDiskTemp",
  },
  { id: "param-doppler", valId: "val-doppler", key: "doppler", fmt: (v) => v.toFixed(2), uniform: "uDoppler" },
  {
    id: "param-disk-inner",
    valId: "val-disk-inner",
    key: "diskInner",
    fmt: (v) => `${v.toFixed(2)} Rs`,
    uniform: "uDiskInner",
  },
  {
    id: "param-disk-outer",
    valId: "val-disk-outer",
    key: "diskOuter",
    fmt: (v) => `${v.toFixed(2)} Rs`,
    uniform: "uDiskOuter",
  },
  {
    id: "param-disk-thickness",
    valId: "val-disk-thickness",
    key: "diskThickness",
    fmt: (v) => `${v.toFixed(2)} Rs`,
    uniform: "uDiskThickness",
  },
  {
    id: "param-disk-speed",
    valId: "val-disk-speed",
    key: "diskSpeed",
    fmt: (v) => `${v.toFixed(2)}x`,
    uniform: "uDiskSpeed",
  },
  {
    id: "param-disk-detail",
    valId: "val-disk-detail",
    key: "diskDetail",
    fmt: (v) => v.toFixed(2),
    uniform: "uDiskDetail",
  },
  {
    id: "param-disk-brightness",
    valId: "val-disk-brightness",
    key: "diskBrightness",
    fmt: (v) => v.toFixed(2),
    uniform: "uDiskBrightness",
  },
  {
    id: "param-star-density",
    valId: "val-star-density",
    key: "starDensity",
    fmt: (v) => `${v.toFixed(2)}x`,
    uniform: "uStarDensity",
  },
  {
    id: "param-star-brightness",
    valId: "val-star-brightness",
    key: "starBrightness",
    fmt: (v) => `${v.toFixed(2)}x`,
    uniform: "uStarBrightness",
  },
  {
    id: "param-nebula",
    valId: "val-nebula",
    key: "nebula",
    fmt: (v) => `${v.toFixed(2)}x`,
    uniform: "uNebulaIntensity",
  },
  {
    id: "param-sky-drift",
    valId: "val-sky-drift",
    key: "skyDrift",
    fmt: (v) => `${v.toFixed(2)}x`,
  },
  {
    id: "param-bloom",
    valId: "val-bloom",
    key: "bloom",
    fmt: (v) => v.toFixed(2),
    onChange: (v) => {
      matComposite.uniforms.uBloomStrength.value = v;
    },
  },
  {
    id: "param-anamorphic",
    valId: "val-anamorphic",
    key: "anamorphic",
    fmt: (v) => v.toFixed(2),
    onChange: (v) => {
      matComposite.uniforms.uAnamorphicStrength.value = v;
    },
  },
  {
    id: "param-roll",
    valId: "val-roll",
    key: "roll",
    fmt: (v) => `${Math.round(v)}°`,
    onChange: (v) => {
      cameraCtrl.targetRoll = v;
    },
  },
  {
    id: "param-fov",
    valId: "val-fov",
    key: "fov",
    fmt: (v) => `${Math.round(v)}°`,
    onChange: (v) => {
      blackHoleUniforms.uFovTan.value = Math.tan(THREE.MathUtils.degToRad(v * 0.5));
    },
  },
  {
    id: "param-quality",
    valId: "val-quality",
    key: "quality",
    fmt: (v) => `${v.toFixed(2)}x`,
    onChange: (v) => {
      blackHoleUniforms.uQuality.value = v;
      resizeRenderTargets();
    },
  },
];

function syncRollUI(val) {
  state.roll = val;
  const input = document.getElementById("param-roll");
  const label = document.getElementById("val-roll");
  if (input) input.value = String(val);
  if (label) label.textContent = `${Math.round(val)}°`;
}

function applyAllStateToUI() {
  for (const cfg of sliderConfigs) {
    const input = document.getElementById(cfg.id);
    const valSpan = document.getElementById(cfg.valId);
    const value = state[cfg.key];
    if (input) input.value = String(value);
    if (valSpan) valSpan.textContent = cfg.fmt(value);
    if (cfg.uniform && blackHoleUniforms[cfg.uniform]) {
      blackHoleUniforms[cfg.uniform].value = value;
    }
    if (cfg.onChange) cfg.onChange(value);
  }

  const diskCheckbox = document.getElementById("param-disk-enabled");
  if (diskCheckbox) {
    diskCheckbox.checked = state.diskEnabled;
  }
  blackHoleUniforms.uDiskEnabled.value = state.diskEnabled ? 1.0 : 0.0;
}

for (const cfg of sliderConfigs) {
  const input = document.getElementById(cfg.id);
  const valSpan = document.getElementById(cfg.valId);
  if (!input) continue;

  input.addEventListener("input", () => {
    const num = parseFloat(input.value);
    state[cfg.key] = num;
    if (valSpan) valSpan.textContent = cfg.fmt(num);
    if (cfg.uniform && blackHoleUniforms[cfg.uniform]) {
      blackHoleUniforms[cfg.uniform].value = num;
    }
    if (cfg.onChange) cfg.onChange(num);
  });
}

const diskToggle = document.getElementById("param-disk-enabled");
if (diskToggle) {
  diskToggle.addEventListener("change", () => {
    state.diskEnabled = diskToggle.checked;
    blackHoleUniforms.uDiskEnabled.value = state.diskEnabled ? 1.0 : 0.0;
  });
}

// Preset Buttons
const presetButtons = document.querySelectorAll(".preset-btn");
presetButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const presetKey = btn.getAttribute("data-preset");
    const preset = PRESETS[presetKey];
    if (!preset) return;

    presetButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    Object.assign(state, preset);
    cameraCtrl.targetTheta = preset.camTheta;
    cameraCtrl.targetPhi = preset.camPhi;
    cameraCtrl.targetDistance = preset.camDist;
    cameraCtrl.targetRoll = preset.roll;

    applyAllStateToUI();
  });
});

// Header Actions & Sidebar Toggle
const btnAutoOrbit = document.getElementById("btn-auto-orbit");
if (btnAutoOrbit) {
  btnAutoOrbit.addEventListener("click", () => {
    state.autoOrbit = !state.autoOrbit;
    btnAutoOrbit.classList.toggle("active", state.autoOrbit);
  });
}

const btnReset = document.getElementById("btn-reset");
if (btnReset) {
  btnReset.addEventListener("click", () => {
    const defaultBtn = document.querySelector('.preset-btn[data-preset="interstellar"]');
    if (defaultBtn) defaultBtn.click();
  });
}

const btnToggleSidebar = document.getElementById("btn-toggle-sidebar");
const toggleIcon = document.getElementById("toggle-icon");
const toggleText = document.getElementById("toggle-text");
if (btnToggleSidebar) {
  btnToggleSidebar.addEventListener("click", () => {
    const collapsed = document.body.classList.toggle("sidebar-collapsed");
    if (toggleIcon) toggleIcon.textContent = collapsed ? "◂" : "▸";
    if (toggleText) toggleText.textContent = collapsed ? "展开面板" : "收起面板";
  });
}

// Telemetry Elements
const telDistance = document.getElementById("tel-distance");
const telHorizon = document.getElementById("tel-horizon");
const telPhoton = document.getElementById("tel-photon");
const telFps = document.getElementById("tel-fps");
const telDilation = document.getElementById("tel-dilation");
const telDilationDesc = document.getElementById("tel-dilation-desc");

function updateTelemetry(fpsVal) {
  const rOverRs = cameraCtrl.distance;
  const spin = state.spin;
  const rHorizon = 0.5 + 0.5 * Math.sqrt(Math.max(0.02, 1.0 - spin * spin));
  const rPh = 1.5 - 0.42 * spin;

  if (telDistance) telDistance.textContent = `${rOverRs.toFixed(2)} Rs`;
  if (telHorizon) telHorizon.textContent = `${(rHorizon * state.rs).toFixed(2)} Rs`;
  if (telPhoton) telPhoton.textContent = `${(rPh * state.rs).toFixed(2)} Rs`;
  if (telFps && fpsVal !== null) telFps.textContent = `${Math.round(fpsVal)} FPS`;

  const ratio = Math.sqrt(Math.max(0.01, 1.0 - rHorizon / Math.max(rOverRs, rHorizon * 1.01)));
  if (telDilation) telDilation.textContent = `${ratio.toFixed(3)}x`;
  if (telDilationDesc) {
    const inv = 1.0 / ratio;
    if (inv > 4.0) {
      telDilationDesc.textContent = `强引力场：当前轨道 1 小时 ≈ 远方观测者 ${inv.toFixed(1)} 小时`;
    } else {
      telDilationDesc.textContent = `当前轨道 1 小时 ≈ 远方观测者 ${inv.toFixed(2)} 小时`;
    }
  }
}

function renderBloomPasses() {
  // 1. Extract bright HDR highlights
  quadMesh.material = matBloomExtract;
  matBloomExtract.uniforms.tDiffuse.value = rtScene.texture;
  renderer.setRenderTarget(rtBloomExtract);
  renderer.render(postScene, orthoCamera);

  // 2. Isotropic Wide Bloom (2 iterations of separable Gaussian blur)
  quadMesh.material = matBloomBlur;
  const wideTexelX = 1.0 / rtBloomWideA.width;
  const wideTexelY = 1.0 / rtBloomWideA.height;

  let readBuffer = rtBloomExtract;
  for (let i = 0; i < 2; i++) {
    const spread = i === 0 ? 1.0 : 2.1;
    matBloomBlur.uniforms.tDiffuse.value = readBuffer.texture;
    matBloomBlur.uniforms.uTexelSize.value.set(wideTexelX * spread, wideTexelY * spread);

    matBloomBlur.uniforms.uDirection.value.set(1.0, 0.0);
    renderer.setRenderTarget(rtBloomWideA);
    renderer.render(postScene, orthoCamera);

    matBloomBlur.uniforms.tDiffuse.value = rtBloomWideA.texture;
    matBloomBlur.uniforms.uDirection.value.set(0.0, 1.0);
    renderer.setRenderTarget(rtBloomWideB);
    renderer.render(postScene, orthoCamera);

    readBuffer = rtBloomWideB;
  }

  // 3. Anamorphic Horizontal Streak Pass (wide horizontal spread for IMAX flare)
  const anaTexelX = 1.0 / rtBloomAnaA.width;
  const anaTexelY = 1.0 / rtBloomAnaA.height;
  let anaRead = rtBloomExtract;

  for (let i = 0; i < 3; i++) {
    const hSpread = (i + 1) * 3.2;
    matBloomBlur.uniforms.tDiffuse.value = anaRead.texture;
    matBloomBlur.uniforms.uTexelSize.value.set(anaTexelX * hSpread, anaTexelY);
    matBloomBlur.uniforms.uDirection.value.set(1.0, 0.0);
    renderer.setRenderTarget(rtBloomAnaA);
    renderer.render(postScene, orthoCamera);

    matBloomBlur.uniforms.tDiffuse.value = rtBloomAnaA.texture;
    matBloomBlur.uniforms.uTexelSize.value.set(anaTexelX * (hSpread + 1.2), anaTexelY * 0.5);
    matBloomBlur.uniforms.uDirection.value.set(1.0, 0.15);
    renderer.setRenderTarget(rtBloomAnaB);
    renderer.render(postScene, orthoCamera);

    anaRead = rtBloomAnaB;
  }
}

let lastFrameTime = performance.now();
let elapsedSimTime = 0;
let skyRotAccum = 0;
let frameCount = 0;
let fpsTimer = performance.now();

function animate(now) {
  requestAnimationFrame(animate);

  const dt = Math.min((now - lastFrameTime) * 0.001, 0.1);
  lastFrameTime = now;
  elapsedSimTime += dt;
  skyRotAccum += dt * state.skyDrift * 0.12;

  if (state.autoOrbit && !cameraCtrl.isDragging) {
    cameraCtrl.targetTheta += dt * 0.18;
  }

  const damp = 1.0 - Math.exp(-10.5 * dt);
  cameraCtrl.theta += (cameraCtrl.targetTheta - cameraCtrl.theta) * damp;
  cameraCtrl.phi += (cameraCtrl.targetPhi - cameraCtrl.phi) * damp;
  cameraCtrl.distance += (cameraCtrl.targetDistance - cameraCtrl.distance) * damp;
  cameraCtrl.roll += (cameraCtrl.targetRoll - cameraCtrl.roll) * damp;

  updateCameraMatrix();

  blackHoleUniforms.uTime.value = elapsedSimTime;
  blackHoleUniforms.uSkyRotation.value = skyRotAccum;

  // Pass 1: Relativistic Raymarched Black Hole
  quadMesh.material = matBlackHole;
  renderer.setRenderTarget(rtScene);
  renderer.render(postScene, orthoCamera);

  // Pass 2 & 3: Multi-scale Bloom & Anamorphic Flare
  renderBloomPasses();

  // Pass 4: Composite + ACES Tone Mapping to Screen
  quadMesh.material = matComposite;
  matComposite.uniforms.tScene.value = rtScene.texture;
  matComposite.uniforms.tBloomWide.value = rtBloomWideB.texture;
  matComposite.uniforms.tBloomAnamorphic.value = rtBloomAnaB.texture;
  matComposite.uniforms.uTime.value = elapsedSimTime;
  renderer.setRenderTarget(null);
  renderer.render(postScene, orthoCamera);

  frameCount++;
  if (now - fpsTimer >= 350) {
    const currentFps = (frameCount * 1000) / (now - fpsTimer);
    updateTelemetry(currentFps);
    frameCount = 0;
    fpsTimer = now;
  } else {
    updateTelemetry(null);
  }
}

applyAllStateToUI();
requestAnimationFrame(animate);
