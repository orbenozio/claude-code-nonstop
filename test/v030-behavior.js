'use strict';

/*
 * BEHAVIOURAL tests authored for the v0.3.0 reviewer-pass hardening.
 *
 * Covers the v0.3.0 behaviours that previously had no executing test:
 *   1. lastMatch last-wins        — detectRateLimit takes the FRESHEST (bottom-most)
 *                                    notice in the tail, not the first (host module +
 *                                    the webview copy, which must agree).
 *   2. s: signature normalisation — a fixed-window limit notice (no reset time) keys on a
 *                                    letters-only signature that is STABLE across the
 *                                    digit/punctuation drift a scrolling transcript causes.
 *   3. inputIsForeign reload      — LS.lastPing persists the exact ping text so a reloaded
 *                                    panel still recognises its own stuck ping as ours.
 *   4. stall-retry / backoff      — a transient stall retries the resume maxStallRetries
 *                                    times before stopping; a done sentinel and the
 *                                    maxRuntime/maxPings backstops still override it.
 *
 * Host-side cases require() the pure module directly. Webview-side cases execute the real
 * webview source in the DOM sandbox (test/webview-harness.js). TESTS ONLY — no production
 * code is touched.
 *
 * Run: node test/v030-behavior.js   (wired into npm test).
 */

const assert = require('assert');
const { detectRateLimit } = require('../src/ratelimit/resetTime');
const { load } = require('./webview-harness');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '\n        ', e.message); }
}

const NOTICE = (t) => "You've hit your session limit · resets " + t + ' (Asia/Jerusalem)';

// ── 1. lastMatch last-wins ──────────────────────────────────────────────────────
console.log('\nv0.3.0 — detectRateLimit takes the FRESHEST notice (host module)');

test('two notices in the tail → the LATER (bottom-most) reset time is captured', () => {
  const text = [NOTICE('9:00am'), '...conversation continues...', NOTICE('11:30pm')].join('\n');
  const r = detectRateLimit(text);
  assert.ok(r && r.matched, 'must detect a limit');
  assert.strictEqual(r.captured, '11:30pm (Asia/Jerusalem)',
    'must capture the bottom-most (freshest) time, NOT the first — taking the first is the ~24h re-sleep bug');
});

test('three ascending notices → the last wins', () => {
  const text = [NOTICE('1:00am'), NOTICE('2:00pm'), NOTICE('10:45pm')].join('\n');
  assert.strictEqual(detectRateLimit(text).captured, '10:45pm (Asia/Jerusalem)');
});

test('a single notice is unchanged (no regression for the common case)', () => {
  assert.strictEqual(detectRateLimit(NOTICE('10:10pm')).captured, '10:10pm (Asia/Jerusalem)');
});

test('lastMatch keeps the case-insensitive flag (UPPERCASE notice still detected)', () => {
  // If lastMatch dropped the original `i` flag when adding `g`, an uppercase notice would
  // stop matching. Two uppercase notices → still finds the freshest.
  const text = [NOTICE('9:00am').toUpperCase(), NOTICE('11:30pm').toUpperCase()].join('\n');
  const r = detectRateLimit(text);
  assert.ok(r && r.matched, 'uppercase notice must still match (i flag preserved through the g-flag rewrite)');
  assert.ok(/11:30/i.test(r.captured || ''), 'freshest uppercase time captured: ' + r.captured);
});

test('a noticeless 4000-char tail returns null without hanging (zero-width / no-match safety)', () => {
  // Drives lastMatch over a long string with no match — must terminate, not loop.
  const r = detectRateLimit('x'.repeat(8000));
  assert.strictEqual(r, null);
});

// ── 2. s: signature normalisation stability ─────────────────────────────────────
console.log('\nv0.3.0 — fixed-window signature is stable across transcript scroll drift');

function sig(transcriptText, atOffsetMs) {
  const h = load({ transcriptText });
  if (atOffsetMs) {
    const realNow = Date.now; Date.now = () => realNow() + atOffsetMs;
    try { return h.debug.status().rlSignature; } finally { Date.now = realNow; }
  }
  return h.debug.status().rlSignature;
}

test('a fixed-window notice (no reset time) yields an s: signature, not t:', () => {
  const s = sig('You have reached your usage limit. Please try again later.');
  assert.ok(s && s.indexOf('s:') === 0, 'expected an s: signature, got ' + JSON.stringify(s));
});

test('leading counters / timestamps changing on scroll do NOT change the s: signature', () => {
  // The raw-80-char snippet (old behaviour) shifted as line numbers / timestamps scrolled
  // past, mutating the signature and reviving the ~24h re-sleep bug. The letters-only
  // normalisation must absorb that digit/punctuation drift.
  const phrase = 'You have reached your usage limit';
  const a = sig('14:32  ' + phrase + ' ......');                 // one set of digits/punct
  const b = sig('[09:07:51]  >> ' + phrase + ' !!!', 1000);      // different digits/punct
  assert.ok(a && b, 'both signatures present');
  assert.strictEqual(a, b,
    'signature must be identical across digit/punctuation drift (a=' + a + ' b=' + b + ')');
});

test('the same fixed-window notice → byte-stable signature on a later read (sleep→wake)', () => {
  const txt = 'Heads up: you have reached your usage limit for now.';
  assert.strictEqual(sig(txt), sig(txt, 60000),
    'identical transcript must give an identical signature regardless of when "now" is read');
});

// ── 3. inputIsForeign reload persistence ────────────────────────────────────────
console.log('\nv0.3.0 — LS.lastPing persists the ping text across a reload');

function pingOnce(store) {
  // Enable a shift, claim ownership, wake, and pump until a single ping has been sent.
  const h = load({ store, input: true, withSendButton: true, inputText: '', transcriptText: 'Prior output.' });
  h.debug.simulateRateLimit(1);
  h.ls.setItem('nonstop-sleep-until', String(Date.now() - 1000));
  for (let i = 0; i < 3; i++) h.pump();
  return h;
}

test('a successful ping persists its exact text to LS.lastPing', () => {
  const h = pingOnce(new Map());
  const persisted = h.ls.getItem('nonstop-last-ping');
  assert.ok(persisted && persisted.indexOf('continue') === 0,
    'LS.lastPing must hold the ping text after a send, got ' + JSON.stringify(persisted));
  assert.strictEqual(h.inputEl.textContent, persisted,
    'the stuck ping in the box must equal the persisted text (so inputIsForeign can match it on reload)');
});

test('LS.lastPing survives a panel reload (shared store, fresh closure)', () => {
  const store = new Map();
  const h1 = pingOnce(store);
  const ping = h1.ls.getItem('nonstop-last-ping');
  assert.ok(ping, 'precondition: ping persisted');

  // Instance 2 = RELOAD: same localStorage Map, brand-new closure (lastInsertedText resets
  // to '' just like a real reload). The persisted ping must still be there for inputIsForeign.
  const h2 = load({ store, input: true, withSendButton: true, inputText: ping, transcriptText: 'out' });
  assert.strictEqual(h2.ls.getItem('nonstop-last-ping'), ping,
    'the persisted ping must outlive the reload so the new instance recognises its own stuck ping');
  assert.strictEqual(h2.inputEl.textContent, h2.ls.getItem('nonstop-last-ping'),
    'on reload the box text matches the persisted ping → recognised as OURS, not a user draft');
});

// ── 3b. End-to-end: a reloaded panel recognises AND resends its own stuck ping ────
console.log('\nv0.3.0 — a stuck ping (ours, post-reload) routes to WAITING_CONTINUE and is resent');

test('a stuck ping in the box (recognised via LS.lastPing) routes to WAITING_CONTINUE, not UNKNOWN', () => {
  // detectState Layer 4 returns WAITING_CONTINUE when the input holds nothing FOREIGN — empty,
  // or only our own stranded ping. LS.lastPing makes that not-foreign check survive a reload,
  // so the resume path becomes reachable instead of dead-ending at UNKNOWN.
  const store = new Map();
  store.set('nonstop-enabled', 'true');
  store.set('nonstop-session-start', String(Date.now()));
  store.set('nonstop-last-ping', 'continue - reply NONSTOP_DONE when fully done');
  const h = load({
    store, input: true, withSendButton: true,
    inputText: 'continue - reply NONSTOP_DONE when fully done',
    transcriptText: 'Prior output that has not grown.',
  });
  assert.strictEqual(h.debug.state(), 'WAITING_CONTINUE',
    'our own stuck ping must read as WAITING_CONTINUE (not-foreign), so the resend path is reachable');
});

test('the stranded ping is actually cleared and resent (end-to-end resume after reload)', () => {
  const store = new Map();
  store.set('nonstop-enabled', 'true');
  store.set('nonstop-session-start', String(Date.now()));
  store.set('nonstop-last-ping', 'continue - reply NONSTOP_DONE when fully done');
  const h = load({
    store, input: true, withSendButton: true,
    inputText: 'continue - reply NONSTOP_DONE when fully done',
    transcriptText: 'Prior output that has not grown.',
  });
  const before = h.sendClicks();
  // lastPingAt starts at 0 so the first eligible tick resends immediately.
  h.pump();
  assert.ok(h.sendClicks() - before >= 1,
    'a resend must fire for our own stuck ping after reload — the persistence fix + routing close the loop');
});

test('a FOREIGN user draft in the box is still UNKNOWN and never resent/cleared', () => {
  // The flip side: the routing must not touch a real user draft. A foreign string in the box
  // (not equal to LS.lastPing) must stay UNKNOWN, and setInputAndSend's pre-clear guard means
  // no send fires — the v0.2.6 draft-protection invariant must hold under the new routing.
  const store = new Map();
  store.set('nonstop-enabled', 'true');
  store.set('nonstop-session-start', String(Date.now()));
  store.set('nonstop-last-ping', 'continue - reply NONSTOP_DONE when fully done');
  const h = load({
    store, input: true, withSendButton: true,
    inputText: 'wait, let me ask something else entirely',
    transcriptText: 'Prior output.',
  });
  const before = h.sendClicks();
  for (let i = 0; i < 4; i++) h.pump();
  assert.strictEqual(h.debug.state(), 'UNKNOWN', 'a foreign draft must NOT route to WAITING_CONTINUE');
  assert.strictEqual(h.sendClicks() - before, 0, 'a foreign user draft is never cleared or sent');
});

// ── 4. stall-retry / backoff budget ─────────────────────────────────────────────
console.log('\nv0.3.0 — stall-retry budget (retries, then stop; sentinel + backstops still win)');

// Drive a hard stall: empty input each tick (so state stays WAITING_CONTINUE), output that
// never grows, time jumped far past any backoff so every tick is eligible to ping. Returns
// {stopped, pings, reason} once the shift ends (or after a generous step budget).
function runStall(maxStallRetries, extraCfg) {
  const store = new Map();
  const h = load({
    store, input: true, withSendButton: true, inputText: '',
    config: Object.assign({ maxStallRetries, pingIntervalMs: 15000, doneStallPings: 1 }, extraCfg || {}),
    transcriptText: 'Frozen output that never grows.',
  });
  h.debug.simulateRateLimit(1);
  h.ls.setItem('nonstop-sleep-until', String(Date.now() - 1000));
  const base = Date.now(), realNow = Date.now;
  try {
    for (let step = 0; step < 40; step++) {
      // Jump well past the 15-min backoff cap so the ping is always eligible, and keep the
      // input empty so the state machine stays in WAITING_CONTINUE.
      Date.now = () => base + step * 1000000;
      h.inputEl.textContent = '';
      h.pump();
      if (h.ls.getItem('nonstop-enabled') === 'false') break;
    }
  } finally { Date.now = realNow; }
  return {
    stopped: h.ls.getItem('nonstop-enabled') === 'false',
    pings: parseInt(h.ls.getItem('nonstop-ping-count') || '0', 10),
    reason: h.ls.getItem('nonstop-last-stop') || '',
  };
}

test('maxStallRetries=0 stops at the first stall (old behaviour: 1 ping then output-stall)', () => {
  const r = runStall(0);
  assert.ok(r.stopped, 'shift must stop');
  assert.ok(/output-stall/.test(r.reason), 'reason output-stall, got ' + r.reason);
  assert.strictEqual(r.pings, 1, 'exactly one ping (no retries) before stopping');
});

test('maxStallRetries=4 retries the resume 4 more times before stopping (1 + 4 = 5 pings)', () => {
  const r = runStall(4);
  assert.ok(r.stopped, 'shift must eventually stop');
  assert.ok(/output-stall/.test(r.reason), 'reason output-stall, got ' + r.reason);
  assert.strictEqual(r.pings, 5, 'one initial ping + four retries before giving up, got ' + r.pings);
});

test('the stall loop ALWAYS terminates (cannot spin forever) even with a large budget', () => {
  const r = runStall(20);
  assert.ok(r.stopped, 'a frozen output must still reach output-stall and stop, not loop forever');
  assert.strictEqual(r.pings, 21, 'one initial ping + twenty retries, got ' + r.pings);
});

test('maxRuntime backstop overrides stall-retries (stops mid-retry on runtime)', () => {
  // Even with a huge retry budget, an exceeded maxRuntime stops the shift on the next tick.
  const store = new Map();
  const h = load({
    store, input: true, withSendButton: true, inputText: '',
    config: { maxStallRetries: 99, pingIntervalMs: 15000, doneStallPings: 1, maxRuntimeMs: 1 },
    transcriptText: 'frozen',
  });
  h.debug.simulateRateLimit(1);
  h.ls.setItem('nonstop-sleep-until', String(Date.now() - 1000));
  h.ls.setItem('nonstop-session-start', String(Date.now() - 100000)); // 100s of runtime > 1ms cap
  h.pump();
  assert.strictEqual(h.ls.getItem('nonstop-enabled'), 'false', 'maxRuntime must stop the shift');
  assert.ok(/maxRuntime/.test(h.ls.getItem('nonstop-last-stop') || ''),
    'reason maxRuntime, got ' + h.ls.getItem('nonstop-last-stop'));
});

test('a done sentinel stops immediately, even with retries remaining', () => {
  // After a ping, Claude actually replies with the completion sentinel. Once streaming
  // settles (>2s of no growth), sawDoneSentinel must stop the shift on the next tick — the
  // stall-retry budget must NOT keep an actually-finished shift alive.
  const store = new Map();
  const h = load({
    store, input: true, withSendButton: true, inputText: '',
    config: { maxStallRetries: 10, pingIntervalMs: 15000, doneStallPings: 1, sentinelDoneDetection: true },
    transcriptText: 'working',
  });
  h.debug.simulateRateLimit(1);
  const base = Date.now(), realNow = Date.now;
  try {
    h.ls.setItem('nonstop-sleep-until', String(Date.now() - 1000));
    Date.now = () => base + 1000000; h.inputEl.textContent = ''; h.pump(); // first ping
    // Claude replies with completion sentinels (transcript grows → counts as streaming first).
    h.setTranscript('All done. NONSTOP_DONE NONSTOP_DONE NONSTOP_DONE');
    Date.now = () => base + 1000000; h.inputEl.textContent = ''; h.pump(); // WORKING (just grew)
    assert.strictEqual(h.ls.getItem('nonstop-enabled'), 'true', 'still streaming on the growth tick');
    // Let streaming settle (>2s since growth), then the sentinel stops it.
    Date.now = () => base + 1000000 + 3000; h.inputEl.textContent = ''; h.pump();
  } finally { Date.now = realNow; }
  assert.strictEqual(h.ls.getItem('nonstop-enabled'), 'false', 'sentinel must stop the shift');
  assert.ok(/done-sentinel/.test(h.ls.getItem('nonstop-last-stop') || ''),
    'reason done-sentinel, got ' + h.ls.getItem('nonstop-last-stop'));
});

console.log('\n' + (failed === 0 ? 'ALL PASS' : 'FAILURES') + `: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
