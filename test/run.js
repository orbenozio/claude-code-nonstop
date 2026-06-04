'use strict';

/* Minimal dependency-free test runner for the host-side (pure) logic. */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const injector = require('../src/injector');
const { detectOtherInjection } = require('../src/coexistence');
const { writeAtomic, writeAndVerify } = require('../src/atomicWrite');
const { parseUsage } = require('../src/ratelimit/structured');
const { versionFromDirName } = require('../src/targets/claude-code');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '\n      ', e.message); }
}

const V = '0.1.0';
const SCRIPT = '(function(){/* ns */})();';
const CFGJSON = JSON.stringify({ pingText: 'continue' });
// Fixture simulating another extension's injection. The marker substring must
// match FOREIGN_MARKER so detectOtherInjection sees it.
const OTHER_BLOCK = '\n\n// RTL for VS Code Agents (injected)\nwindow.__OTHER_CONFIG__={};\n/* other body */\n';

console.log('\ninjector');
test('inject into clean content yields exactly one valid block', () => {
  const base = 'var claude = 1;\n';
  const out = injector.inject(base, V, CFGJSON, SCRIPT);
  assert.ok(injector.hasValidInjection(out, V), 'should be valid for version');
  assert.strictEqual(injector.findBlocks(out).length, 1);
  assert.ok(out.includes('var claude = 1;'), 'original content preserved');
});

test('inject is idempotent (re-inject keeps a single block)', () => {
  const base = 'X';
  let out = injector.inject(base, V, CFGJSON, SCRIPT);
  out = injector.inject(out, V, CFGJSON, SCRIPT);
  assert.strictEqual(injector.findBlocks(out).length, 1);
  assert.ok(injector.hasValidInjection(out, V));
});

test('version change invalidates injection (triggers reinject)', () => {
  const out = injector.inject('X', V, CFGJSON, SCRIPT);
  assert.ok(injector.hasValidInjection(out, V));
  assert.ok(!injector.hasValidInjection(out, '0.2.0'), 'different version is not valid');
});

test('another injection AFTER our block survives our strip/reinject', () => {
  let out = injector.inject('base', V, CFGJSON, SCRIPT);
  out = out + OTHER_BLOCK; // the other extension appends after us
  assert.ok(detectOtherInjection(out));
  // Re-inject (e.g. settings change): our block refreshed, the other untouched.
  const re = injector.inject(out, V, CFGJSON, SCRIPT);
  assert.ok(detectOtherInjection(re), 'the other injection must still be present');
  assert.strictEqual(injector.findBlocks(re).length, 1, 'one Nonstop block');
});

test('another injection BEFORE our block is preserved', () => {
  const base = 'base' + OTHER_BLOCK;
  const out = injector.inject(base, V, CFGJSON, SCRIPT);
  assert.ok(detectOtherInjection(out));
  assert.strictEqual(injector.findBlocks(out).length, 1);
});

test('fossilized duplicate Nonstop blocks are normalized to one', () => {
  let out = injector.inject('base', V, CFGJSON, SCRIPT);
  // Simulate a leftover older block (e.g. from another extension's restore that re-introduced it).
  const dup = injector.buildBlock('0.0.9', CFGJSON, SCRIPT);
  out = out + '\n' + dup + '\n';
  assert.strictEqual(injector.findBlocks(out).length, 2, 'precondition: two blocks');
  const fixed = injector.inject(out, V, CFGJSON, SCRIPT);
  assert.strictEqual(injector.findBlocks(fixed).length, 1, 'normalized to one');
  assert.ok(injector.hasValidInjection(fixed, V));
});

test('malformed block (open without close) is cleaned up', () => {
  const malformed = 'base\n// >>> Claude Code Nonstop (injected) v0.0.1 >>>\norphan();';
  const blocks = injector.findBlocks(malformed);
  assert.strictEqual(blocks.length, 1);
  assert.ok(blocks[0].malformed);
  const stripped = injector.stripAllBlocks(malformed);
  assert.ok(!stripped.includes('orphan()'), 'orphan body removed');
});

test('stripAllBlocks on content without our markers is a no-op', () => {
  const base = 'no markers here' + OTHER_BLOCK;
  assert.strictEqual(injector.stripAllBlocks(base), base);
});

console.log('\natomicWrite');
test('writeAtomic writes content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-'));
  const f = path.join(dir, 'a.js');
  writeAtomic(f, 'hello');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'hello');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeAndVerify returns true when content is intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-'));
  const f = path.join(dir, 'b.js');
  const ok = writeAndVerify(f, 'payload', (w) => w === 'payload');
  assert.strictEqual(ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeAndVerify returns false when verify never passes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-'));
  const f = path.join(dir, 'c.js');
  const ok = writeAndVerify(f, 'payload', () => false, { retries: 1, backoffMs: 1 });
  assert.strictEqual(ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('\nratelimit.parseUsage');
test('parses a healthy usage payload (not limited)', () => {
  const r = parseUsage(JSON.stringify({ five_hour: { utilization: 0.4, resets_at: 1893456000 } }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.limited, false);
  assert.strictEqual(r.utilization, 0.4);
  assert.ok(r.resetsAt > 0);
});

test('detects limited when utilization >= 1', () => {
  const r = parseUsage(JSON.stringify({ five_hour: { utilization: 1 }, retry_after: 0 }));
  assert.strictEqual(r.limited, true);
});

test('detects limited when retry_after present', () => {
  const r = parseUsage(JSON.stringify({ five_hour: { utilization: 0.5 }, retry_after: 120 }));
  assert.strictEqual(r.limited, true);
  assert.strictEqual(r.retryAfterMs, 120000);
});

test('error payload → ok false', () => {
  const r = parseUsage(JSON.stringify({ error: 'no token' }));
  assert.strictEqual(r.ok, false);
});

test('garbage → ok false (no throw)', () => {
  const r = parseUsage('not json');
  assert.strictEqual(r.ok, false);
});

test('resets_at in seconds and ISO string both parse to ms', () => {
  const sec = parseUsage(JSON.stringify({ five_hour: { utilization: 0.1, resets_at: 1893456000 } }));
  const iso = parseUsage(JSON.stringify({ five_hour: { utilization: 0.1, resets_at: '2030-01-01T00:00:00Z' } }));
  assert.ok(sec.resetsAt > 1e12, 'seconds scaled to ms');
  assert.ok(iso.resetsAt > 1e12, 'ISO parsed to ms');
});

console.log('\ntargets.versionFromDirName');
test('extracts version from a Claude Code dir name', () => {
  assert.strictEqual(versionFromDirName('anthropic.claude-code-2.1.161-win32-x64'), '2.1.161');
});

console.log('\n' + (failed === 0 ? 'ALL PASS' : 'FAILURES') + `: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
