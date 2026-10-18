/**
 * tools/glsl-check.mjs — 用真实的 ANGLE/GLSL 编译器校验着色器
 *
 * 起一个无头 Chrome，把 js/shaders.js 里的每个着色器真正编译一遍，
 * 把编译日志原样打印出来。这样不用等人肉打开页面就能抓到 GLSL 语法错误。
 *
 * 用法：
 *   node tools/glsl-check.mjs
 *   node tools/glsl-check.mjs --steps 288
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  throw new Error('找不到 Chrome / Edge');
}

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const STEPS = arg('steps', '288');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chrome = findChrome();
  const profile = resolve(ROOT, '.tmp', 'glsl-profile');
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });

  const proc = spawn(chrome, [
    '--headless=new',
    /* 这台机器有真实 GPU（RTX 4060 Ti）。SwiftShader 软渲染在无头模式下
       创建 WebGL2 会失败，所以必须走硬件路径。 */
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--enable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    'about:blank',
  ], { stdio: 'ignore' });

  let port = 0;
  const portFile = resolve(profile, 'DevToolsActivePort');
  for (let i = 0; i < 120; i++) {
    if (existsSync(portFile)) {
      try {
        const txt = readFileSync(portFile, 'utf8').split('\n');
        port = parseInt(txt[0], 10);
        if (port > 0) break;
      } catch (_) { /* 还没写完 */ }
    }
    await sleep(120);
  }
  if (!port) throw new Error('Chrome 没有写出 DevToolsActivePort');

  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的 page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();

  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: rs, reject: rj } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rj(new Error(JSON.stringify(msg.error)));
      else rs(msg.result);
    }
  });

  const send = (method, params = {}) => new Promise((rs, rj) => {
    const id = ++msgId;
    pending.set(id, { resolve: rs, reject: rj });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); rj(new Error(method + ' 超时')); }
    }, 20000);
  });

  await send('Page.enable');
  await send('Runtime.enable');

  /* 把 shaders.js 读进来，在页面里 eval */
  const shadersSrc = readFileSync(resolve(ROOT, 'js', 'shaders.js'), 'utf8');
  const paramsSrc = readFileSync(resolve(ROOT, 'js', 'params.js'), 'utf8');

  const expr = `(() => {
    try {
      // 提供一个最小 window
      ${paramsSrc}
      ${shadersSrc}

      const S = window.SHADERS;
      if (!S) return JSON.stringify({ fatal: 'window.SHADERS 未定义' });

      const canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 64;
      const gl = canvas.getContext('webgl2');
      if (!gl) return JSON.stringify({ fatal: '无法创建 WebGL2 上下文' });

      const results = [];
      const def = '#define MAX_STEPS ${STEPS}\\n';

      function patch(src) {
        const m = /^(\\s*#version[^\\n]*\\n)/.exec(src);
        return m ? src.slice(0, m[0].length) + def + src.slice(m[0].length) : def + src;
      }

      function compile(type, src, label) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS);
        const log = gl.getShaderInfoLog(sh) || '';
        gl.deleteShader(sh);
        results.push({ label, ok: !!ok, log: log.trim() });
        return !!ok;
      }

      compile(gl.VERTEX_SHADER, S.fullscreenVS, 'fullscreenVS');
      compile(gl.FRAGMENT_SHADER, patch(S.blackholeFS), 'blackholeFS');
      compile(gl.FRAGMENT_SHADER, S.accumulateFS, 'accumulateFS');
      compile(gl.FRAGMENT_SHADER, S.brightPassFS, 'brightPassFS');
      compile(gl.FRAGMENT_SHADER, S.downsampleFS, 'downsampleFS');
      compile(gl.FRAGMENT_SHADER, S.upsampleFS, 'upsampleFS');
      compile(gl.FRAGMENT_SHADER, S.compositeFS, 'compositeFS');
      compile(gl.FRAGMENT_SHADER, S.copyFS, 'copyFS');

      // 再走一遍完整的 program link
      function link(vs, fs, label) {
        const v = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(v, vs); gl.compileShader(v);
        const f = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(f, fs); gl.compileShader(f);
        const p = gl.createProgram(); gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
        const ok = gl.getProgramParameter(p, gl.LINK_STATUS);
        const log = gl.getProgramInfoLog(p) || '';
        gl.deleteProgram(p); gl.deleteShader(v); gl.deleteShader(f);
        results.push({ label: 'LINK ' + label, ok: !!ok, log: log.trim() });
        return !!ok;
      }
      link(S.fullscreenVS, patch(S.blackholeFS), 'blackhole');
      link(S.fullscreenVS, S.compositeFS, 'composite');
      link(S.fullscreenVS, S.accumulateFS, 'accumulate');

      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return JSON.stringify({
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        floatTargets: !!gl.getExtension('EXT_color_buffer_float'),
        results
      });
    } catch (e) {
      return JSON.stringify({ fatal: String(e && e.stack || e) });
    }
  })()`;

  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });

  let payload;
  try {
    payload = JSON.parse(r.result.value);
  } catch (_) {
    payload = { fatal: '无法解析求值结果: ' + JSON.stringify(r).slice(0, 800) };
  }

  ws.close();
  try { proc.kill(); } catch (_) { /* ignore */ }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (_) { /* ignore */ }
  }

  if (payload.fatal) {
    console.error('\n[FATAL] ' + payload.fatal + '\n');
    process.exit(2);
  }

  console.log('\n  WebGL2 渲染器: ' + payload.renderer);
  console.log('  浮点渲染目标: ' + (payload.floatTargets ? '支持' : '不支持（会退化）'));
  console.log('  积分步数: ' + STEPS + '\n');

  let failed = 0;
  for (const res of payload.results) {
    if (res.ok) {
      console.log('  \x1b[32m✓\x1b[0m ' + res.label);
    } else {
      failed++;
      console.log('  \x1b[31m✗\x1b[0m ' + res.label);
      if (res.log) console.log(indent(res.log));
    }
  }

  console.log('');
  if (failed) {
    console.error(`\x1b[31m${failed} 个着色器有问题\x1b[0m\n`);
    process.exit(1);
  }
  console.log('\x1b[32m全部着色器编译通过\x1b[0m\n');
}

function indent(s) {
  return s.split('\n').map((l) => '      ' + l).join('\n');
}

main().catch((e) => {
  console.error('[glsl-check] ' + (e && e.stack || e));
  process.exit(2);
});
