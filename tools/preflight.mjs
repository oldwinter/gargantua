#!/usr/bin/env node
/**
 * tools/preflight.mjs — zero-dependency static checker for the WebGL2 black-hole page.
 *
 * No browser. No network. Pure static analysis of the workspace.
 *
 *   node tools/preflight.mjs            # human table
 *   node tools/preflight.mjs --json     # machine-readable JSON on stdout
 *   node tools/preflight.mjs --strict   # treat warnings as failures
 *
 * Exit 0 = all hard checks pass, 1 = at least one hard check failed.
 *
 * Checks
 *   FILES     required files exist
 *   SYNTAX    `node --check` on every .js under js/
 *   REFS      index.html references exactly the expected css/js with RELATIVE paths
 *   ORDER     script tags ordered params → shaders → camera → renderer → ui → app
 *   MODULE    no <script type="module"> (file:// breaks module loading)
 *   IDS       every id="..." in index.html is unique
 *   DOMREF    every getElementById / querySelector('#..') / $('#..') resolves to a real id
 *   NET       no external http(s)/protocol-relative/CDN references
 *   GLSL      shader template literals are balanced, no #version (INFO only)
 *   SIZE      bytes per file + grand total
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const TOOLS_DIR = path.dirname(__filename);
const ROOT = path.resolve(TOOLS_DIR, '..');

const JSON_MODE = process.argv.includes('--json');
const STRICT = process.argv.includes('--strict');

// ---------------------------------------------------------------------------
// Expected layout
// ---------------------------------------------------------------------------
const REQUIRED_FILES = [
  'index.html',
  'css/style.css',
  'js/params.js',
  'js/ui.js',
  'js/shaders.js',
  'js/camera.js',
  'js/renderer.js',
  'js/app.js',
];

const EXPECTED_SCRIPTS = ['js/params.js', 'js/shaders.js', 'js/camera.js', 'js/renderer.js', 'js/ui.js', 'js/app.js'];
const EXPECTED_STYLES = ['css/style.css'];

// ---------------------------------------------------------------------------
// Results accumulator
// ---------------------------------------------------------------------------
const results = [];   // { check, status: 'PASS'|'FAIL'|'WARN'|'INFO', detail }
let failures = 0;
let warnings = 0;

function record(check, status, detail) {
  results.push({ check, status, detail });
  if (status === 'FAIL') failures++;
  if (status === 'WARN') warnings++;
}
const pass = (c, d) => record(c, 'PASS', d);
const fail = (c, d) => record(c, 'FAIL', d);
const warn = (c, d) => record(c, 'WARN', d);
const info = (c, d) => record(c, 'INFO', d);

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function readText(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

/** Strip // line comments and /* *​/ block comments from JS, preserving strings roughly. */
function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let mode = 'code'; // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && c2 === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { mode = 'block'; i += 2; continue; }
      if (c === "'") { mode = 'sq'; out += c; i++; continue; }
      if (c === '"') { mode = 'dq'; out += c; i++; continue; }
      if (c === '`') { mode = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c; } i++; continue; }
    if (mode === 'block') { if (c === '*' && c2 === '/') { mode = 'code'; i += 2; } else i++; continue; }
    if (mode === 'sq') { if (c === '\\') { out += c + (c2 ?? ''); i += 2; continue; } if (c === "'") mode = 'code'; out += c; i++; continue; }
    if (mode === 'dq') { if (c === '\\') { out += c + (c2 ?? ''); i += 2; continue; } if (c === '"') mode = 'code'; out += c; i++; continue; }
    if (mode === 'tpl') {
      if (c === '\\') { out += c + (c2 ?? ''); i += 2; continue; }
      if (c === '`') { mode = 'code'; out += c; i++; continue; }
      out += c; i++; continue;
    }
  }
  return out;
}

// ===========================================================================
// 1. FILES
// ===========================================================================
const fileInfo = new Map(); // relPath -> { exists, bytes }
for (const f of REQUIRED_FILES) {
  const abs = path.join(ROOT, f);
  if (existsSync(abs) && statSync(abs).isFile()) {
    fileInfo.set(f, { exists: true, bytes: statSync(abs).size });
  } else {
    fileInfo.set(f, { exists: false, bytes: 0 });
    fail('FILES', `missing required file: ${f}`);
  }
}
const missingFiles = REQUIRED_FILES.filter((f) => !fileInfo.get(f).exists);
if (missingFiles.length === 0) pass('FILES', `all ${REQUIRED_FILES.length} required files present`);
else fail('FILES', `${missingFiles.length}/${REQUIRED_FILES.length} required file(s) missing: ${missingFiles.join(', ')}`);

// ===========================================================================
// 2. SYNTAX — node --check on every .js under js/
// ===========================================================================
function walkJs(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(abs));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(abs);
  }
  return out;
}

const jsDir = path.join(ROOT, 'js');
const jsFiles = walkJs(jsDir);
if (jsFiles.length === 0) {
  fail('SYNTAX', 'no .js files found under js/');
} else {
  let syntaxOk = 0;
  for (const abs of jsFiles) {
    try {
      // NOTE: stdio must not be piped — some sandboxes deny pipe creation (spawn EPERM).
      execFileSync(process.execPath, ['--check', abs], { stdio: 'ignore', windowsHide: true, timeout: 20000 });
      syntaxOk++;
    } catch (e) {
      let msg = e && e.message ? e.message.split('\n')[0] : String(e);
      if (e && e.status !== undefined && e.status !== null) msg = `exit ${e.status}`;
      if (e && e.code === 'EPERM') msg = 'could not spawn node (EPERM — sandbox denied stdio pipe)';
      fail('SYNTAX', `${rel(abs)}: ${msg}`);
    }
  }
  if (syntaxOk === jsFiles.length) pass('SYNTAX', `node --check clean on all ${jsFiles.length} file(s) under js/`);
  else fail('SYNTAX', `${jsFiles.length - syntaxOk}/${jsFiles.length} file(s) failed node --check`);
}

// ===========================================================================
// 3-6. index.html: REFS / ORDER / MODULE / IDS
// ===========================================================================
const htmlPath = path.join(ROOT, 'index.html');
const html = readText(htmlPath);
const htmlIds = new Set();
const htmlIdList = [];

if (html === null) {
  fail('REFS', 'index.html missing — cannot check references');
  fail('ORDER', 'index.html missing');
  fail('MODULE', 'index.html missing');
  fail('IDS', 'index.html missing');
} else {
  // --- strip HTML comments so commented-out tags do not fool us ---
  const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');

  // ---------- REFS: scripts + styles ----------
  const scriptSrcs = [...htmlNoComments.matchAll(/<script\b([^>]*)>/gi)].map((m) => {
    const attrs = m[1];
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    return {
      attrs,
      src: src ? (src[1] ?? src[2] ?? src[3] ?? '') : null,
      hasSrc: !!src,
    };
  });
  const linkHrefs = [...htmlNoComments.matchAll(/<link\b([^>]*)>/gi)].map((m) => {
    const attrs = m[1];
    const relAttr = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    return {
      attrs,
      rel: relAttr ? (relAttr[1] ?? relAttr[2] ?? relAttr[3] ?? '').toLowerCase() : '',
      href: href ? (href[1] ?? href[2] ?? href[3] ?? '') : null,
    };
  });

  const cssLinks = linkHrefs.filter((l) => l.rel.split(/\s+/).includes('stylesheet') && l.href);
  const jsTags = scriptSrcs.filter((s) => s.hasSrc);

  // absolute-path references are a hard fail (file:// root would be C:\)
  const absRefs = [
    ...jsTags.filter((s) => /^\/[^/]/.test(s.src)).map((s) => `src="${s.src}"`),
    ...cssLinks.filter((l) => /^\/[^/]/.test(l.href)).map((l) => `href="${l.href}"`),
  ];
  if (absRefs.length) fail('REFS', `absolute (root-relative) path(s) break file:// loading: ${absRefs.join(', ')}`);
  else pass('REFS', 'no root-relative script/style paths');

  const norm = (p) => String(p).replace(/^\.\//, '').replace(/\\/g, '/').toLowerCase();

  const foundScripts = jsTags.map((s) => norm(s.src));
  const foundStyles = cssLinks.map((l) => norm(l.href));
  const wantScripts = EXPECTED_SCRIPTS.map(norm);
  const wantStyles = EXPECTED_STYLES.map(norm);

  const missingScripts = wantScripts.filter((w) => !foundScripts.includes(w));
  const extraScripts = foundScripts.filter((f) => !wantScripts.includes(f));
  if (missingScripts.length) fail('REFS', `index.html is missing script tag(s): ${missingScripts.join(', ')}`);
  if (extraScripts.length) warn('REFS', `index.html references unexpected script(s): ${extraScripts.join(', ')}`);
  if (!missingScripts.length && !extraScripts.length) pass('REFS', `all ${wantScripts.length} expected script tags present, none extra`);

  const missingStyles = wantStyles.filter((w) => !foundStyles.includes(w));
  const extraStyles = foundStyles.filter((f) => !wantStyles.includes(f));
  if (missingStyles.length) fail('REFS', `index.html is missing stylesheet: ${missingStyles.join(', ')}`);
  if (extraStyles.length) warn('REFS', `index.html references unexpected stylesheet(s): ${extraStyles.join(', ')}`);
  if (!missingStyles.length && !extraStyles.length) pass('REFS', `stylesheet ${wantStyles.join(', ')} linked`);

  // ---------- ORDER ----------
  const orderIdx = wantScripts.map((w) => foundScripts.indexOf(w));
  if (missingScripts.length) {
    fail('ORDER', 'cannot verify script order — script tag(s) missing');
  } else {
    let okOrder = true;
    for (let i = 1; i < orderIdx.length; i++) {
      if (orderIdx[i] <= orderIdx[i - 1]) { okOrder = false; break; }
    }
    if (okOrder) pass('ORDER', `script order correct: ${EXPECTED_SCRIPTS.join(' → ')}`);
    else fail('ORDER', `script order wrong. expected ${EXPECTED_SCRIPTS.join(' → ')}; got ${jsTags.map((s) => s.src).join(' → ')}`);
  }

  // ---------- MODULE ----------
  const moduleTags = scriptSrcs.filter((s) => /\btype\s*=\s*(?:"module"|'module'|module\b)/i.test(s.attrs));
  const moduleInline = /<script\b[^>]*\btype\s*=\s*(?:"module"|'module')/i.test(htmlNoComments);
  if (moduleTags.length || moduleInline) {
    fail('MODULE', `<script type="module"> present (${moduleTags.length} tag(s)) — ES modules do not load from file://`);
  } else {
    pass('MODULE', 'no <script type="module"> tags');
  }

  // ---------- IDS uniqueness ----------
  const idMatches = [...htmlNoComments.matchAll(/\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)];
  const seen = new Map();
  for (const m of idMatches) {
    const id = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!id) continue;
    htmlIdList.push(id);
    seen.set(id, (seen.get(id) || 0) + 1);
  }
  for (const id of htmlIdList) htmlIds.add(id);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id}×${n}`);
  if (dupes.length) fail('IDS', `duplicate id(s) in index.html: ${dupes.join(', ')}`);
  else pass('IDS', `${htmlIds.size} unique id(s) in index.html`);
}

// ===========================================================================
// 7. DOMREF — getElementById / querySelector('#..') / $('#..') → real id
// ===========================================================================
if (html !== null && jsFiles.length) {
  const domRefs = new Map(); // id -> Set(sourceFile)
  const patterns = [
    /document\s*\.\s*getElementById\s*\(\s*(['"`])([^'"`]+)\1/g,
    /document\s*\.\s*querySelector\s*\(\s*(['"`])#([A-Za-z_][-\w]*)\1/g,
    /document\s*\.\s*querySelectorAll\s*\(\s*(['"`])#([A-Za-z_][-\w]*)\1/g,
    /(?<![\w.$])\$\s*\(\s*(['"`])#([A-Za-z_][-\w]*)\1/g,
  ];

  // Detect a local `$` helper that wraps getElementById (very common in this codebase):
  //   function $(id) { return document.getElementById(id); }
  //   var $ = function (id) { return document.getElementById(id); };
  // When present, `$('bare-id')` is an id lookup, not a CSS selector.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  let bareDollarIsId = false;
  for (const abs of jsFiles) {
    const src = stripComments(readText(abs) || '');
    if (/(?:function\s+\$|(?:var|let|const)\s+\$\s*=\s*function|\$\s*=\s*function\b)[\s\S]{0,160}?getElementById/.test(src) ||
        /(?:var|let|const)\s+\$\s*=\s*(?:document\s*\.\s*)?getElementById/.test(src)) {
      bareDollarIsId = true;
      break;
    }
  }
  if (bareDollarIsId) {
    // Only bare identifiers: no '#', '.', '[', spaces or '>' — those are CSS selectors.
    patterns.push(/(?<![\w.$])\$\s*\(\s*(['"`])([A-Za-z_][-\w]*)\1\s*\)/g);
  }

  for (const abs of jsFiles) {
    const raw = readText(abs) || '';
    const src = stripComments(raw);
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const id = m[2];
        if (!domRefs.has(id)) domRefs.set(id, new Set());
        domRefs.get(id).add(rel(abs));
      }
    }
  }
  const missing = [...domRefs.entries()].filter(([id]) => !htmlIds.has(id));
  if (missing.length) {
    for (const [id, files] of missing) {
      warn('DOMREF', `id "${id}" referenced in ${[...files].join(', ')} but not found in index.html`);
    }
  } else {
    pass('DOMREF', `all ${domRefs.size} DOM id reference(s) in js/ resolve to index.html ids${bareDollarIsId ? ' (incl. bare $("id") helper calls)' : ''}`);
  }
  // Unused ids are informational: an id may be styled by CSS or used via data-attributes.
  const unreferenced = [...htmlIds].filter((id) => !domRefs.has(id));
  if (unreferenced.length) info('DOMREF', `${unreferenced.length} id(s) in index.html are not looked up from js/: ${unreferenced.slice(0, 12).join(', ')}${unreferenced.length > 12 ? '…' : ''}`);
}

// ===========================================================================
// 8. NET — no external network dependencies
// ===========================================================================
const SCAN_EXT = new Set(['.js', '.css', '.html']);
function walkAll(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkAll(abs, acc);
    else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name).toLowerCase())) acc.push(abs);
  }
  return acc;
}
const allSourceFiles = walkAll(ROOT).filter((p) => {
  const r = rel(p);
  // tools/ is allowed loopback URLs (it is the test harness, not the shipped page)
  return !r.startsWith('tools/') && !r.startsWith('.tmp/');
});
const toolsFiles = walkAll(ROOT).filter((p) => rel(p).startsWith('tools/'));

const NET_RE = /\b(?:https?:\/\/|\/\/cdn[\w.-]*)/gi;
const ALLOW_LOCAL = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:[\/?#]|$)/i;
// XML namespace identifiers are URIs but are NEVER fetched. They appear in inline
// `data:image/svg+xml,...` backgrounds and in SVG markup; flagging them is a false positive.
const XML_NS_HOSTS = /^https?:\/\/(?:www\.)?w3\.org\//i;
const netHits = [];
for (const abs of allSourceFiles) {
  const txt = readText(abs) || '';
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    NET_RE.lastIndex = 0;
    let m;
    while ((m = NET_RE.exec(line))) {
      // find the full URL-ish token for the exemption checks
      const start = m.index;
      const token = line.slice(start, start + 300);
      const urlMatch = /^(https?:\/\/[^\s'"`)<>,]+)/i.exec(token);
      if (urlMatch) {
        if (ALLOW_LOCAL.test(urlMatch[1])) continue;   // loopback is fine
        if (XML_NS_HOSTS.test(urlMatch[1])) continue;  // w3.org namespace URI, never fetched
      }
      // protocol-relative //cdn.foo/... is always external
      netHits.push({ file: rel(abs), line: i + 1, snippet: line.trim().slice(0, 160) });
      break; // one hit per line is enough
    }
  }
}
if (netHits.length) {
  for (const h of netHits.slice(0, 25)) fail('NET', `${h.file}:${h.line} external reference — ${h.snippet}`);
  if (netHits.length > 25) fail('NET', `… and ${netHits.length - 25} more external reference(s)`);
} else {
  pass('NET', `no external http(s)/CDN references in ${allSourceFiles.length} shipped file(s)`);
}
// tools/ may use loopback only — flag anything else there
const toolNetHits = [];
for (const abs of toolsFiles) {
  const txt = readText(abs) || '';
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/(?:\/\/cdn)/i.test(line)) toolNetHits.push({ file: rel(abs), line: i + 1, snippet: line.trim().slice(0, 140) });
  }
}
if (toolNetHits.length) {
  for (const h of toolNetHits.slice(0, 10)) warn('NET', `${h.file}:${h.line} CDN reference in tools/ — ${h.snippet}`);
} else {
  pass('NET', 'no CDN references in tools/');
}

// ===========================================================================
// 9. GLSL sanity in js/shaders.js
// ===========================================================================
const shadersPath = path.join(ROOT, 'js/shaders.js');
const shadersSrc = readText(shadersPath);
if (shadersSrc === null) {
  fail('GLSL', 'js/shaders.js missing — cannot check shaders');
} else {
  // --- backtick template literal balance + ${ } closure ---
  let backticks = 0;
  let unclosedInterp = 0;
  let i = 0;
  const n = shadersSrc.length;
  while (i < n) {
    const c = shadersSrc[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '/' && shadersSrc[i + 1] === '/') { while (i < n && shadersSrc[i] !== '\n') i++; continue; }
    if (c === '/' && shadersSrc[i + 1] === '*') {
      i += 2;
      while (i < n && !(shadersSrc[i] === '*' && shadersSrc[i + 1] === '/')) i++;
      i += 2; continue;
    }
    if (c === '`') { backticks++; i++; continue; }
    if (c === '$' && shadersSrc[i + 1] === '{') {
      // walk to the matching close brace, tracking nesting and nested strings
      let depth = 1; let j = i + 2;
      while (j < n && depth > 0) {
        const d = shadersSrc[j];
        if (d === '\\') { j += 2; continue; }
        if (d === "'" || d === '"' || d === '`') {
          const q = d; j++;
          while (j < n) {
            if (shadersSrc[j] === '\\') { j += 2; continue; }
            if (shadersSrc[j] === q) { j++; break; }
            j++;
          }
          continue;
        }
        if (d === '{') depth++;
        else if (d === '}') depth--;
        j++;
      }
      if (depth !== 0) unclosedInterp++;
      i = j; continue;
    }
    i++;
  }
  const evenBackticks = backticks % 2 === 0;
  if (!evenBackticks) fail('GLSL', `unbalanced backticks in js/shaders.js (${backticks} found — odd count means an unterminated template literal)`);
  if (unclosedInterp) fail('GLSL', `${unclosedInterp} unclosed \${...} interpolation(s) in js/shaders.js`);
  if (evenBackticks && !unclosedInterp) pass('GLSL', `${backticks} template literal delimiter(s) balanced, all \${...} closed`);

  // --- #version presence: INFO only ---
  const versionHits = [];
  shadersSrc.split('\n').forEach((line, idx) => {
    if (/^\s*#\s*version\b/.test(line)) versionHits.push({ line: idx + 1, text: line.trim() });
  });
  if (versionHits.length) {
    info('GLSL', `${versionHits.length} #version directive(s) present (line ${versionHits.map((v) => v.line).join(', ')}) — INFO only; this codebase's ES 3.00 shaders normally omit it`);
  } else {
    info('GLSL', 'no #version directives (expected for this codebase style)');
  }

  // --- extra useful sanity: shader source count ---
  const glslMain = (shadersSrc.match(/\bvoid\s+main\s*\(/g) || []).length;
  info('GLSL', `${glslMain} shader main() definition(s) detected in js/shaders.js`);
}

// ===========================================================================
// 10. SIZE
// ===========================================================================
let grandTotal = 0;
const sizeRows = [];
for (const f of REQUIRED_FILES) {
  const meta = fileInfo.get(f);
  if (meta && meta.exists) {
    grandTotal += meta.bytes;
    sizeRows.push({ file: f, bytes: meta.bytes });
  }
}
// include any extra .js under js/ that is not in the required list
for (const abs of jsFiles) {
  const r = rel(abs);
  if (!REQUIRED_FILES.includes(r)) {
    const b = statSync(abs).size;
    grandTotal += b;
    sizeRows.push({ file: r + ' (extra)', bytes: b });
  }
}
if (grandTotal === 0) fail('SIZE', 'total size 0 — no shipped files exist yet');
else pass('SIZE', `${sizeRows.length} file(s), ${grandTotal.toLocaleString('en-US')} bytes total`);

// ===========================================================================
// Report
// ===========================================================================
const fmtBytes = (b) => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
};

const hardFail = failures > 0 || (STRICT && warnings > 0);
const exitCode = hardFail ? 1 : 0;

if (JSON_MODE) {
  process.stdout.write(JSON.stringify({
    ok: !hardFail,
    exitCode,
    root: ROOT,
    summary: { passed: results.filter((r) => r.status === 'PASS').length, failed: failures, warnings, info: results.filter((r) => r.status === 'INFO').length },
    results,
    sizes: { rows: sizeRows, total: grandTotal },
    missingFiles,
    htmlIds: htmlIdList,
  }, null, 2) + '\n');
} else {
  const lines = [];
  const W = 92;
  const bar = '─'.repeat(W);
  lines.push('');
  lines.push('  PREFLIGHT — WebGL2 black-hole page (static, no browser)');
  lines.push(`  root: ${ROOT}`);
  lines.push('  ' + bar);

  const label = { FILES: 'Required files', SYNTAX: 'JS syntax', REFS: 'HTML references', ORDER: 'Script order', MODULE: 'No ES modules', IDS: 'Unique ids', DOMREF: 'DOM id refs', NET: 'No external net', GLSL: 'GLSL sanity', SIZE: 'File sizes' };
  const icon = { PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN', INFO: 'INFO' };
  const seenChecks = new Set();
  for (const r of results) {
    const name = label[r.check] || r.check;
    lines.push(`  ${icon[r.status]}  ${name.padEnd(18)} ${r.detail}`);
    seenChecks.add(r.check);
  }
  lines.push('  ' + bar);

  // size table
  if (sizeRows.length) {
    lines.push('');
    lines.push('  File sizes');
    lines.push('  ' + '─'.repeat(56));
    lines.push(`  ${'file'.padEnd(40)} ${'bytes'.padStart(10)}  ${'human'.padStart(9)}`);
    for (const row of sizeRows) {
      lines.push(`  ${row.file.padEnd(40)} ${String(row.bytes).padStart(10)}  ${fmtBytes(row.bytes).padStart(9)}`);
    }
    lines.push('  ' + '─'.repeat(56));
    lines.push(`  ${'TOTAL'.padEnd(40)} ${String(grandTotal).padStart(10)}  ${fmtBytes(grandTotal).padStart(9)}`);
    lines.push('');
  }

  const passed = results.filter((r) => r.status === 'PASS').length;
  const infos = results.filter((r) => r.status === 'INFO').length;
  lines.push(`  ${hardFail ? '✗ PREFLIGHT FAILED' : '✓ PREFLIGHT PASSED'}   ${passed} passed · ${failures} failed · ${warnings} warning(s) · ${infos} info`);
  if (missingFiles.length) lines.push(`  missing: ${missingFiles.join(', ')}`);
  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
}

process.exitCode = exitCode;
