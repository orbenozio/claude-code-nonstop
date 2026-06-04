'use strict';

/**
 * Shared constants for Claude Code Nonstop.
 *
 * The injection markers are two-sided (open + close) so the injected block can be
 * located and removed precisely no matter what else is appended to the same file
 * by another co-installed extension. Removing only the text *between* our own
 * markers is what lets us share the file safely — see SPEC.md §4.2 / §7.
 */

// Open marker carries the version: "// >>> Claude Code Nonstop (injected) v1.2.3 >>>"
const OPEN_PREFIX = '// >>> Claude Code Nonstop (injected) v';
const OPEN_SUFFIX = ' >>>';
const CLOSE_MARKER = '// <<< Claude Code Nonstop (injected) <<<';

// Marker string of a known co-installed extension that injects into the same
// webview file. Used only to detect its presence (for diagnostics) so we never
// clobber it — the value must match that extension's marker verbatim.
const FOREIGN_MARKER = 'RTL for VS Code Agents';

// Backup file suffix (kept distinct from the ".backup" name other tools may use).
const BACKUP_SUFFIX = '.nonstop-backup';

// Claude Code extension id and directory prefix.
const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
const CLAUDE_DIR_PREFIX = 'anthropic.claude-code-';

// The webview entry file we inject into, relative to the extension dir.
const WEBVIEW_ENTRY = 'webview/index.js';

// Sentinel that Claude is asked to emit when a task is fully complete.
const DONE_SENTINEL = 'NONSTOP_DONE';

module.exports = {
  OPEN_PREFIX,
  OPEN_SUFFIX,
  CLOSE_MARKER,
  FOREIGN_MARKER,
  BACKUP_SUFFIX,
  CLAUDE_EXTENSION_ID,
  CLAUDE_DIR_PREFIX,
  WEBVIEW_ENTRY,
  DONE_SENTINEL,
};
