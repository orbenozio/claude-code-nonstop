'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Atomic file write: write to a temp file in the same directory, then rename over
 * the target. Rename is atomic on the same filesystem, so a concurrent reader
 * never sees a half-written file. Mitigates the write race with the RTL extension
 * (SPEC.md §6.4 / §7.2).
 */
function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.nightshift-tmp-${process.pid}-${Date.now()}`);
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
    // Someone clobbered us; wait and retry.
    if (attempt < retries) {
      const until = Date.now() + backoffMs * (attempt + 1);
      while (Date.now() < until) { /* tiny busy-wait; backoff is short */ }
    }
  }
  return false;
}

module.exports = { writeAtomic, writeAndVerify };
