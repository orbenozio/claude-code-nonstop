'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Atomic file write: write to a temp file in the same directory, then rename over
 * the target. Rename is atomic on the same filesystem, so a concurrent reader
 * never sees a half-written file. Mitigates the write race with another extension
 * editing the same file (SPEC.md §6.4 / §7.2).
 */
// Sleep synchronously for `ms` WITHOUT a CPU-spinning busy-wait. Atomics.wait parks the
// thread on a futex that never gets notified, so it yields the core instead of pegging it
// at 100%. The wait only happens on the RARE retry path (another writer clobbered us),
// capped at a few hundred ms total — the common path verifies on the first try and never
// sleeps — so briefly parking here is acceptable and far cheaper than spinning.
function sleepSync(ms) {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    // SharedArrayBuffer unavailable (shouldn't happen on modern Node) — degrade to a
    // bounded spin rather than crash.
    const until = Date.now() + ms;
    while (Date.now() < until) { /* bounded fallback */ }
  }
}

function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  // pid + time + random so two writes in the same ms (focus + config change) can't collide
  // on the temp name and clobber each other before the rename.
  const tmp = path.join(dir, `.nonstop-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    // Clean up the temp file if rename failed.
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw e;
  }
}

/**
 * Write atomically, then re-read and verify our content survived (i.e. another
 * writer didn't clobber us between rename and now). Retries with backoff.
 *
 * @param {string} filePath
 * @param {string} content
 * @param {(written: string) => boolean} verify  return true if the write is intact
 * @param {{retries?: number, backoffMs?: number}} [opts]
 * @returns {boolean} true if verified intact
 */
function writeAndVerify(filePath, content, verify, opts = {}) {
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 50;
  for (let attempt = 0; attempt <= retries; attempt++) {
    writeAtomic(filePath, content);
    let readBack;
    try {
      readBack = fs.readFileSync(filePath, 'utf8');
    } catch (_) {
      readBack = '';
    }
    if (verify(readBack)) return true;
    // Someone clobbered us; park (no CPU spin) and retry with a growing backoff.
    if (attempt < retries) {
      sleepSync(backoffMs * (attempt + 1));
    }
  }
  return false;
}

module.exports = { writeAtomic, writeAndVerify };
