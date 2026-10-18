/**
 * tools/shot.mjs — 无头 Chrome 截图 + 控制台错误捕获
 *
 * 用法：
 *   node tools/shot.mjs --out .tmp/shot.png
 *   node tools/shot.mjs --out .tmp/a.png --wait 5000 --width 1600 --height 900
 *   node tools/shot.mjs --out .tmp/b.png --eval "BH.setMany({diskTemp:3400, bloomStrength:1.2})"
 *   node tools/shot.mjs --out .tmp/c.png --eval-file .tmp/probe.js
 *
 * 退出码：0 正常 / 1 页面有错误 / 2 工具本身失败
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (p && existsSync(p)) return p;
  throw new Error('找不到 Chrome / Edge');
}

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}
const hasFlag = (n) => process.argv.includes('--' + n);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OUT = resolve(ROOT, arg('out', '.tmp/shot.png'));
const WAIT = parseInt(arg('wait', '5000'), 10);
const SETTLE = parseInt(arg('settle', '2200'), 10);
const WIDTH = parseInt(arg('width', '1600'), 10);
const HEIGHT = parseInt(arg('height', '900'), 10);
const URL_ = arg('url', 'file:///' + resolve(ROOT, 'index.html').replace(/\\/g, '/'));
const EVAL_ = arg('eval', '');
const EVAL_FILE = arg('eval-file', '');
const JSON_OUT = arg('json', '');

async function main() {
  const chrome = findChrome();
  const profile = resolve(ROOT, '.tmp', 'shot-profile-' + Date.now());
  mkdirSync(profile, { recursive: true });

  const proc = spawn(chrome, [
    '--headless=new',
    /* 这台机器有真实 GPU；SwiftShader 在无头模式下建不出 WebGL2 */
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--enable-gpu',
    '--hide-scrollbars',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--allow-file-access-from-files',
    '--force-device-scale-factor=1',
    `--window-size=${WIDTH},${HEIGHT}`,
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
    if (process.platform === 'win32' && proc.pid) {
      try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { /* ignore */ }
    }
    try { rmSync(profile, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  };

  let port = 0;
  const portFile = resolve(profile, 'DevToolsActivePort');
  for (let i = 0; i < 150; i++) {
    if (existsSync(portFile)) {
      try {
        port = parseInt(readFileSync(portFile, 'utf8').split('\n')[0], 10);
        if (port > 0) break;
      } catch (_) { /* 还没写完 */ }
    }
    await sleep(100);
  }
  if (!port) { cleanup(); throw new Error('Chrome 没有写出 DevToolsActivePort'); }

  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) { cleanup(); throw new Error('没有可用的 page target'); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });

  let msgId = 0;
  const pending = new Map();
  const consoleMsgs = [];
  const exceptions = [];
  const netFailures = [];

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve: rs, reject: rj } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rj(new Error(JSON.stringify(m.error)));
      else rs(m.result);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || [])
        .map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type))
        .join(' ');
      consoleMsgs.push({ level: m.params.type, text });
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      exceptions.push({
        text: d.text || '',
        desc: (d.exception && (d.exception.description || d.exception.value)) || '',
        url: d.url, line: d.lineNumber, col: d.columnNumber,
      });
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry || {};
      if (e.level === 'error') consoleMsgs.push({ level: 'error', text: (e.source || '') + ': ' + (e.text || '') });
    } else if (m.method === 'Network.loadingFailed') {
      netFailures.push({ id: m.params.requestId, err: m.params.errorText });
    }
  });

  const send = (method, params = {}) => new Promise((rs, rj) => {
    const id = ++msgId;
    pending.set(id, { resolve: rs, reject: rj });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); rj(new Error(method + ' 超时')); }
    }, 25000);
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  });

  await send('Page.navigate', { url: URL_ });
  await sleep(WAIT);

  /* 额外注入的脚本 */
  let evalScript = EVAL_;
  if (EVAL_FILE) evalScript = readFileSync(resolve(ROOT, EVAL_FILE), 'utf8');
  if (evalScript) {
    await send('Runtime.evaluate', { expression: evalScript, returnByValue: true, awaitPromise: true });
    await sleep(SETTLE);
  }

  /* 内置探针 */
  const probeExpr = `(() => {
    try {
      const c = document.getElementById('glcanvas');
      let gl2 = false, rend = null;
      try {
        const tc = document.createElement('canvas');
        const g = tc.getContext('webgl2');
        gl2 = !!g;
        if (g) {
          const d = g.getExtension('WEBGL_debug_renderer_info');
          rend = d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);
        }
      } catch (_) {}
      const stats = (window.BH && BH.app && BH.app.stats) ? BH.app.stats : null;
      return JSON.stringify({
        webgl2: gl2,
        renderer: rend,
        canvasSize: c ? [c.width, c.height] : null,
        bhLoaded: !!window.BH,
        uiLoaded: !!(window.BH && window.BH.ui),
        rendererLoaded: !!window.GargantuaRenderer,
        cameraLoaded: !!window.OrbitCamera,
        stats: stats,
        ok: !!(window.BH && c && c.width > 0)
      });
    } catch (e) { return JSON.stringify({ ok: false, error: String(e) }); }
  })()`;

  const pr = await send('Runtime.evaluate', { expression: probeExpr, returnByValue: true });
  let probe = {};
  try { probe = JSON.parse(pr.result.value); } catch (_) { probe = { ok: false, raw: pr }; }

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));

  ws.close();
  cleanup();

  const errs = consoleMsgs.filter((m) => m.level === 'error');
  const warns = consoleMsgs.filter((m) => m.level === 'warning' || m.level === 'warn');
  const logs = consoleMsgs.filter((m) => m.level === 'log' || m.level === 'info');

  const report = {
    ok: errs.length === 0 && exceptions.length === 0 && probe.ok === true,
    out: OUT,
    probe,
    consoleErrors: errs,
    consoleWarnings: warns,
    consoleLogs: logs,
    exceptions,
    networkFailures: netFailures,
  };

  if (JSON_OUT) writeFileSync(resolve(ROOT, JSON_OUT), JSON.stringify(report, null, 2));

  /* 紧凑打印 */
  console.log('─'.repeat(70));
  console.log('截图: ' + OUT);
  console.log('WebGL2: ' + (probe.webgl2 ? '✓' : '✗') +
    '   渲染器: ' + (probe.renderer || '?'));
  console.log('画布: ' + JSON.stringify(probe.canvasSize) +
    '   模块: BH=' + (probe.bhLoaded ? '✓' : '✗') +
    ' ui=' + (probe.uiLoaded ? '✓' : '✗') +
    ' renderer=' + (probe.rendererLoaded ? '✓' : '✗') +
    ' camera=' + (probe.cameraLoaded ? '✓' : '✗'));
  if (probe.stats) {
    console.log('统计: fps=' + (probe.stats.fps || 0).toFixed(1) +
      '  采样=' + probe.stats.samples + '/' + probe.stats.maxSamples +
      '  内部分辨率=' + probe.stats.width + 'x' + probe.stats.height);
  }
  if (logs.length) {
    console.log('\n控制台输出:');
    for (const l of logs) console.log('  · ' + l.text.slice(0, 300));
  }
  if (warns.length) {
    console.log('\n警告 (' + warns.length + '):');
    for (const w of warns.slice(0, 10)) console.log('  ! ' + w.text.slice(0, 400));
  }
  if (errs.length) {
    console.log('\n\x1b[31m错误 (' + errs.length + '):\x1b[0m');
    for (const e of errs.slice(0, 15)) console.log('  ✗ ' + e.text.slice(0, 600));
  }
  if (exceptions.length) {
    console.log('\n\x1b[31m异常 (' + exceptions.length + '):\x1b[0m');
    for (const e of exceptions.slice(0, 10)) {
      console.log('  ✗ ' + e.text);
      if (e.desc) console.log('    ' + e.desc.split('\n').slice(0, 6).join('\n    '));
    }
  }
  if (netFailures.length) {
    console.log('\n\x1b[31m网络失败:\x1b[0m');
    for (const n of netFailures.slice(0, 10)) console.log('  ✗ ' + n.err);
  }
  console.log('─'.repeat(70));
  console.log(report.ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m');

  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error('[shot] ' + (e && e.stack || e));
  process.exit(2);
});
