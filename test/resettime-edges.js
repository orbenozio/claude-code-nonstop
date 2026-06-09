'use strict';

/*
 * Edge-case coverage for src/ratelimit/resetTime.js that run.js does not exercise.
 * resetTime.js is the tested spec of the rate-limit parsing the webview re-embeds, so
 * these gaps matter: a wrong reset time means sleeping to the wrong instant (and, per
 * SPEC §5.4, never pinging into a wall — but also resuming on time).
 *
 * Run: node test/resettime-edges.js
 */

const assert = require('assert');
const { detectRateLimit, parseResetTime } = require('../src/ratelimit/resetTime');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '\n       ', e.message); }
}

const NOW = Date.parse('2026-06-04T10:00:00Z'); // 13:00 Asia/Jerusalem (IDT)

console.log('\nresetTime — detection edges');

test('detection is case-insensitive (uppercase notice still flags)', () => {
  const r = detectRateLimit('YOU HAVE HIT YOUR USAGE LIMIT, RESETS 9:00PM');
  assert.ok(r && r.matched);
  assert.strictEqual(r.captured, '9:00PM');
});

test('a notice whose reset time is beyond the 80-char window still flags (time via loose extractor)', () => {
  // The primary regex only reaches `resets <time>` within 80 chars; past that, the 3rd
  // bare-limit regex still flags and the loose extractor pulls the time from the tail.
  const r = detectRateLimit('hit your session limit' + 'x'.repeat(120) + ' resets 9:00pm');
  assert.ok(r && r.matched, 'must still flag a real limit');
  assert.strictEqual(r.captured, '9:00pm', 'time recovered by the loose extractor');
});

test('"N-hour limit reached" flags with no inline time (captured null)', () => {
  const r = detectRateLimit('You have reached your 5-hour limit reached');
  assert.ok(r && r.matched);
  assert.strictEqual(r.captured, null);
});

test('with two notices in the tail, the LATEST (freshest, bottom-most) time is captured', () => {
  // In a real transcript the freshest notice is at the BOTTOM, so the latest reset time is
  // the right one to sleep to — an earlier notice may carry an already-past time. detectRateLimit
  // now takes the last match in the -4000 tail, so the later "9:00pm" wins over "8:00pm".
  const r = detectRateLimit('hit your usage limit resets 8:00pm — later — hit your session limit resets 9:00pm');
  assert.strictEqual(r.captured, '9:00pm', 'freshest (latest) notice in the tail wins');
});

console.log('\nresetTime — parse edges');

test('24-hour time WITH an IANA zone resolves in that zone', () => {
  const t = parseResetTime('23:30 (Asia/Jerusalem)', NOW);
  assert.strictEqual(t, Date.parse('2026-06-04T20:30:00Z')); // 23:30 IDT = 20:30Z
});

test('space and uppercase AM/PM parse', () => {
  assert.ok(parseResetTime('3:30 PM', NOW) > NOW);
  assert.ok(parseResetTime('3:30 AM', NOW) > NOW);
});

test('an unknown/invalid IANA zone falls back to local time (no crash, returns a future time)', () => {
  const t = parseResetTime('10:10pm (Mars/Phobos)', NOW);
  assert.ok(t > NOW, 'graceful fallback to local, not 0/crash');
});

test('null / empty / non-time inputs return 0 (never throw, never sleep on garbage)', () => {
  assert.strictEqual(parseResetTime(null, NOW), 0);
  assert.strictEqual(parseResetTime('', NOW), 0);
  assert.strictEqual(parseResetTime('tomorrow morning', NOW), 0);
});

test('OBSERVATION: out-of-range fields (25:00, :70) are NOT rejected — they roll over', () => {
  // Date.UTC/local normalises 25:00 → +1h next day and :70 → +10min. These strings never
  // appear in a real Claude notice, so this is benign, but it means parseResetTime is not a
  // validator: a malformed capture yields a plausible-looking (wrong) time, not 0.
  assert.ok(parseResetTime('25:00 (Etc/UTC)', NOW) > NOW, '25:00 rolls over instead of rejecting');
  assert.ok(parseResetTime('10:70pm (Etc/UTC)', NOW) > NOW, ':70 rolls over instead of rejecting');
});

console.log('\n' + (failed === 0 ? 'ALL PASS' : 'FAILURES') + `: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
