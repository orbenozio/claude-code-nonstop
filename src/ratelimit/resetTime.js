'use strict';

/**
 * Canonical, DOM-free implementation of rate-limit detection + reset-time parsing.
 *
 * The injected webview (webview/nonstop.js) runs in a separate context and can't
 * require() this module, so it carries an equivalent inline copy. This file is the
 * tested specification of that logic; a guard test in test/run.js asserts the
 * primary regex is still embedded in the webview so the two don't silently drift.
 *
 * Real notice seen live: "You've hit your session limit · resets 10:10pm (Asia/Jerusalem)".
 */

// Time-capturing patterns first — their group (m[1]) feeds parseResetTime; the bare
// detector last just flags a limit so the caller sleeps on a fallback window.
const RATE_LIMIT_REGEXES = [
  /hit your (?:session|usage|rate) limit[\s\S]{0,80}?resets?\s+(\d{1,2}:\d{2}\s*[ap]m\b(?:\s*\([^)]+\))?)/i,
  /\bresets?\s+(?:at\s+)?(\d{1,2}:\d{2}\s*[ap]m\b(?:\s*\([^)]+\))?)/i,
  /limit will reset at\s+([^\n]+)/i,
  /\b\d+\s*-?\s*hour limit reached/i,
  /(?:hit|reached)[^\n]{0,30}\b(?:session|usage|rate) limit/i,
];

/** Scan text for a rate-limit notice. Returns { matched, captured } or null. */
function detectRateLimit(text) {
  if (!text) return null;
  const tail = String(text).slice(-4000);
  for (let i = 0; i < RATE_LIMIT_REGEXES.length; i++) {
    const m = tail.match(RATE_LIMIT_REGEXES[i]);
    if (m) return { matched: true, captured: m[1] || null };
  }
  return null;
}

function isValidTimeZone(tz) {
  try { Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}

/** Offset (ms) between a tz's wall-clock reading of `epoch` and real UTC. */
function zoneOffsetMs(epoch, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  dtf.formatToParts(new Date(epoch)).forEach((x) => { p[x.type] = x.value; });
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === '24' ? 0 : p.hour), +p.minute, +p.second);
  return asUTC - epoch;
}

/** Epoch for the next occurrence of HH:MM in `tz` (today there, else tomorrow). */
function nextTimeInZone(h, min, tz, now) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = {};
  dtf.formatToParts(new Date(now)).forEach((x) => { p[x.type] = x.value; });
  for (let addDay = 0; addDay <= 1; addDay++) {
    const guess = Date.UTC(+p.year, +p.month - 1, +p.day + addDay, h, min, 0);
    let epoch = guess - zoneOffsetMs(guess, tz);
    epoch = guess - zoneOffsetMs(epoch, tz); // refine once for DST boundaries
    if (epoch > now) return epoch;
  }
  return 0;
}

function nextLocalTime(h, min, now) {
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * Parse a human reset time ("10:10pm (Asia/Jerusalem)" / "3:30 PM" / "15:30") into
 * a precise future timestamp (no jitter). With an IANA "(Zone)" the time is resolved
 * IN that zone (correct worldwide); otherwise it's read as local. Returns 0 if
 * unparseable. `now` is injectable for deterministic tests.
 */
function parseResetTime(str, now) {
  if (!str) return 0;
  if (now == null) now = Date.now();
  const s = String(str);
  const m = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) return 0;
  let h = +m[1], min = +m[2];
  if (m[3]) { const pm = /pm/i.test(m[3]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
  let tz = null;
  const tzm = s.match(/\(([A-Za-z]+(?:\/[A-Za-z0-9_+\-]+)+)\)/);
  if (tzm && isValidTimeZone(tzm[1])) tz = tzm[1];
  return tz ? nextTimeInZone(h, min, tz, now) : nextLocalTime(h, min, now);
}

module.exports = { RATE_LIMIT_REGEXES, detectRateLimit, parseResetTime, isValidTimeZone };
