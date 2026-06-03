'use strict';

/**
 * Position-based, two-sided-marker injection logic.
 *
 * Unlike RTL (which slices from its marker to end-of-file), Nonstop wraps its
 * injected block in matching open/close markers and only ever removes the text
 * *between and including* a marker pair. This lets two extensions coexist in the
 * same file, and lets us clean up "fossilized" leftovers that another extension's
 * restore might leave behind.
 *
 * Pure string functions here (no fs) so they are trivially unit-testable.
 */

const {
  OPEN_PREFIX,
  OPEN_SUFFIX,
  CLOSE_MARKER,
} = require('./constants');

/**
 * Find every Nonstop block in `content`.
 * Returns an array of { start, end, version } where [start, end) spans the whole
 * block including both markers. Handles multiple/duplicate blocks (defensive).
 */
function findBlocks(content) {
  const blocks = [];
  let searchFrom = 0;
  while (true) {
    const openIdx = content.indexOf(OPEN_PREFIX, searchFrom);
    if (openIdx < 0) break;

    // Parse version between OPEN_PREFIX and OPEN_SUFFIX on the same marker line.
    const lineEnd = content.indexOf('\n', openIdx);
    const openLine = content.slice(openIdx, lineEnd < 0 ? content.length : lineEnd);
    let version = null;
    if (openLine.endsWith(OPEN_SUFFIX)) {
      version = openLine.slice(OPEN_PREFIX.length, openLine.length - OPEN_SUFFIX.length);
    }

    const closeIdx = content.indexOf(CLOSE_MARKER, openIdx);
    if (closeIdx < 0) {
      // Open marker without a close — treat the rest of the file as the (malformed)
      // block so stripping still cleans it up.
      blocks.push({ start: openIdx, end: content.length, version, malformed: true });
      break;
    }
    const end = closeIdx + CLOSE_MARKER.length;
    blocks.push({ start: openIdx, end, version, malformed: false });
    searchFrom = end;
  }
  return blocks;
}

/**
 * Remove ALL Nonstop blocks from `content` (including duplicates/leftovers),
 * collapsing any surrounding blank lines left behind. Returns cleaned content.
 */
function stripAllBlocks(content) {
  const blocks = findBlocks(content);
  if (blocks.length === 0) return content;
  // Remove from last to first so earlier indices stay valid.
  let out = content;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const { start, end } = blocks[i];
    let s = start;
    let e = end;
    // Eat a single trailing newline and any immediately preceding blank line glue.
    if (out[e] === '\n') e += 1;
    // Trim trailing spaces/newlines we may have introduced before the block.
    while (s > 0 && (out[s - 1] === '\n' || out[s - 1] === ' ' || out[s - 1] === '\t')) {
      // Only collapse a single preceding newline to avoid eating real code spacing.
      if (out[s - 1] === '\n') { s -= 1; break; }
      s -= 1;
    }
    out = out.slice(0, s) + out.slice(e);
  }
  return out;
}

/**
 * Build a fresh injection block.
 * @param {string} version  extension version (goes in the open marker)
 * @param {string} configJson  already JSON.stringify'd config object
 * @param {string} scriptBody  the IIFE-wrapped webview script source
 */
function buildBlock(version, configJson, scriptBody) {
  const open = `${OPEN_PREFIX}${version}${OPEN_SUFFIX}`;
  const configLine = `window.__NONSTOP_CONFIG__ = JSON.parse(${JSON.stringify(configJson)});`;
  return `${open}\n${configLine}\n${scriptBody}\n${CLOSE_MARKER}`;
}

/**
 * Is `content` already correctly injected for `version`?
 * The invariant: exactly one well-formed block, and its version matches.
 */
function hasValidInjection(content, version) {
  const blocks = findBlocks(content);
  if (blocks.length !== 1) return false;
  const b = blocks[0];
  return !b.malformed && b.version === version;
}

/**
 * Produce the new file content with a single fresh Nonstop block appended.
 * Strips any/all existing Nonstop blocks first (idempotent + de-dupe), and
 * leaves all non-Nonstop content (e.g. RTL injection) untouched.
 */
function inject(content, version, configJson, scriptBody) {
  const clean = stripAllBlocks(content);
  const trimmed = clean.replace(/\s+$/, '');
  const block = buildBlock(version, configJson, scriptBody);
  return `${trimmed}\n\n${block}\n`;
}

module.exports = {
  findBlocks,
  stripAllBlocks,
  buildBlock,
  hasValidInjection,
  inject,
};
