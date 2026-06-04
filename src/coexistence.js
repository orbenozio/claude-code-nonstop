'use strict';

const { FOREIGN_MARKER } = require('./constants');

/**
 * Coexistence helpers for sharing Claude Code's webview/index.js with another
 * co-installed extension that injects into the same file. See SPEC.md §7.
 *
 * Verified facts about that extension's behaviour:
 *  - It appends its script to webview/index.js with its own marker and keeps a
 *    backup named "index.js.backup" (we use ".nonstop-backup").
 *  - Its restore slices from its marker to end-of-file, so a Nonstop block placed
 *    AFTER that marker would be deleted by its restore — our reinject on focus and
 *    on a periodic timer, plus position-based idempotency, recovers from this.
 *  - It also injects into the sibling extension.js. Nonstop NEVER touches
 *    extension.js, so there is no conflict there.
 */

/** True if the other extension has injected into this content. */
function detectOtherInjection(content) {
  return content.includes(FOREIGN_MARKER);
}

module.exports = { detectOtherInjection };
