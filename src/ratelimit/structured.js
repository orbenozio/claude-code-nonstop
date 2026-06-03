'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/**
 * Structured rate-limit source via a bundled `usage-core` binary.
 *
 * Runs the binary with NO arguments (it self-resolves the token from Claude Code's
 * credentials) and parses its JSON stdout. Mirrors the mechanism used by the user's
 * own claude-code-usage-indicator, but with a BUNDLED copy so Nonstop has no
 * dependency on that extension being installed (SPEC.md §4.6, RECON.md §3).
 *
 * NOTE (architecture): this runs in the Extension Host (Node), not the webview.
 * Feeding the result into the injected webview loop requires a host->webview channel,
 * which is deferred past MVP (SPEC.md §2.2). In MVP the webview uses DOM-based
 * rate-limit detection; this module is built and tested, ready to wire up.
 */

/** Resolve the bundled binary path for the current platform. */
function resolveCorePath(extensionPath, configuredPath) {
  if (configuredPath && configuredPath.trim()) {
    return configuredPath.trim();
  }
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(extensionPath, 'bin', `usage-core-${process.platform}-${process.arch}${ext}`);
}

/** On mac/linux restore the execute bit lost when unpacking from a .vsix. */
function ensureExecutable(corePath) {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(corePath, 0o755);
  } catch (_) {
    /* best effort — execFile surfaces a real error */
  }
}

/**
 * Parse usage-core JSON into a normalized rate-limit view.
 * Pure function — unit-testable without running the binary.
 *
 * @returns {{ ok: boolean, limited: boolean, resetsAt: number|null, retryAfterMs: number|null, utilization: number|null, error?: string }}
 */
function parseUsage(json) {
  let usage;
  try {
    usage = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (e) {
    return { ok: false, limited: false, resetsAt: null, retryAfterMs: null, utilization: null, error: 'parse error' };
  }
  if (!usage || usage.error || !usage.five_hour) {
    return { ok: false, limited: false, resetsAt: null, retryAfterMs: null, utilization: null, error: usage && usage.error };
  }
  const fh = usage.five_hour;
  const utilization = typeof fh.utilization === 'number' ? fh.utilization : null;
  const retryAfterMs = typeof usage.retry_after === 'number' ? usage.retry_after * 1000 : null;
  let resetsAt = null;
  if (fh.resets_at != null) {
    const t = typeof fh.resets_at === 'number' ? fh.resets_at * (fh.resets_at < 1e12 ? 1000 : 1) : Date.parse(fh.resets_at);
    if (!Number.isNaN(t)) resetsAt = t;
  }
  // "limited" when utilization is maxed out or a retry_after is present.
  const limited = (utilization != null && utilization >= 1) || (retryAfterMs != null && retryAfterMs > 0);
  return { ok: true, limited, resetsAt, retryAfterMs, utilization };
}

/** Run the bundled usage-core and return a normalized view (Promise). */
function fetchUsage(extensionPath, configuredPath) {
  return new Promise((resolve) => {
    const corePath = resolveCorePath(extensionPath, configuredPath);
    if (!fs.existsSync(corePath)) {
      resolve({ ok: false, limited: false, resetsAt: null, retryAfterMs: null, utilization: null, error: 'binary not found' });
      return;
    }
    ensureExecutable(corePath);
    execFile(corePath, { timeout: 12000 }, (err, stdout) => {
      if (err && !stdout) {
        resolve({ ok: false, limited: false, resetsAt: null, retryAfterMs: null, utilization: null, error: err.message });
        return;
      }
      resolve(parseUsage(stdout));
    });
  });
}

module.exports = { resolveCorePath, ensureExecutable, parseUsage, fetchUsage };
