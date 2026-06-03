'use strict';

/*
 * Inject Nonstop into the live Claude Code install(s).
 * Uses the same host core as the extension (backup + atomic write + verify).
 * Run: node scripts/inject-live.js [--all] [--remove]
 *   default: inject into the newest Claude Code version (with debug ON for tuning)
 *   --all:    inject into every Claude Code install found
 *   --remove: strip Nonstop from all installs and delete our backups
 */

const fs = require('fs');
const path = require('path');

const injector = require('../src/injector');
const { writeAndVerify } = require('../src/atomicWrite');
const { scanAllInstalls } = require('../src/targets/claude-code');
const { detectRtlInjection } = require('../src/coexistence');
const { BACKUP_SUFFIX } = require('../src/constants');

const VERSION = require('../package.json').version;
const REMOVE = process.argv.includes('--remove');
const ALL = process.argv.includes('--all');

const scriptBody = fs.readFileSync(path.join(__dirname, '..', 'webview', 'nonstop.js'), 'utf8');
const seed = {
  pingText: 'continue',
  pingIntervalMs: 60000,   // real-use cadence
  pollMs: 1000,
  maxRuntimeMs: 28800000,
  maxPings: 100,
  quietHours: '',
  onQuestion: 'stop',
  questionAnswer: 'continue, use your best judgment',
  doneStallPings: 3,
  sentinelDoneDetection: true,
  rateLimitFallbackMs: 18000000,
  userActivityPauseMs: 120000,
  debug: false,           // set true to re-enable the console heartbeat for tuning
  doneSentinel: 'NONSTOP_DONE',
};
const cfgJson = JSON.stringify(seed);

let installs = scanAllInstalls();
if (installs.length === 0) { console.error('No Claude Code installs found.'); process.exit(2); }
// Sort by version descending; default to the newest only.
installs.sort((a, b) => (b.version || '').localeCompare(a.version || '', undefined, { numeric: true }));
const targets = ALL ? installs : [installs[0]];

for (const t of targets) {
  const bp = t.indexPath + BACKUP_SUFFIX;
  if (REMOVE) {
    let content = fs.readFileSync(t.indexPath, 'utf8');
    const cleaned = injector.stripAllBlocks(content).replace(/\s+$/, '') + '\n';
    const ok = writeAndVerify(t.indexPath, cleaned, (w) => injector.findBlocks(w).length === 0);
    try { fs.unlinkSync(bp); } catch (_) {}
    console.log(`${ok ? 'REMOVED' : 'REMOVE-FAILED'}: ${t.name}`);
    continue;
  }
  const content = fs.readFileSync(t.indexPath, 'utf8');
  if (!fs.existsSync(bp)) fs.copyFileSync(t.indexPath, bp);
  const next = injector.inject(content, VERSION, cfgJson, scriptBody);
  const ok = writeAndVerify(t.indexPath, next, (w) => injector.hasValidInjection(w, VERSION));
  console.log(`${ok ? 'INJECTED' : 'INJECT-FAILED'}: ${t.name}  (RTL present: ${detectRtlInjection(next)}, backup: ${path.basename(bp)})`);
}
console.log(REMOVE ? 'Done. Reload the Claude Code window.' : 'Done. Reload the Claude Code window to load Nonstop (button: ♾️).');
