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
const { detectRateLimit, parseResetTime } = require('../src/ratelimit/resetTime');
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

console.log('\nratelimit.resetTime — detection');
test('detects the real session-limit notice and captures the time', () => {
  const msg = "You've hit your session limit · resets 10:10pm (Asia/Jerusalem)";
  const r = detectRateLimit(msg);
  assert.ok(r && r.matched, 'should detect');
  assert.strictEqual(r.captured, '10:10pm (Asia/Jerusalem)');
});
test('detects a bare limit mention (no time) → captured null', () => {
  const r = detectRateLimit('Sorry, you have hit your usage limit for now.');
  assert.ok(r && r.matched);
  assert.strictEqual(r.captured, null);
});
test('normal conversation text is not a rate limit', () => {
  assert.strictEqual(detectRateLimit('Here is the function you asked for.'), null);
});
test('a bare "resets <time>" mention in chat does NOT flag a limit (false-positive guard)', () => {
  // Regression: discussing the feature ("...something like \"resets 10:10pm\"...") used to
  // self-trigger a silent multi-hour sleep. Only a canonical NOTICE may flag a limit.
  assert.strictEqual(detectRateLimit('if chat says something like "resets 10:10pm" it should be fine'), null);
  assert.strictEqual(detectRateLimit('the limit will reset at 9:40pm in my notes'), null);
});

console.log('\nratelimit.resetTime — parse (timezone-aware)');
test('resolves time in the reported IANA zone (independent of host TZ)', () => {
  const t = parseResetTime('10:10pm (Asia/Jerusalem)', Date.parse('2026-06-04T10:00:00Z'));
  assert.strictEqual(t, Date.parse('2026-06-04T19:10:00Z')); // 22:10 IDT = 19:10Z
});
test('same notice → same instant regardless of when in the day "now" is', () => {
  const a = parseResetTime('10:10pm (Asia/Jerusalem)', Date.parse('2026-06-04T05:00:00Z'));
  assert.strictEqual(a, Date.parse('2026-06-04T19:10:00Z'));
});
test('already-passed time today rolls to tomorrow (in the zone)', () => {
  // now = 20:00Z = 23:00 Jerusalem, past 22:10 → next is tomorrow.
  const t = parseResetTime('10:10pm (Asia/Jerusalem)', Date.parse('2026-06-04T20:00:00Z'));
  assert.strictEqual(t, Date.parse('2026-06-05T19:10:00Z'));
});
test('DST zone resolved correctly (America/New_York, summer = EDT)', () => {
  const t = parseResetTime('10:10pm (America/New_York)', Date.parse('2026-07-01T12:00:00Z'));
  assert.strictEqual(t, Date.parse('2026-07-02T02:10:00Z')); // 22:10 EDT = 02:10Z next day
});
test('DST spring-forward: real time exact; the non-existent gap time maps to an adjacent instant', () => {
  // Mar 8 2026: NY clocks jump 2:00 EST -> 3:00 EDT, so 2:00-3:00 local does not exist.
  const now = Date.parse('2026-03-08T05:30:00Z');
  // 3:30am exists (EDT) -> exact.
  assert.strictEqual(parseResetTime('3:30am (America/New_York)', now), Date.parse('2026-03-08T07:30:00Z'));
  // 2:30am is in the gap -> resolves to a real future instant (the EST side, 1:30am), never crashes.
  assert.strictEqual(parseResetTime('2:30am (America/New_York)', now), Date.parse('2026-03-08T06:30:00Z'));
});
test('DST fall-back: unambiguous time exact; the doubled hour picks the first occurrence', () => {
  // Nov 1 2026: NY clocks fall 2:00 EDT -> 1:00 EST, so 1:00-2:00 local happens twice.
  const now = Date.parse('2026-11-01T04:00:00Z');
  // 1:30am occurs twice -> first occurrence (EDT, 05:30Z).
  assert.strictEqual(parseResetTime('1:30am (America/New_York)', now), Date.parse('2026-11-01T05:30:00Z'));
  // 2:30am is unambiguous (EST) -> exact.
  assert.strictEqual(parseResetTime('2:30am (America/New_York)', now), Date.parse('2026-11-01T07:30:00Z'));
});
test('noon and midnight map correctly (Etc/UTC)', () => {
  assert.strictEqual(parseResetTime('12:00pm (Etc/UTC)', Date.parse('2026-06-04T05:00:00Z')),
    Date.parse('2026-06-04T12:00:00Z'));
  assert.strictEqual(parseResetTime('12:00am (Etc/UTC)', Date.parse('2026-06-04T05:00:00Z')),
    Date.parse('2026-06-05T00:00:00Z')); // 00:00 already passed at 05:00 → tomorrow
});
test('24-hour format without am/pm (Etc/UTC)', () => {
  assert.strictEqual(parseResetTime('15:30 (Etc/UTC)', Date.parse('2026-06-04T10:00:00Z')),
    Date.parse('2026-06-04T15:30:00Z'));
});
test('unparseable input → 0', () => {
  assert.strictEqual(parseResetTime('soon-ish', Date.now()), 0);
  assert.strictEqual(parseResetTime('', Date.now()), 0);
});

console.log('\nwebview parity (drift guard)');
test('webview embeds the canonical primary rate-limit regex', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'webview', 'nonstop.js'), 'utf8');
  assert.ok(src.indexOf('hit your (?:session|usage|rate) limit') !== -1,
    'webview/nonstop.js must keep the primary regex in sync with src/ratelimit/resetTime.js');
});

console.log('\nwebview popup handling (structure guard)');
const NS = fs.readFileSync(path.join(__dirname, '..', 'webview', 'nonstop.js'), 'utf8');
test('keeps the live-verified popup root selector (shared by permission + decision)', () => {
  assert.ok(NS.indexOf('permissionRequestContainer_') !== -1,
    'popupRoot must target the verified permissionRequestContainer_ class');
});
test('disambiguates a decision popup by its role="radio" options', () => {
  assert.ok(NS.indexOf('decisionHints') !== -1 && NS.indexOf('[role="radio"]') !== -1,
    'decision popups are identified by role="radio" inside the popup root');
});
test('detectPopup classifies PERMISSION vs DECISION', () => {
  assert.ok(/function detectPopup\b/.test(NS), 'detectPopup() must exist');
  assert.ok(NS.indexOf("'DECISION'") !== -1 && NS.indexOf("'PERMISSION'") !== -1,
    'detectPopup returns DECISION / PERMISSION');
});
test('detectState emits the two new popup states', () => {
  assert.ok(NS.indexOf("'WAITING_PERMISSION'") !== -1, 'WAITING_PERMISSION state present');
  assert.ok(NS.indexOf("'WAITING_DECISION'") !== -1, 'WAITING_DECISION state present');
});
test('permission handling has a grace window and approve/defer/stop modes', () => {
  assert.ok(NS.indexOf('permissionGraceMs') !== -1, 'grace window config present');
  assert.ok(/onPermission/.test(NS), 'onPermission config present');
  assert.ok(NS.indexOf('approvePermission') !== -1, 'auto-approve path present');
});
test('config defaults are conservative (defer permissions, stop on decisions)', () => {
  // The seed DEFAULTS object should not auto-act without opt-in.
  assert.ok(/onPermission:\s*'defer'/.test(NS), "onPermission defaults to 'defer'");
  assert.ok(/onDecision:\s*'stop'/.test(NS), "onDecision defaults to 'stop'");
});
test('waiting_input with no popup still nudges (not a false question-stop)', () => {
  assert.ok(/waiting_input[\s\S]{0,120}WAITING_CONTINUE/.test(NS),
    'a postMessage waiting_input without a popup must map to WAITING_CONTINUE');
});

console.log('\n' + (failed === 0 ? 'ALL PASS' : 'FAILURES') + `: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
