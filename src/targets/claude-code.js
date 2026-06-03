'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CLAUDE_EXTENSION_ID,
  CLAUDE_DIR_PREFIX,
  WEBVIEW_ENTRY,
} = require('../constants');

/**
 * Locate Claude Code installation(s) and, preferably, the *active* one.
 *
 * Why not "highest semver": VS Code does not necessarily run the newest version
 * present on disk (pin / rollback / half-finished update can leave 8 parallel
 * dirs). We ask VS Code which one is active; only if that's unavailable do we fall
 * back to scanning every matching dir. See SPEC.md §6.2.
 */

const EXTENSION_BASES = [
  path.join(os.homedir(), '.vscode', 'extensions'),
  path.join(os.homedir(), '.vscode-server', 'extensions'),
  path.join(os.homedir(), '.vscode-insiders', 'extensions'),
  path.join(os.homedir(), '.cursor', 'extensions'),
  path.join(os.homedir(), '.cursor-server', 'extensions'),
];

function indexPathFor(extensionDir) {
  return path.join(extensionDir, ...WEBVIEW_ENTRY.split('/'));
}

function versionFromDirName(name) {
  // anthropic.claude-code-2.1.161-win32-x64 -> "2.1.161"
  const rest = name.slice(CLAUDE_DIR_PREFIX.length);
  const m = rest.match(/^(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/** Scan all known extension bases for Claude Code dirs that have a webview entry. */
function scanAllInstalls() {
  const results = [];
  for (const base of EXTENSION_BASES) {
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(CLAUDE_DIR_PREFIX)) continue;
      const extensionDir = path.join(base, entry.name);
      const indexPath = indexPathFor(extensionDir);
      if (!fs.existsSync(indexPath)) continue;
      results.push({
        extensionDir,
        indexPath,
        version: versionFromDirName(entry.name),
        name: entry.name,
      });
    }
  }
  return results;
}

/**
 * Resolve injection targets.
 * @param {object} [vscode]  the vscode module (optional; enables active-version detection)
 * @returns {Array<{extensionDir, indexPath, version, name, active?: boolean}>}
 */
function resolveTargets(vscode) {
  // Preferred: the active extension as reported by VS Code.
  if (vscode && vscode.extensions && typeof vscode.extensions.getExtension === 'function') {
    const ext = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
    const dir = ext && ext.extensionPath;
    if (dir) {
      const indexPath = indexPathFor(dir);
      if (fs.existsSync(indexPath)) {
        return [{
          extensionDir: dir,
          indexPath,
          version: (ext.packageJSON && ext.packageJSON.version) || versionFromDirName(path.basename(dir)),
          name: path.basename(dir),
          active: true,
        }];
      }
    }
  }
  // Fallback: every install that exists (so the button never silently fails to appear).
  return scanAllInstalls();
}

module.exports = { resolveTargets, scanAllInstalls, versionFromDirName, indexPathFor, EXTENSION_BASES };
