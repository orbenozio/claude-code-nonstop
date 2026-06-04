'use strict';

/*
 * Safe end-to-end integration test against a COPY of the real Claude Code bundle.
 * Reads the live index.js read-only, runs the full inject/strip pipeline on a copy,
 * and asserts the output is valid JavaScript, has exactly one Nonstop block,
 * and preserves any other extension's injection. The user's real install is never modified.
 *
 * Usage: node test/integration-real.js "<path-to-claude index.js>"
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const injector = require('../src/injector');
const { detectOtherInjection } = require('../src/coexistence');

const indexPath = process.argv[2];
if (!indexPath || !fs.existsSync(indexPath)) {
  console.error('Provide a path to a real Claude Code webview/index.js');
  process.exit(2);
}

const original = fs.readFileSync(indexPath, 'utf8');
const hadOther = detectOtherInjection(original);
const scriptBody = fs.readFileSync(path.join(__dirname, '..', 'webview', 'nonstop.js'), 'utf8');
const cfgJson = JSON.stringify({ pingText: 'continue', debug: false });
const V = '0.1.0';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-int-'));
const copyPath = path.join(tmpDir, 'index.js');

function nodeCheck(file) {
  try { cp.execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); return true; }
  catch (e) { console.error(String(e.stderr || e.message).slice(0, 500)); return false; }
}

let ok = true;
function check(name, cond) { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) ok = false; }

console.log('\nintegration (real bundle copy)');
console.log('  source:', indexPath, '| other injection present:', hadOther, '| size:', original.length);

// 1) inject
const injected = injector.inject(original, V, cfgJson, scriptBody);
fs.writeFileSync(copyPath, injected, 'utf8');
check('injected output is valid JS (node --check)', nodeCheck(copyPath));
check('exactly one Nonstop block', injector.findBlocks(injected).length === 1);
check('injection valid for version', injector.hasValidInjection(injected, V));
check('other injection preserved (if it was present)', hadOther ? detectOtherInjection(injected) : true);

// 2) re-inject (idempotent)
const reinjected = injector.inject(injected, V, cfgJson, scriptBody);
check('re-inject keeps a single block', injector.findBlocks(reinjected).length === 1);
check('other injection still preserved after re-inject', hadOther ? detectOtherInjection(reinjected) : true);

// 3) strip restores to original bytes
const stripped = injector.stripAllBlocks(injected);
check('strip removes all our blocks', injector.findBlocks(stripped).length === 0);
// inject() appends "\n\n<block>\n"; stripAllBlocks should bring us back to original (modulo our trailing glue)
check('strip recovers original content', stripped.replace(/\s+$/, '') === original.replace(/\s+$/, ''));
check('stripped output is valid JS', (function () { const p = path.join(tmpDir, 's.js'); fs.writeFileSync(p, stripped); return nodeCheck(p); })());

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n' + (ok ? 'INTEGRATION PASS' : 'INTEGRATION FAIL') + '\n');
process.exit(ok ? 0 : 1);
