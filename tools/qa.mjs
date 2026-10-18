#!/usr/bin/env node
/**
 * tools/qa.mjs — one-command acceptance sweep for the Gargantua WebGL2 page.
 *
 * Pure orchestrator. Zero dependencies (Node built-ins only). It never launches a
 * browser itself — it shells out to the tools that already do that, aggregates their
 * verdicts, and prints ONE final PASS/FAIL plus a markdown report.
 *
 *   node tools/qa.mjs                 # full sweep
 *   node tools/qa.mjs --dry-run       # print every command it WOULD run, spawn nothing
 *   node tools/qa.mjs --json          # also dump machine-readable .tmp/qa/report.json
 *   node tools/qa.mjs --skip-perf     # run everything except the fps assertion
 *   node tools/qa.mjs --only render   # only the render sweep (repeatable)
 *
 * Steps
 *   1. tools/preflight.mjs        static checks (files, refs, order, ids, net, GLSL balance)
 *   2. tools/glsl-check.mjs       real ANGLE/GLSL compile of every shader
 *   3. tools/interact-test.mjs    9 real-mouse interaction tests
 *   4. render sweep               6 presets -> .tmp/qa/<id>.png via tools/shot.mjs
 *   5. perf assertion             parse "统计: fps=NN.N" from shot stdout, fail if < 30
 *
 * Output
 *   .tmp/qa/<preset>.png          one screenshot per preset
 *   .tmp/qa/report.md             markdown table of every check + measured numbers
 *   .tmp/qa/report.json           (only with --json)
 *
 * Exit codes
 *   0  every check passed
 *   1  at least one check failed
 *   2  the orchestrator itself could not run (bad args, missing tool file, ...)
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, writeFileSync, readFileSync, statSync,
  openSync, closeSync, unlinkSync, readdirSync, rmSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const TOOLS_DIR = path.dirname(__filename);
const ROOT = path.resolve(TOOLS_DIR, '..');
const QA_DIR = path.join(ROOT, '.tmp', 'qa');
const SCRATCH_DIR = path.join(ROOT, '.tmp', 'qa-scratch');

const NODE = process.execPath;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const valueOf = (f, dflt) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

const DRY_RUN = has('dry-run');
const JSON_OUT = has('json');
const SKIP_PERF = has('skip-perf');
const SWEEP = has('sweep');
const FPS_MIN = Number(valueOf('fps-min', '30'));
const ONLY = (() => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only' && argv[i + 1]) out.push(argv[i + 1]);
  }
  return out;
})();
const want = (step) => ONLY.length === 0 || ONLY.includes(step);

if (has('help') || has('-h')) {
  process.stdout.write(`tools/qa.mjs — one-command acceptance sweep

  node tools/qa.mjs [options]

  --dry-run        print every command that WOULD run, spawn nothing
  --json           also write .tmp/qa/report.json
  --skip-perf      skip the fps >= ${FPS_MIN} assertion
  --fps-min <n>    minimum acceptable fps (default 30)
  --only <step>    run only: preflight | glsl | interact | render | perf (repeatable)
  --sweep          delete stale (>10 min) leftover browser profile dirs in .tmp/.
                   Off by default: other agents may be mid-run in the same workspace.
  --help

Exit: 0 all passed, 1 something failed, 2 orchestrator error.
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Preset render sweep definition
// ---------------------------------------------------------------------------
const PRESETS = [
  { id: 'film', name: '电影版', params: { autoRotate: false } },
  {
    id: 'physical', name: '真实物理',
    params: {
      dopplerBeaming: 1.0, diskTemp: 11000, diskThickness: 0.02, lensing: 1.0,
      diskInner: 3.0, chromatic: 0.05, bloomStrength: 0.55, autoRotate: false,
    },
  },
  {
    id: 'minimal', name: '极简暗黑',
    params: {
      starBrightness: 0.5, diskBrightness: 0.8, bloomStrength: 0.35, vignette: 0.7,
      grain: 0.12, chromatic: 0.0, exposure: 0.85, autoRotate: false,
    },
  },
  {
    id: 'hot', name: '炽热红盘',
    params: { diskTemp: 3400, diskBrightness: 1.8, bloomStrength: 1.1, exposure: 1.05, autoRotate: false },
  },
  {
    id: 'bluegiant', name: '蓝白巨星',
    params: {
      blackHoleMass: 2.4, diskTemp: 17000, diskOuter: 18.0, diskBrightness: 1.6,
      lensing: 1.35, bloomStrength: 1.2, autoRotate: false,
    },
  },
  {
    id: 'thinring', name: '薄环奇观',
    params: {
      diskInner: 3.0, diskOuter: 20.0, diskThickness: 0.0, diskTurbulence: 0.85,
      lensing: 1.6, starBrightness: 1.6, bloomStrength: 0.6, autoRotate: false,
    },
  },
];

// Render-sweep timing (ms). Generous: browser boot + WebGL warm-up + settle.
const RENDER_WAIT = '6500';
const RENDER_SETTLE = '3500';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const stripAnsi = (s) => String(s == null ? '' : s).replace(ANSI, '');

function tail(text, lines = 12, width = 160) {
  const clean = stripAnsi(text).trimEnd();
  if (!clean) return '';
  const arr = clean.split(/\r?\n/);
  return arr
    .slice(-lines)
    .map((l) => (l.length > width ? l.slice(0, width) + '…' : l))
    .join('\n');
}

function firstMatch(text, re) {
  const m = re.exec(stripAnsi(text));
  return m ? m[1] : null;
}

/** Pull the most informative single line out of a failing tool's output. */
function firstFailureLine(text) {
  const clean = stripAnsi(text);
  if (!clean.trim()) return '';
  const patterns = [
    /\[[A-Za-z0-9_-]+\]\s*(?:Error|FATAL)?:?\s*(.+)/,   // [shot] Error: ...
    /(?:FATAL|Fatal|Error|ERROR)\s*[:：]\s*(.+)/,        // Error: ...
    /^\s*[✗x×]\s*(.+)$/m,                                 // ✗ marker lines
    /(\d+\s*个着色器有问题)/,
    /(\d+\s*\/\s*\d+\s*项失败)/,
  ];
  for (const re of patterns) {
    const m = re.exec(clean);
    if (m) {
      const line = String(m[1] || m[0]).trim();
      if (line) return line.length > 140 ? line.slice(0, 140) + '…' : line;
    }
  }
  const lastLine = clean.trim().split(/\r?\n/).filter((l) => l.trim()).pop() || '';
  return lastLine.length > 140 ? lastLine.slice(0, 140) + '…' : lastLine;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function nowIso() { return new Date().toISOString(); }

// ---------------------------------------------------------------------------
// Result accumulator
// ---------------------------------------------------------------------------
/** @type {{name:string, group:string, ok:boolean, detail:string, ms:number, cmd?:string, stderrTail?:string}[]} */
const results = [];
let currentGroup = 'setup';

function record(name, ok, detail, extra = {}) {
  results.push({
    name, group: currentGroup, ok, detail: String(detail || ''),
    ms: extra.ms || 0, cmd: extra.cmd, stderrTail: extra.stderrTail,
  });
}

function banner(title) {
  process.stdout.write(`\n${'─'.repeat(74)}\n  ${title}\n${'─'.repeat(74)}\n`);
}

// ---------------------------------------------------------------------------
// Process runner (the only place that spawns)
// ---------------------------------------------------------------------------
function quoteArg(a) {
  const s = String(a);
  if (s === '') return '""';
  return /[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function prettyCmd(cmd, args) {
  return [quoteArg(cmd), ...args.map(quoteArg)].join(' ');
}

/** Child env: never let a corporate proxy intercept loopback. */
function childEnv() {
  const env = { ...process.env };
  const loop = ['127.0.0.1', 'localhost', '::1'];
  for (const k of ['NO_PROXY', 'no_proxy']) {
    const cur = env[k] ? env[k].split(',').map((s) => s.trim()).filter(Boolean) : [];
    env[k] = [...new Set([...cur, ...loop])].join(',');
  }
  // Make the children's console output deterministic for parsing.
  env.FORCE_COLOR = '0';
  env.NO_COLOR = '1';
  return env;
}

/**
 * Run a node script, capture stdout/stderr, never throw.
 * Returns { ok, code, stdout, stderr, ms, spawnError }.
 *
 * Transport fallback: some hardened sandboxes deny piped stdio with `spawn EPERM`.
 * When that happens we retry once with stdout/stderr redirected to a temp file
 * (plain file I/O), which works wherever file writes are allowed.
 */
function runNode(args, { timeoutMs = 240000, cwd = ROOT } = {}) {
  const display = prettyCmd(NODE, args);
  if (DRY_RUN) {
    process.stdout.write(`    [dry-run] ${display}\n`);
    return { ok: true, code: 0, stdout: '', stderr: '', ms: 0, dryRun: true };
  }
  const started = Date.now();

  // ---- attempt 1: normal pipes ----
  try {
    const stdout = execFileSync(NODE, args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: childEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, code: 0, stdout: String(stdout || ''), stderr: '', ms: Date.now() - started, transport: 'pipe' };
  } catch (e) {
    const pipedDenied = e && e.code === 'EPERM';
    if (!pipedDenied) {
      // Non-zero exit: execFileSync throws but still carries stdout/stderr.
      const code = typeof e.status === 'number' ? e.status : null;
      const stdout = e.stdout != null ? String(e.stdout) : '';
      const stderr = e.stderr != null ? String(e.stderr) : '';
      let spawnError = null;
      if (e.code === 'ETIMEDOUT' || e.signal) {
        spawnError = `timed out after ${timeoutMs}ms (signal ${e.signal || 'n/a'})`;
      } else if (code === null && !stdout && !stderr) {
        spawnError = e.message ? e.message.split('\n')[0] : String(e);
      }
      return { ok: false, code, stdout, stderr, ms: Date.now() - started, spawnError, transport: 'pipe' };
    }
  }

  // ---- attempt 2: file-redirected stdio (sandbox-friendly) ----
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const outPath = path.join(SCRATCH_DIR, `child-${stamp}.out`);
  const errPath = path.join(SCRATCH_DIR, `child-${stamp}.err`);
  let outFd = null, errFd = null;
  try {
    mkdirSync(SCRATCH_DIR, { recursive: true });
    outFd = openSync(outPath, 'w');
    errFd = openSync(errPath, 'w');
    execFileSync(NODE, args, {
      cwd,
      timeout: timeoutMs,
      env: childEnv(),
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
    });
    const stdout = readFileSync(outPath, 'utf8');
    const stderr = readFileSync(errPath, 'utf8');
    return { ok: true, code: 0, stdout, stderr, ms: Date.now() - started, transport: 'file' };
  } catch (e) {
    let stdout = '';
    let stderr = '';
    try { stdout = readFileSync(outPath, 'utf8'); } catch { /* may not exist */ }
    try { stderr = readFileSync(errPath, 'utf8'); } catch { /* may not exist */ }
    const code = typeof e.status === 'number' ? e.status : null;
    let spawnError = null;
    if (e.code === 'EPERM') {
      spawnError = 'EPERM: the sandbox denied spawning a child process with any stdio transport.';
    } else if (e.code === 'ETIMEDOUT' || e.signal) {
      spawnError = `timed out after ${timeoutMs}ms (signal ${e.signal || 'n/a'})`;
    } else if (code === null && !stdout && !stderr) {
      spawnError = e.message ? e.message.split('\n')[0] : String(e);
    }
    return { ok: false, code, stdout, stderr, ms: Date.now() - started, spawnError, transport: 'file' };
  } finally {
    try { if (outFd !== null) closeSync(outFd); } catch { /* ignore */ }
    try { if (errFd !== null) closeSync(errFd); } catch { /* ignore */ }
    try { unlinkSync(outPath); } catch { /* ignore */ }
    try { unlinkSync(errPath); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Step 1-3: run an existing tool and derive PASS/FAIL
// ---------------------------------------------------------------------------
function requireTool(rel) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) {
    record(`tool exists: ${rel}`, false, `missing: ${abs}`);
    return null;
  }
  return abs;
}

/**
 * Run one of the pre-existing tools and record its verdict.
 * `summarize(stdout)` returns a short human detail string.
 */
function runToolStep({ label, rel, args = [], timeoutMs = 240000, summarize }) {
  currentGroup = label;
  banner(label);
  const abs = requireTool(rel);
  if (!abs) return { ok: false };

  const res = runNode([abs, ...args], { timeoutMs });
  if (DRY_RUN) {
    record(label, true, 'dry-run: command printed, nothing executed');
    return res;
  }

  const out = res.stdout || '';
  const err = res.stderr || '';
  const ok = res.ok;
  // Derive a detail string that is truthful even on failure. The tool may exit 0 while
  // still printing a failure marker (or vice versa), so prefer explicit evidence.
  let detail;
  if (res.spawnError) {
    detail = res.spawnError;
  } else if (!ok) {
    detail = `exit ${res.code === null ? '?' : res.code}`;
    const hint = firstFailureLine(err) || firstFailureLine(out);
    if (hint) detail += ` · ${hint}`;
  } else {
    detail = summarize ? summarize(out, err) : 'exit 0';
  }

  record(label, ok, detail, {
    ms: res.ms,
    cmd: prettyCmd(NODE, [abs, ...args]),
    stderrTail: ok ? '' : tail(err || out, 12),
  });

  // Echo a trimmed version so the console shows real numbers.
  const show = tail(out, ok ? 8 : 16);
  if (show) process.stdout.write(show.split('\n').map((l) => `    ${l}`).join('\n') + '\n');
  if (!ok && err.trim()) {
    process.stdout.write(tail(err, 10).split('\n').map((l) => `    ! ${l}`).join('\n') + '\n');
  }
  return res;
}

// ---------------------------------------------------------------------------
// Step 4-5: render sweep + perf
// ---------------------------------------------------------------------------
function buildEval(preset) {
  // Deterministic JSON with stable key order so the command line is reproducible.
  const entries = Object.entries(preset.params);
  const body = entries.map(([k, v]) => `${k}:${JSON.stringify(v)}`).join(',');
  return `BH.setMany({${body}})`;
}

function runRenderSweep() {
  currentGroup = 'render sweep';
  banner('render sweep — 6 presets (tools/shot.mjs)');

  const shot = requireTool('tools/shot.mjs');
  if (!shot) return;

  if (!DRY_RUN) mkdirSync(QA_DIR, { recursive: true });

  const perfRows = [];

  for (const preset of PRESETS) {
    const outAbs = path.join(QA_DIR, `${preset.id}.png`);
    const evalJs = buildEval(preset);
    const args = [
      shot,
      '--out', outAbs,
      '--wait', RENDER_WAIT,
      '--settle', RENDER_SETTLE,
      '--eval', evalJs,
    ];

    const res = runNode(args, { timeoutMs: 180000 });
    if (DRY_RUN) {
      record(`render: ${preset.id} (${preset.name})`, true, 'dry-run: command printed, nothing executed');
      perfRows.push({ preset, fps: null });
      continue;
    }

    const out = res.stdout || '';
    const err = res.stderr || '';
    const clean = stripAnsi(out);

    // shot exits 0 only when: no console errors, no exceptions, probe.ok true.
    const exitOk = res.ok && res.code === 0;

    // Belt-and-braces: also look for shot.mjs 的自身错误标记.
    const sawConsoleErrors = /错误\s*\(\d+\)/.test(clean);
    const sawExceptions = /异常\s*\(\d+\)/.test(clean);
    const sawFail = /(^|\n)\s*FAIL\s*(\n|$)/.test(clean);
    const noErrorText = !sawConsoleErrors && !sawExceptions && !sawFail;

    // PNG must exist and be non-trivial.
    let bytes = 0;
    if (existsSync(outAbs)) {
      try { bytes = statSync(outAbs).size; } catch { bytes = 0; }
    }
    const pngOk = bytes > 20 * 1024; // a real 1600x900 render is ~2 MB; 20 KB is a safe floor

    // fps from the 统计: line
    const fpsRaw = firstMatch(out, /统计:\s*fps=([0-9]+(?:\.[0-9]+)?)/);
    const fps = fpsRaw === null ? null : Number(fpsRaw);
    const sampleMax = firstMatch(out, /采样=[0-9]+\/([0-9]+)/);

    perfRows.push({ preset, fps });

    const perfOk = SKIP_PERF ? true : (fps !== null && fps >= FPS_MIN);
    const ok = exitOk && noErrorText && pngOk && perfOk;

    const bits = [];
    bits.push(exitOk ? 'exit 0' : `exit ${res.code ?? '?'}${res.spawnError ? ` (${res.spawnError})` : ''}`);
    bits.push(pngOk ? `${fmtBytes(bytes)} png` : `PNG ${existsSync(outAbs) ? 'too small (' + fmtBytes(bytes) + ')' : 'MISSING'}`);
    if (fps !== null) bits.push(`fps=${fps.toFixed(1)}`);
    else bits.push('fps=unparsed');
    if (SKIP_PERF) bits.push('perf skipped');
    else if (fps !== null && fps < FPS_MIN) bits.push(`BELOW MIN ${FPS_MIN}`);
    if (sampleMax !== null) bits.push(`samples≤${sampleMax}`);
    if (sawConsoleErrors) bits.push('console errors present');
    if (sawExceptions) bits.push('exceptions present');

    record(`render: ${preset.id} (${preset.name})`, ok, bits.join(' · '), {
      ms: res.ms,
      cmd: prettyCmd(NODE, args),
      stderrTail: ok ? '' : tail(err || out, 14),
    });

    process.stdout.write(`    ${ok ? 'PASS' : 'FAIL'}  ${preset.id.padEnd(10)} ${bits.join(' · ')}\n`);
    if (!ok) {
      const t = tail(err || out, 12);
      if (t) process.stdout.write(t.split('\n').map((l) => `          ! ${l}`).join('\n') + '\n');
    }
  }

  // ---- aggregate perf assertion ----
  currentGroup = 'perf';
  banner(`perf assertion (fps >= ${FPS_MIN})`);
  if (SKIP_PERF) {
    record('perf: min fps', true, 'skipped via --skip-perf');
    process.stdout.write('    skipped via --skip-perf\n');
  } else if (DRY_RUN) {
    record('perf: min fps', true, `dry-run: would assert every preset fps >= ${FPS_MIN}`);
    process.stdout.write(`    [dry-run] would assert every preset fps >= ${FPS_MIN}\n`);
  } else {
    const measured = perfRows.filter((r) => r.fps !== null);
    if (measured.length === 0) {
      record('perf: min fps', false, 'no fps value could be parsed from any shot run');
      process.stdout.write('    FAIL  no fps parsed\n');
    } else {
      const min = measured.reduce((a, b) => (a.fps <= b.fps ? a : b));
      const ok = min.fps >= FPS_MIN;
      const detail = `min fps=${min.fps.toFixed(1)} (${min.preset.id}) · median-ish across ${measured.length} preset(s)`;
      record('perf: min fps', ok, detail);
      process.stdout.write(`    ${ok ? 'PASS' : 'FAIL'}  ${detail}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Orphan detection (read-only by default)
// ---------------------------------------------------------------------------
/**
 * Find leftover browser state from interrupted runs.
 *
 * IMPORTANT: these tools must not fight each other. Several agents/tools share
 * `.tmp`, and a profile directory that looks stale may belong to a run that is
 * starting up right now. So this is REPORT-ONLY by default; `--sweep` opts in to
 * actually deleting, and even then only entries older than STALE_MS are touched.
 * Live browser processes are never killed.
 */
const PROFILE_RE = /^(shot-profile-|glsl-profile|interact-|qa-chrome-)/;
const STALE_MS = 10 * 60 * 1000; // 10 minutes

function findOrphans() {
  const TMP_DIR = path.join(ROOT, '.tmp');
  const found = { dirs: [], processes: 0 };
  if (DRY_RUN) return found;

  try {
    const now = Date.now();
    for (const name of readdirSync(TMP_DIR)) {
      if (!PROFILE_RE.test(name)) continue;
      const abs = path.join(TMP_DIR, name);
      try {
        const st = statSync(abs);
        if (!st.isDirectory()) continue;
        found.dirs.push({ path: abs, ageMs: now - st.mtimeMs });
      } catch { /* vanished */ }
    }
  } catch { /* no .tmp */ }

  if (process.platform === 'win32') {
    try {
      const script = path.join(TMP_DIR, 'qa-count-browsers.ps1');
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(script, [
        "$ErrorActionPreference='SilentlyContinue'",
        `$marker = '${TMP_DIR.replace(/'/g, "''")}'`,
        '$n = 0',
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" | ForEach-Object {",
        '  if ($_.CommandLine -and $_.CommandLine.Contains($marker)) { $n++ }',
        '}',
        'Write-Output $n',
      ].join('\r\n'), 'utf8');
      const res = runNode([script], { timeoutMs: 30000 });
      const parsed = parseInt(stripAnsi(res.stdout || '0').trim(), 10);
      found.processes = Number.isFinite(parsed) ? parsed : 0;
      try { unlinkSync(script); } catch { /* ignore */ }
    } catch { /* best effort */ }
  }
  return found;
}

/** Only called with --sweep: delete profile dirs older than STALE_MS. */
function sweepStale(orphans) {
  let removed = 0;
  for (const d of orphans.dirs) {
    if (d.ageMs < STALE_MS) continue;
    try {
      rmSync(d.path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      if (!existsSync(d.path)) removed++;
    } catch { /* in use */ }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function buildReport(verdict) {
  const lines = [];
  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const failed = total - passed;

  lines.push('# Gargantua QA report');
  lines.push('');
  lines.push(`- Generated: \`${nowIso()}\``);
  lines.push(`- Workspace: \`${ROOT}\``);
  lines.push(`- Node: \`${process.version}\` on \`${process.platform}/${process.arch}\``);
  lines.push(`- Mode: ${DRY_RUN ? '**dry-run (nothing executed)**' : 'full sweep'}${SKIP_PERF ? ' · perf skipped' : ` · fps floor ${FPS_MIN}`}`);
  lines.push(`- Verdict: **${verdict ? 'PASS' : 'FAIL'}** — ${passed}/${total} checks passed${failed ? `, ${failed} failed` : ''}`);
  lines.push('');
  lines.push('## Checks');
  lines.push('');
  lines.push('| # | Check | Result | Detail |');
  lines.push('|---|-------|--------|--------|');
  results.forEach((r, i) => {
    const detail = String(r.detail || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    const trunc = detail.length > 220 ? detail.slice(0, 220) + '…' : detail;
    lines.push(`| ${i + 1} | ${r.name.replace(/\|/g, '\\|')} | ${r.ok ? '**PASS**' : '**FAIL**'} | ${trunc} |`);
  });
  lines.push('');

  // screenshots
  lines.push('## Preset screenshots');
  lines.push('');
  lines.push('| Preset | Label | File | Size |');
  lines.push('|--------|-------|------|------|');
  for (const p of PRESETS) {
    const abs = path.join(QA_DIR, `${p.id}.png`);
    let size = 'missing';
    if (existsSync(abs)) {
      try { size = fmtBytes(statSync(abs).size); } catch { size = '?'; }
    }
    lines.push(`| \`${p.id}\` | ${p.name} | \`.tmp/qa/${p.id}.png\` | ${size} |`);
  }
  lines.push('');

  // failures with stderr tails
  const failures = results.filter((r) => !r.ok);
  if (failures.length) {
    lines.push('## Failures');
    lines.push('');
    for (const f of failures) {
      lines.push(`### ${f.name}`);
      lines.push('');
      lines.push(`- Detail: ${f.detail || '(none)'}`);
      if (f.cmd) lines.push(`- Command: \`${f.cmd}\``);
      if (f.stderrTail) {
        lines.push('- Output tail:');
        lines.push('');
        lines.push('```text');
        lines.push(f.stderrTail);
        lines.push('```');
      }
      lines.push('');
    }
  } else {
    lines.push('## Failures');
    lines.push('');
    lines.push('None.');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(verdict ? '**FINAL VERDICT: PASS**' : '**FINAL VERDICT: FAIL**');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  process.stdout.write(`\nQA sweep — ${ROOT}\n`);
  if (DRY_RUN) {
    process.stdout.write('DRY RUN: printing commands only, nothing will be executed.\n');
  }

  // ---- 1. preflight ----
  if (want('preflight')) {
    runToolStep({
      label: 'preflight (static)',
      rel: 'tools/preflight.mjs',
      timeoutMs: 120000,
      summarize: (out) => {
        const passed = firstMatch(out, /(\d+)\s+passed/);
        const failed = firstMatch(out, /(\d+)\s+failed/);
        const warns = firstMatch(out, /(\d+)\s+warning/);
        const total = firstMatch(out, /TOTAL\s+(\d+)/);
        const parts = [];
        if (passed !== null) parts.push(`${passed} passed`);
        if (failed !== null) parts.push(`${failed} failed`);
        if (warns !== null) parts.push(`${warns} warning(s)`);
        if (total !== null) parts.push(`total ${fmtBytes(Number(total))}`);
        return parts.length ? parts.join(' · ') : 'exit 0';
      },
    });
  }

  // ---- 2. glsl ----
  if (want('glsl')) {
    runToolStep({
      label: 'glsl-check (real compile)',
      rel: 'tools/glsl-check.mjs',
      timeoutMs: 180000,
      summarize: (out) => {
        const renderer = firstMatch(out, /WebGL2\s*渲染器:\s*(.+)/);
        const okCount = (stripAnsi(out).match(/✓/g) || []).length;
        const badCount = (stripAnsi(out).match(/✗/g) || []).length;
        const bits = [];
        if (okCount) bits.push(`${okCount} shader/program(s) compiled`);
        if (badCount) bits.push(`${badCount} failed`);
        if (renderer) bits.push(renderer.trim().slice(0, 90));
        return bits.length ? bits.join(' · ') : 'exit 0';
      },
    });
  }

  // ---- 3. interact ----
  if (want('interact')) {
    runToolStep({
      label: 'interact-test (9 mouse tests)',
      rel: 'tools/interact-test.mjs',
      timeoutMs: 180000,
      summarize: (out) => {
        const m = /全部\s*(\d+)\s*项交互测试通过/.exec(stripAnsi(out));
        if (m) return `${m[1]}/${m[1]} interaction tests passed`;
        const f = /(\d+)\s*\/\s*(\d+)\s*项失败/.exec(stripAnsi(out));
        if (f) return `${f[1]}/${f[2]} interaction tests FAILED`;
        return 'exit 0';
      },
    });
  }

  // ---- 4 + 5. render sweep & perf ----
  if (want('render') || want('perf')) {
    runRenderSweep();
  }

  // ---- hygiene (report-only unless --sweep) ----
  currentGroup = 'hygiene';
  const orphans = findOrphans();
  const stale = orphans.dirs.filter((d) => d.ageMs >= STALE_MS);
  let sweptCount = 0;
  if (!DRY_RUN && SWEEP) sweptCount = sweepStale(orphans);
  const liveOrphans = orphans.processes;
  const hyOk = liveOrphans === 0;
  let hyDetail;
  if (DRY_RUN) {
    hyDetail = 'dry-run: would count leftover browser profiles/processes under .tmp';
  } else {
    hyDetail = `${liveOrphans} live browser process(es) · ${orphans.dirs.length} profile dir(s) (${stale.length} stale>10min)`;
    if (SWEEP) hyDetail += ` · ${sweptCount} stale removed`;
    else if (stale.length) hyDetail += ' · pass --sweep to remove stale';
  }
  record('hygiene: no orphan browsers', hyOk, hyDetail);
  if (!DRY_RUN && liveOrphans > 0) {
    process.stdout.write(`\n  WARNING: ${liveOrphans} browser process(es) still running with this workspace's profile.\n`);
  }

  // ---- verdict ----
  const failed = results.filter((r) => !r.ok);
  const verdict = failed.length === 0;

  if (!DRY_RUN) {
    try {
      mkdirSync(QA_DIR, { recursive: true });
      writeFileSync(path.join(QA_DIR, 'report.md'), buildReport(verdict), 'utf8');
      if (JSON_OUT) {
        writeFileSync(
          path.join(QA_DIR, 'report.json'),
          JSON.stringify({ generated: nowIso(), root: ROOT, verdict, dryRun: DRY_RUN, fpsMin: FPS_MIN, results }, null, 2),
          'utf8',
        );
      }
    } catch (e) {
      process.stderr.write(`\nWARN: could not write report: ${e.message}\n`);
    }
  }

  // ---- console summary ----
  banner('SUMMARY');
  for (const r of results) {
    process.stdout.write(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}\n`);
  }
  process.stdout.write('\n');
  const passedCount = results.length - failed.length;
  process.stdout.write(`  ${passedCount}/${results.length} checks passed\n`);
  if (!DRY_RUN) {
    process.stdout.write(`  report: ${path.join(QA_DIR, 'report.md')}\n`);
    process.stdout.write(`  shots : ${QA_DIR}\n`);
  }
  process.stdout.write('\n');
  process.stdout.write(verdict
    ? '  ===== FINAL VERDICT: PASS =====\n\n'
    : '  ===== FINAL VERDICT: FAIL =====\n\n');

  return verdict ? 0 : 1;
}

let code;
try {
  code = main();
} catch (e) {
  process.stderr.write(`\n[qa] orchestrator error: ${e && e.stack ? e.stack : e}\n`);
  code = 2;
}
process.exitCode = code;
