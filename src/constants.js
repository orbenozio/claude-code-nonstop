'use strict';

/**
 * Shared constants for Claude Code Night Shift.
 *
 * The injection markers are two-sided (open + close) so the injected block can be
 * located and removed precisely no matter what else (e.g. the RTL extension) is
 * appended to the same file. This is the core difference from RTL's slice-to-EOF
 * approach — see SPEC.md §4.2 / §7.
 */

// Open marker carries the version: "// >>> Claude Code Night Shift (injected) v1.2.3 >>>"
const OPEN_PREFIX = '// >>> Claude Code Night Shift (injected) v';
const OPEN_SUFFIX = ' >>>';
const CLOSE_MARKER = '// <<< Claude Code Night Shift (injected) <<<';

// String used to detect the RTL extension's injection so we never clobber it.
const RTL_MARKER = 'RTL for VS Code Agents';

// Backup file suffix (distinct from RTL's ".backup").
const BACKUP_SUFFIX = '.nightshift-backup';

// Claude Code extension id and directory prefix.
const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
const CLAUDE_DIR_PREFIX = 'anthropic.claude-code-';

// The webview entry file we inject into, relative to the extension dir.
const WEBVIEW_ENTRY = 'webview/index.js';

// Sentinel that Claude is asked to emit when a task is fully complete.
const DONE_SENTINEL = 'NIGHTSHIFT_DONE';

module.exports = {
  OPEN_PREFIX,
  OPEN_SUFFIX,
  CLOSE_MARKER,
  RTL_MARKER,
  BACKUP_SUFFIX,
  CLAUDE_EXTENSION_ID,
  CLAUDE_DIR_PREFIX,
  WEBVIEW_ENTRY,
  DONE_SENTINEL,
};
