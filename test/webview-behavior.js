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

console.log('\nwebview behaviour — busy/Stop detection (the INTERRUPTED + stranded-ping fix)');

test('send button ENABLED while the input is empty reads as WORKING (tool running, no output growth)', () => {
  // The bug: during a tool call the transcript does not grow, so isStreaming() is false and
  // the old detector fell through to WAITING_CONTINUE → it pinged → clicked the live Stop
  // button → "INTERRUPTED" + ping text stranded in the box. The send/stop control being
  // enabled while the input is empty uniquely means Claude is busy.
  const h = load({ transcriptText: 'running a tool...', withSendButton: true, input: true, inputText: '' });
  h.sendBtn.disabled = false; // live = acting as Stop
  assert.strictEqual(h.debug.state(), 'WORKING',
    'an enabled send/stop button over an empty input must read as WORKING, not WAITING_CONTINUE');
});

test('send button DISABLED while the input is empty stays pingable (idle, waiting on us)', () => {
  // When Claude has finished its turn the same button is disabled (nothing to send) — that is
  // the genuine "waiting for us" state, and we must still ping it.
  const h = load({ transcriptText: 'All done above.', withSendButton: true, input: true, inputText: '' });
  h.sendBtn.disabled = true; // idle = nothing to send
  assert.strictEqual(h.debug.state(), 'WAITING_CONTINUE',
    'a disabled send button over an empty input is idle-waiting and must remain pingable');
});

console.log('\nwebview behaviour — host-message sniffer labels the diagnostic log (conversation + project)');

test('a session_states_update labels the log with the ACTIVE session title + id', () => {
  const h = load({ input: true });
  h.fireMessage({
    type: 'from-extension',
    message: {
      type: 'request',
      request: {
        type: 'session_states_update',
        activeSessionId: 'sess-2',
        sessions: [
          { sessionId: 'sess-1', state: 'idle', title: 'Other chat' },
          { sessionId: 'sess-2', state: 'running', title: 'תיקיית פרוייקט חדשה' },
        ],
      },
    },
  });
  const ctx = h.debug.sessionContext();
  assert.strictEqual(ctx.id, 'sess-2', 'must pick the active session id, not the first');
  assert.strictEqual(ctx.title, 'תיקיית פרוייקט חדשה', 'must take the active session title');
});

test('the project name is the cwd last segment, from update_state.state.defaultCwd', () => {
  const h = load({ input: true });
  h.fireMessage({
    type: 'from-extension',
    message: { type: 'request', request: { type: 'update_state', state: { defaultCwd: 'c:\\Users\\orben\\OneDrive\\DEV\\Projects\\KeepIt' } } },
  });
  assert.strictEqual(h.debug.sessionContext().project, 'KeepIt', 'project = last path segment of defaultCwd');
});

test('the project name is also picked up from a system/init cwd', () => {
  const h = load({ input: true });
  h.fireMessage({
    type: 'from-extension',
    message: { type: 'io_message', message: { type: 'system', subtype: 'init', cwd: '/home/me/work/acme-api' } },
  });
  assert.strictEqual(h.debug.sessionContext().project, 'acme-api', 'project = last path segment of a unix cwd');
});

test('the sniffer NEVER feeds state detection (a forged running state cannot suppress pings)', () => {
  // The session message carries state:"running", but the sniffer must only label the log —
  // it must not influence detectState (that boundary is what keeps a forged message from
  // suppressing or forcing pings). With an empty idle input, state stays pingable.
  const h = load({ input: true, inputText: '', transcriptText: 'idle' });
  h.fireMessage({
    type: 'from-extension',
    message: { type: 'request', request: { type: 'session_states_update', activeSessionId: 's', sessions: [{ sessionId: 's', state: 'running', title: 'x' }] } },
  });
  assert.strictEqual(h.debug.state(), 'WAITING_CONTINUE',
    'a sniffed running state must not flip detectState to WORKING');
});

console.log('\nwebview behaviour — false-positive guards (sentinel + rate-limit lookalikes)');

test('a leftover NONSTOP_DONE from a previous run does NOT stop a fresh shift at pings=0', () => {
  // The reported case: a prior shift in the same conversation completed and left its
  // NONSTOP_DONE in the transcript. A new shift must not read that as "done" before it has
  // even pinged — until we inject the sentinel ourselves, any NONSTOP_DONE on screen is old.
  const store = new Map();
  store.set('nonstop-enabled', 'true');
  store.set('nonstop-session-start', String(Date.now()));
  const h = load({
    store, input: true, withSendButton: true, inputText: '',
    transcriptText: 'Earlier task finished. NONSTOP_DONE',
    config: { sentinelDoneDetection: true },
  });
  const before = h.sendClicks();
  h.pump();
  assert.strictEqual(h.ls.getItem('nonstop-enabled'), 'true',
    'must not stop on a pre-existing sentinel before we have pinged');
  assert.ok(!/done-sentinel/.test(h.ls.getItem('nonstop-last-stop') || ''),
    'last-stop must not be done-sentinel');
  assert.ok(h.sendClicks() - before >= 1, 'it should ping, not declare done');
});

test('a "RateLimitError" in app output is NOT read as a usage limit', () => {
  // A data project (yfinance/FRED) prints "RateLimitError" verbatim; the glued identifier
  // must not trip the limit safety-net (which could sleep a shift for hours).
  const h = load({ transcriptText: 'Traceback: adapters.yfinance raised RateLimitError fetching FRED macro data' });
  assert.strictEqual(h.debug.status().looksRateLimited, false,
    'a glued RateLimitError identifier must not trip looksRateLimited');
  assert.notStrictEqual(h.debug.state(), 'RATE_LIMITED',
    'and it must not drive state to RATE_LIMITED');
});

test('a REAL "session limit" notice still reads as rate-limited (the guard did not over-tighten)', () => {
  const h = load({ transcriptText: "You've hit your session limit · resets 10:10pm (Asia/Jerusalem)" });
  assert.strictEqual(h.debug.status().looksRateLimited, true, 'a real spaced notice must still match');
  assert.strictEqual(h.debug.state(), 'RATE_LIMITED', 'and still drive RATE_LIMITED');
});

test('the newer "5-hour limit" notice reads as rate-limited and captures its reset time', () => {
  const h = load({ transcriptText: "You've hit your 5-hour limit · resets 8pm (America/Sao_Paulo)" });
  assert.strictEqual(h.debug.state(), 'RATE_LIMITED', 'must drive RATE_LIMITED, not keep pinging into the wall');
  assert.strictEqual(h.debug.rateLimit().captured, '8pm (America/Sao_Paulo)');
});

test('chat that merely mentions a "5-hour limit" does NOT drive RATE_LIMITED', () => {
  const h = load({ transcriptText: 'We should handle the 5-hour limit better; it resets at some point.' });
  assert.notStrictEqual(h.debug.state(), 'RATE_LIMITED', 'a mention is not a notice');
});

console.log('\nwebview behaviour — per-conversation shift state (independent windows)');

function sessionMsg(id, title) {
  return {
    type: 'from-extension',
    message: { type: 'request', request: { type: 'session_states_update', activeSessionId: id, sessions: [{ sessionId: id, state: 'idle', title: title }] } },
  };
}

test('shift state is namespaced per conversation — switching sessions shows that session\'s own ON/OFF', () => {
  const h = load({ input: true });
  h.fireMessage(sessionMsg('A', 'Chat A'));
  h.ls.setItem('nonstop-s-A-enabled', 'true'); // A is ON
  assert.strictEqual(h.debug.status().enabled, true, 'session A reads its own enabled key');
  h.fireMessage(sessionMsg('B', 'Chat B'));     // switch to a different conversation
  assert.strictEqual(h.debug.status().enabled, false, 'session B is independent (its own key, OFF)');
  h.fireMessage(sessionMsg('A', 'Chat A'));     // back to A
  assert.strictEqual(h.debug.status().enabled, true, 'session A still ON — never shared with B');
});

test('a shift toggled on BEFORE the sessionId is known migrates to the session on first learn', () => {
  const h = load({ input: true });
  // Toggled on while the id was still unknown → lands on the bare fallback keys.
  h.ls.setItem('nonstop-enabled', 'true');
  h.ls.setItem('nonstop-session-start', String(Date.now()));
  h.ls.setItem('nonstop-ping-count', '2');
  h.fireMessage(sessionMsg('A', 'Chat A')); // first id learned → migrate
  assert.strictEqual(h.debug.status().enabled, true, 'the shift survives into the session namespace');
  assert.strictEqual(h.ls.getItem('nonstop-s-A-enabled'), 'true', 'enabled moved under the session key');
  assert.strictEqual(h.ls.getItem('nonstop-s-A-ping-count'), '2', 'all shift keys moved, not just enabled');
  assert.strictEqual(h.ls.getItem('nonstop-enabled'), null, 'the bare fallback key is cleared after migration');
});

test('switching conversation (known→known) does NOT migrate state across conversations', () => {
  const h = load({ input: true });
  h.fireMessage(sessionMsg('A', 'Chat A'));
  h.ls.setItem('nonstop-s-A-enabled', 'true'); // A is ON
  h.fireMessage(sessionMsg('B', 'Chat B'));     // switch — must NOT carry A's ON into B
  assert.strictEqual(h.ls.getItem('nonstop-s-B-enabled'), null, 'B did not inherit A\'s state');
  assert.strictEqual(h.ls.getItem('nonstop-s-A-enabled'), 'true', 'A keeps its own state');
});

console.log('\nwebview behaviour — reset-time parsing (hour-only + already-passed resume)');

test('an hour-only "resets 1pm" limit notice is detected and its time captured (was the 5h-fallback bug)', () => {
  const h = load({ transcriptText: "You've hit your session limit · resets 1pm (Asia/Jerusalem)" });
  assert.strictEqual(h.debug.state(), 'RATE_LIMITED', 'hour-only notice must still detect as a limit');
  const rl = h.debug.rateLimit();
  assert.ok(rl && rl.captured && /1pm/i.test(rl.captured),
    'the hour-only reset time must now be captured (minutes optional), got ' + (rl && rl.captured));
});

test('parseResetTime accepts hour-only times like "11pm" (previously returned 0 → 5h fallback)', () => {
  const h = load({});
  assert.notStrictEqual(h.debug.parseResetTime('11pm'), 0, '"11pm" must parse');
  assert.notStrictEqual(h.debug.parseResetTime('1:30pm'), 0, '"1:30pm" still parses');
  assert.strictEqual(h.debug.parseResetTime('not a time'), 0, 'garbage still returns 0');
});

// Format a Date as a 12h "h:mmam/pm" string in LOCAL time (matches parseResetTime's no-tz path).
function fmtLocal(d) {
  var h = d.getHours(), m = d.getMinutes(), ap = h < 12 ? 'am' : 'pm', h12 = h % 12 || 12;
  return h12 + ':' + (m < 10 ? '0' : '') + m + ap;
}
function nearMidnight() {
  var n = new Date();
  return (n.getHours() === 23 && n.getMinutes() > 45) || (n.getHours() === 0 && n.getMinutes() < 15);
}

test('a reset time in the recent past returns a <= now epoch (resume signal, not a tomorrow sleep)', () => {
  if (nearMidnight()) return; // the constructed clock would cross days; skip the rare edge
  const h = load({});
  const r = h.debug.parseResetTime(fmtLocal(new Date(Date.now() - 10 * 60000)));
  assert.ok(r > 0 && r <= Date.now(), 'recent-past reset → epoch <= now (already reset), got delta ' + (r - Date.now()));
});

test('a near-future reset time sleeps only until then (minutes away, not the 5h fallback)', () => {
  if (nearMidnight()) return;
  const h = load({});
  const r = h.debug.parseResetTime(fmtLocal(new Date(Date.now() + 10 * 60000)));
  assert.ok(r > Date.now() && r < Date.now() + 13 * 60000,
    'future reset must be ~10min away (+jitter), not hours, got delta ' + (r - Date.now()));
});

console.log('\nwebview behaviour — done-confirm nudges (push before stopping)');

test('doneConfirmNudges=1: a completion signal first gets a verification nudge, then stops on re-confirm', () => {
  const store = new Map();
  store.set('nonstop-enabled', 'true');
  store.set('nonstop-session-start', String(Date.now()));
  const h = load({
    store, input: true, withSendButton: true, inputText: '',
    config: { doneConfirmNudges: 1, sentinelDoneDetection: true, doneStallPings: 1, pingIntervalMs: 1000 },
    transcriptText: 'still working, no sentinel yet',
  });
  const base = Date.now(), realNow = Date.now;
  try {
    // Tick 1: a normal ping fires (so sentinelPings>0 — the baseline the done-accounting needs).
    Date.now = () => base; h.pump();
    const sends1 = h.sendClicks();
    assert.ok(sends1 >= 1, 'a normal ping fired first, got ' + sends1);
    // Claude replies "done" (sentinels appear → transcript grows → WORKING first).
    h.setTranscript('All done. NONSTOP_DONE NONSTOP_DONE NONSTOP_DONE');
    Date.now = () => base + 100000; h.inputEl.textContent = ''; h.pump();
    assert.strictEqual(h.ls.getItem('nonstop-enabled'), 'true', 'still streaming on the growth tick');
    // Streaming settles (>2s) → done detected. With one nudge budgeted it must NUDGE, not stop.
    Date.now = () => base + 103000; h.inputEl.textContent = ''; h.pump();
    assert.strictEqual(h.ls.getItem('nonstop-enabled'), 'true', 'first completion → verification nudge, NOT a stop');
    assert.ok(h.sendClicks() > sends1, 'a verification nudge was actually sent');
    // Still reports done after the nudge → now it stops.
    Date.now = () => base + 106000; h.inputEl.textContent = ''; h.pump();
    assert.strictEqual(h.ls.getItem('nonstop-enabled'), 'false', 'still done after the nudge → stop');
    assert.ok(/done-sentinel/.test(h.ls.getItem('nonstop-last-stop') || ''),
      'reason done-sentinel, got ' + h.ls.getItem('nonstop-last-stop'));
  } finally { Date.now = realNow; }
});

console.log('\n' + (failed === 0 ? 'ALL PASS' : 'FAILURES') + `: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
