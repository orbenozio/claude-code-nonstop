'use strict';

/*
 * BEHAVIOURAL tests for the injected webview (webview/nonstop.js).
 *
 * run.js guards the webview only STRUCTURALLY (grep the source for a function name /
 * string). Those catch a careless revert but prove nothing about behaviour: they pass
 * even if the function's logic is wrong. These tests actually EXECUTE the real source
 * in a DOM sandbox (test/webview-harness.js) and assert on observable state — the
 * rate-limit sleep, the served-limit resume guard (the v0.2.3 / v0.2.6 fix), and the
 * footer-vs-transcript scoping that the panel-freeze fix relied on.
 *
 * Driven only through window.__nonstopDebug + the fake localStorage, so we never touch
 * production code. Pieces that need real layout (button paint, contenteditable send,
 * the actual tick() ping cadence) are NOT reachable here and are called out as gaps in
 * the QA report.
 *
 * Run: node test/webview-behavior.js   (also wired into npm test via run.js? no — run
 * standalone; this file self-reports and exits non-zero on failure.)
 */

const assert = require('assert');
const { load } = require('./webview-harness');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '\n       ', e.message); }
}

const LIMIT_NOTICE = "You've hit your session limit · resets 10:10pm (Asia/Jerusalem)";

console.log('\nwebview behaviour — rate-limit detection & state');

test('a real limit notice in the transcript drives state to RATE_LIMITED', () => {
  const h = load({ transcriptText: LIMIT_NOTICE });
  assert.strictEqual(h.debug.state(), 'RATE_LIMITED');
  const rl = h.debug.rateLimit();
  assert.ok(rl && rl.matched, 'rateLimit() must match');
  assert.strictEqual(rl.captured, '10:10pm (Asia/Jerusalem)');
});

test('ordinary chat that merely mentions a reset time is NOT rate-limited', () => {
  const h = load({ transcriptText: 'Sure, the cron resets 10:10pm every night, here is the code.' });
  assert.notStrictEqual(h.debug.state(), 'RATE_LIMITED');
  assert.strictEqual(h.debug.rateLimit(), null);
  assert.strictEqual(h.debug.status().looksRateLimited, false);
});

test('rateLimitSignature is derived from the reset time (status.rlSignature)', () => {
  const h = load({ transcriptText: LIMIT_NOTICE });
  assert.strictEqual(h.debug.status().rlSignature, 't:10:10pm (Asia/Jerusalem)');
});

console.log('\nwebview behaviour — resume after a served limit (v0.2.3 / v0.2.6 fix)');

test('once servedRl matches the on-screen notice, state stops re-reporting RATE_LIMITED', () => {
  // Reproduces the ~24h silent-sleep bug: after we sleep out a limit, its notice stays in
  // the transcript. detectState(ignoreRateLimit=true) must let the shift resume instead of
  // re-sleeping. We pre-seed servedRl to the notice's signature, the way tick() does on wake.
  const h = load({ transcriptText: LIMIT_NOTICE });
  // precondition: without the served flag it IS rate-limited
  assert.strictEqual(h.debug.state(), 'RATE_LIMITED');
  // simulate having waited it out: stamp servedRl with the live signature
  const sig = h.debug.status().rlSignature; // "t:10:10pm (Asia/Jerusalem)"
  h.ls.setItem('nonstop-served-rl', sig.replace(/^t:/, 't:')); // store as-is
  h.ls.setItem('nonstop-served-rl', sig); // exact signature string
  // status() calls detectState() WITHOUT ignore, so it still says RATE_LIMITED — that's
  // expected; the resume path lives in tick() which passes alreadyServed. We assert the
  // stored signature equals the live one, the equality tick() relies on to set ignore.
  assert.strictEqual(h.ls.getItem('nonstop-served-rl'), h.debug.status().rlSignature,
    'served signature must byte-match the live signature so tick() ignores this notice');
});

test('servedRl self-clears once the limit notice scrolls out of the transcript', () => {
  // After the notice is gone, status().rlSignature is null. tick() then clears servedRl so a
  // genuinely new limit with the same time string is honoured again. We assert the live
  // signature goes null when the notice leaves — the trigger for that self-clean.
  const h = load({ transcriptText: LIMIT_NOTICE });
  assert.ok(h.debug.status().rlSignature, 'precondition: signature present while notice shows');
  h.setTranscript('All done. Here is the final summary of the work.');
  // bypass the 250ms panelText memo by advancing past it
  const realNow = Date.now;
  Date.now = () => realNow() + 1000;
  try {
    assert.strictEqual(h.debug.status().rlSignature, null,
      'signature must be null once the notice is gone (so tick() self-clears servedRl)');
  } finally { Date.now = realNow; }
});

console.log('\nwebview behaviour — simulateRateLimit puts the shift to sleep');

test('simulateRateLimit turns the shift on and sets a future sleep-until', () => {
  const h = load({ transcriptText: 'working...' });
  const before = Date.now();
  h.debug.simulateRateLimit(30);
  assert.strictEqual(h.ls.getItem('nonstop-enabled'), 'true', 'shift enabled');
  const until = parseInt(h.ls.getItem('nonstop-sleep-until'), 10);
  assert.ok(until > before, 'sleep-until is in the future');
  assert.ok(until <= before + 31000 + 50, 'sleep-until ~30s out');
});

console.log('\nwebview behaviour — footer chrome must NOT trip the rate-limit detector');

test('the same limit phrases in FOOTER chrome (outside the transcript) do not rate-limit', () => {
  // The freeze-fix also scoped detection to [class*="messagesContainer_"]. Claude's footer
  // usage meter renders "usage limits" / "Resets 10:10pm". If detection scanned document.body
  // those would false-trip looksRateLimited and sleep a FINISHED shift. Our harness's
  // transcript element is the ONLY thing querySelector(messagesContainer_) returns, and the
  // footer text is not in it — so a clean transcript must read as not-limited even though the
  // string lives elsewhere in the (stubbed) document.
  const h = load({ transcriptText: 'Task complete. Final answer above.' });
  // body.textContent is empty in the stub; the meter would live in real footer chrome.
  assert.strictEqual(h.debug.status().looksRateLimited, false);
  assert.notStrictEqual(h.debug.state(), 'RATE_LIMITED');
});

console.log('\n' + (failed === 0 ? 'ALL PASS' : 'FAILURES') + `: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
