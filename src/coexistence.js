'use strict';

const { RTL_MARKER } = require('./constants');

/**
 * Coexistence helpers for sharing Claude Code's webview/index.js with the
 * `rtl-for-vs-code-agents` extension. See SPEC.md §7.
 *
 * Verified facts about RTL (from its source):
 *  - It appends its script to webview/index.js with the marker "RTL for VS Code Agents"
 *    and keeps a backup named "index.js.backup" (we use ".nightshift-backup").
 *  - Its restore slices from its marker to end-of-file, so a Night Shift block placed
 *    AFTER the RTL marker would be deleted by an RTL restore — our periodic reinject
 *    plus position-based idempotency recovers from this.
 *  - It also injects into the sibling extension.js (marker "RTL-Plan-Injection").
 *    Night Shift NEVER touches extension.js, so there is no conflict there.
 */

/** True if RTL has injected into this content. */
function detectRtlInjection(content) {
  return content.includes(RTL_MARKER);
}

module.exports = { detectRtlInjection };
