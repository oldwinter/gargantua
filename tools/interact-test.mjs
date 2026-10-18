/**
 * tools/interact-test.mjs — 真实交互测试
 *
 * 用 CDP 派发真实的鼠标事件，验证：
 *   1. 拖动旋转（相机方位角/极角确实变化）
 *   2. 滚轮缩放
 *   3. 侧边栏折叠按钮
 *   4. 预设按钮真的改参数
 *   5. 滑块拖动改参数
 *   6. 双击复位视角
 *
 * 用法: node tools/interact-test.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('找不到浏览器'); process.exit(2); }

const W = 1440;
const H = 900;

async function main() {
  const profile = resolve(ROOT, '.tmp', 'interact-' + Date.now());
  mkdirSync(profile, { recursive: true });

  const proc = spawn(CHROME, [
    '--headless=new', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-gpu',
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', '--force-device-scale-factor=1',
    `--window-size=${W},${H}`, '--remote-debugging-port=0',
    '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { proc.kill('SIGKILL'); } catch (_) {}
    try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) {}
    try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  };

  let port = 0;
  const pf = resolve(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150; i++) {
    if (existsSync(pf)) {
      try { port = parseInt(readFileSync(pf, 'utf8').split('\n')[0], 10); if (port > 0) break; } catch (_) {}
    }
    await sleep(100);
  }
  if (!port) { cleanup(); throw new Error('no DevTools port'); }

  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

  let id = 0;
  const pend = new Map();
  const errs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const { resolve: rs, reject: rj } = pend.get(m.id);
      pend.delete(m.id);
      m.error ? rj(new Error(JSON.stringify(m.error))) : rs(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      errs.push((d.text || '') + ' ' + ((d.exception && d.exception.description) || ''));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errs.push((m.params.args || []).map((a) => a.value || a.description).join(' '));
    }
  });
  const send = (method, params = {}) => new Promise((rs, rj) => {
    const i = ++id;
    pend.set(i, { resolve: rs, reject: rj });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rj(new Error(method + ' timeout')); } }, 25000);
  });

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __error: JSON.stringify(r.exceptionDetails).slice(0, 500) };
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'file:///' + resolve(ROOT, 'index.html').replace(/\\/g, '/') });
  await sleep(5000);

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log((ok ? '  \x1b[32m✓\x1b[0m ' : '  \x1b[31m✗\x1b[0m ') + name + (detail ? '  — ' + detail : ''));
  };

  /* ---------- 关掉自动旋转，保证读数稳定 ---------- */
  await evalJs(`BH.set('autoRotate', false)`);
  await sleep(300);

  const camState = () => evalJs(`(function(){
    var c = BH.app && BH.app.camera;
    return c ? JSON.stringify({az: c.azimuth, pol: c.polar, dist: c.distance}) : null;
  })()`);

  /* ---------- 1. 拖动旋转 ---------- */
  const before = JSON.parse(await camState());
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 500, y: 450, button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 8; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 500 + i * 18, y: 450 + i * 6, button: 'left', buttons: 1 });
    await sleep(35);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 644, y: 498, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(900);
  const afterDrag = JSON.parse(await camState());
  const azDelta = Math.abs(afterDrag.az - before.az);
  check('拖动旋转改变方位角', azDelta > 0.05, `Δazimuth=${azDelta.toFixed(3)} rad`);

  /* ---------- 2. 滚轮缩放 ---------- */
  const d0 = afterDrag.dist;
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 450, deltaX: 0, deltaY: -240 });
  await sleep(400);
  const d1 = JSON.parse(await camState()).dist;
  check('滚轮缩放改变距离', Math.abs(d1 - d0) > 0.2, `${d0.toFixed(1)} → ${d1.toFixed(1)}`);
  /* 缩回去 */
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 450, deltaX: 0, deltaY: 240 });
  await sleep(300);

  /* ---------- 3. 双击复位 ---------- */
  for (const t of ['mousePressed', 'mouseReleased', 'mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type: t, x: 500, y: 450, button: 'left', clickCount: 2, buttons: 0 });
    await sleep(30);
  }
  await sleep(1200);
  const afterReset = JSON.parse(await camState());
  check('双击复位视角', Math.abs(afterReset.az - 0.62) < 0.25, `azimuth=${afterReset.az.toFixed(3)} (目标 0.62)`);

  /* ---------- 4. 预设按钮 ---------- */
  const presetInfo = await evalJs(`(function(){
    var btns = document.querySelectorAll('[data-preset], .preset-btn, #presets button');
    if (!btns.length) return JSON.stringify({n:0});
    var labels = [];
    for (var i=0;i<btns.length;i++) labels.push(btns[i].textContent.trim());
    return JSON.stringify({n: btns.length, labels: labels});
  })()`);
  const pi = JSON.parse(presetInfo);
  check('预设按钮存在', pi.n >= 6, `${pi.n} 个: ${(pi.labels || []).join(' / ')}`);

  if (pi.n > 0) {
    const clicked = await evalJs(`(function(){
      var btns = document.querySelectorAll('[data-preset], .preset-btn, #presets button');
      for (var i=0;i<btns.length;i++){
        if (btns[i].textContent.indexOf('炽热') >= 0) { btns[i].click(); return 'ok'; }
      }
      btns[btns.length-1].click(); return 'fallback';
    })()`);
    await sleep(500);
    const st = await evalJs(`JSON.stringify({temp: BH.state.diskTemp, bright: BH.state.diskBrightness})`);
    check('点击预设改变参数', st.indexOf('3400') >= 0, clicked + ' → ' + st);
  }

  /* ---------- 5. 恢复默认 ---------- */
  await evalJs(`BH.reset()`);
  await sleep(300);
  const afterReset2 = await evalJs(`JSON.stringify({temp: BH.state.diskTemp, brightness: BH.state.diskBrightness})`);
  check('恢复默认值', afterReset2.indexOf('8200') >= 0, afterReset2);

  /* ---------- 6. 侧边栏折叠 ---------- */
  const toggleExists = await evalJs(`!!document.getElementById('sidebar-toggle')`);
  if (toggleExists) {
    const beforeCls = await evalJs(`document.body.className`);
    await evalJs(`document.getElementById('sidebar-toggle').click()`);
    await sleep(500);
    const afterCls = await evalJs(`document.body.className`);
    const w = await evalJs(`document.getElementById('sidebar') ? document.getElementById('sidebar').getBoundingClientRect().width : -1`);
    check('侧边栏折叠', beforeCls !== afterCls, `class: "${beforeCls}" → "${afterCls}", width=${w}`);
    await evalJs(`document.getElementById('sidebar-toggle').click()`);
    await sleep(400);
  } else {
    check('侧边栏折叠', false, '找不到 #sidebar-toggle');
  }

  /* ---------- 7. 滑块拖动 ---------- */
  const sliderBox = await evalJs(`(function(){
    var s = document.querySelector('#sidebar input[type=range]');
    if (!s) return null;
    var row = s.closest ? s.closest('[data-key]') : null;
    var r = s.getBoundingClientRect();
    return JSON.stringify({
      x: r.x, y: r.y, w: r.width, h: r.height,
      key: row ? row.getAttribute('data-key') : (s.dataset ? s.dataset.key : null)
    });
  })()`);
  if (sliderBox) {
    const b = JSON.parse(sliderBox);
    const key = b.key;
    const beforeVal = await evalJs(`BH.state['${key}']`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x + b.w * 0.5, y: b.y + b.h / 2, button: 'left', clickCount: 1, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x + b.w * 0.88, y: b.y + b.h / 2, button: 'left', buttons: 1 });
    await sleep(120);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x + b.w * 0.88, y: b.y + b.h / 2, button: 'left', clickCount: 1, buttons: 0 });
    await sleep(400);
    const afterVal = await evalJs(`BH.state['${key}']`);
    check('拖动滑块改变参数', Math.abs(afterVal - beforeVal) > 1e-6, `${key}: ${beforeVal} → ${afterVal}`);
  } else {
    check('拖动滑块改变参数', false, '找不到 range 输入');
  }

  /* ---------- 8. 最终错误检查 ---------- */
  check('无 JS 异常', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : 'clean');

  /* ---------- 截图存档 ---------- */
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(resolve(ROOT, '.tmp'), { recursive: true });
  writeFileSync(resolve(ROOT, '.tmp', 'after-interact.png'), Buffer.from(shot.data, 'base64'));

  ws.close();
  cleanup();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '─'.repeat(64));
  if (failed.length) {
    console.log(`\x1b[31m${failed.length} / ${results.length} 项失败\x1b[0m`);
    process.exit(1);
  }
  console.log(`\x1b[32m全部 ${results.length} 项交互测试通过\x1b[0m`);
  process.exit(0);
}

main().catch((e) => { console.error('[interact-test] ' + (e && e.stack || e)); process.exit(2); });
