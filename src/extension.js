'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const { BACKUP_SUFFIX, DONE_SENTINEL } = require('./constants');
const injector = require('./injector');
const { writeAndVerify } = require('./atomicWrite');
const { resolveTargets } = require('./targets/claude-code');
const { detectOtherInjection } = require('./coexistence');
const statusBar = require('./statusBar');

let reinjectTimer = null;
let lastFocusCheck = 0;

// Don't re-scan the target file more than once per this window on rapid focus
// toggles (alt-tabbing). Long enough to avoid fs thrash, short enough that the
// "dead window" after the file was clobbered is effectively gone.
const FOCUS_REINJECT_THROTTLE_MS = 30000;

function getConfig() {
  return vscode.workspace.getConfiguration('nonstop');
}

/** Build the seed config object passed to the webview via __NONSTOP_CONFIG__. */
function buildSeedConfig(version) {
  const c = getConfig();
  return {
    version: version || '',
    pingText: c.get('pingText', 'continue'),
    pingIntervalMs: c.get('pingIntervalMs', 60000),
    pollMs: c.get('pollMs', 1000),
    maxRuntimeMs: c.get('maxRuntimeMs', 28800000),
    maxPings: c.get('maxPings', 100),
    quietHours: c.get('quietHours', ''),
    onQuestion: c.get('onQuestion', 'stop'),
    questionAnswer: c.get('questionAnswer', 'continue, use your best judgment'),
    onPermission: c.get('onPermission', 'defer'),
    permissionGraceMs: c.get('permissionGraceMs', 10000),
    onDecision: c.get('onDecision', 'stop'),
    decisionAnswer: c.get('decisionAnswer', 'use your best judgment'),
    doneStallPings: c.get('doneStallPings', 3),
    sentinelDoneDetection: c.get('sentinelDoneDetection', true),
    rateLimitFallbackMs: c.get('rateLimitFallbackMs', 18000000),
    userActivityPauseMs: c.get('userActivityPauseMs', 120000),
    debug: c.get('debug', false),
    doneSentinel: DONE_SENTINEL,
  };
}

function loadWebviewScript(context) {
  const p = path.join(context.extensionPath, 'webview', 'nonstop.js');
  return fs.readFileSync(p, 'utf8');
}

function backupPathFor(indexPath) {
  return indexPath + BACKUP_SUFFIX;
}

/** Ensure a backup exists. Note: if another extension already injected, the backup
 *  will contain that injection — that's acceptable (see SPEC.md §6.4); we never rely
 *  on it for a pristine restore, only for emergency recovery. */
function ensureBackup(indexPath) {
  const bp = backupPathFor(indexPath);
  if (!fs.existsSync(bp)) {
    try { fs.copyFileSync(indexPath, bp); } catch (_) { /* best effort */ }
  }
}

/** Inject (or refresh) Nonstop into a single target. Returns true if changed. */
function injectTarget(target, version, scriptBody, configJson) {
  let content;
  try {
    content = fs.readFileSync(target.indexPath, 'utf8');
  } catch (_) {
    return false;
  }
  // Compare the *desired* injected content to what's already there, so we refresh on
  // ANY change — version, seed config, or script body — not just a version bump.
  // (inject() is canonical: stripping + re-appending an unchanged block is a no-op.)
  const next = injector.inject(content, version, configJson, scriptBody);
  if (next === content) {
    return false; // already current (version + config + code all match)
  }
  ensureBackup(target.indexPath);

  const ok = writeAndVerify(
    target.indexPath,
    next,
    (written) => injector.hasValidInjection(written, version),
    { retries: 3, backoffMs: 50 }
  );
  if (!ok) {
    console.error(`[Nonstop] write race not resolved for ${target.indexPath}`);
  }
  // Another injection present? We never remove it; just note coexistence for diagnostics.
  if (detectOtherInjection(next)) {
    console.log('[Nonstop] coexisting with another injection in', target.name);
  }
  return ok;
}

function checkAndInject(context, { interactive = false } = {}) {
  const c = getConfig();
  if (!c.get('autoInject', true) && !interactive) return { changed: 0, targets: 0 };

  const version = context.extension.packageJSON.version;
  const scriptBody = loadWebviewScript(context);
  const configJson = JSON.stringify(buildSeedConfig(version));
  const targets = resolveTargets(vscode);

  let changed = 0;
  for (const t of targets) {
    if (injectTarget(t, version, scriptBody, configJson)) changed++;
  }
  const result = { changed, targets: targets.length };
  statusBar.reflect(result);
  return result;
}

/** Remove only our blocks from every target (never blind-restore — could delete another injection). */
function removeInjection() {
  const targets = resolveTargets(vscode);
  let changed = 0;
  for (const t of targets) {
    let content;
    try { content = fs.readFileSync(t.indexPath, 'utf8'); } catch (_) { continue; }
    const blocks = injector.findBlocks(content);
    if (blocks.length === 0) continue;
    const cleaned = injector.stripAllBlocks(content).replace(/\s+$/, '') + '\n';
    writeAndVerify(t.indexPath, cleaned, (w) => injector.findBlocks(w).length === 0);
    try { fs.unlinkSync(backupPathFor(t.indexPath)); } catch (_) { /* ignore */ }
    changed++;
  }
  return changed;
}

function scheduleReinject(context) {
  if (reinjectTimer) { clearInterval(reinjectTimer); reinjectTimer = null; }
  const hours = Number(getConfig().get('reinjectCheckHours', 6)) || 0;
  if (hours <= 0) return;
  reinjectTimer = setInterval(() => {
    checkAndInject(context, { interactive: false });
  }, hours * 3600 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(reinjectTimer) });
}

/**
 * Re-check/re-inject when the VS Code window regains focus.
 *
 * Something else can edit the shared Claude webview/index.js and remove our block;
 * waiting up to `reinjectCheckHours` (default 6h) to recover leaves a long window
 * where Nonstop is gone. Re-checking on focus shrinks that window to the next time
 * you touch VS Code. Throttled so rapid focus toggles don't hammer the filesystem.
 */
function registerFocusReinject(context) {
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) return;
      const now = Date.now();
      if (now - lastFocusCheck < FOCUS_REINJECT_THROTTLE_MS) return;
      lastFocusCheck = now;
      checkAndInject(context, { interactive: false });
    })
  );
}

/** Re-inject after a Nonstop version change (refreshes the injected script). */
function handleVersionUpgrade(context) {
  const version = context.extension.packageJSON.version;
  const stored = context.globalState.get('nonstop.installedVersion');
  if (stored && stored !== version) {
    checkAndInject(context, { interactive: false });
  }
  context.globalState.update('nonstop.installedVersion', version);
}

function offerReload() {
  vscode.window.showInformationMessage(
    'Nonstop injected. Reload the Claude Code window (or restart the Extension Host) to load it.',
    'Reload Window', 'Restart Extension Host'
  ).then((choice) => {
    if (choice === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
    else if (choice === 'Restart Extension Host') vscode.commands.executeCommand('workbench.action.restartExtensionHost');
  });
}

function activate(context) {
  handleVersionUpgrade(context);
  statusBar.create(vscode, context);

  context.subscriptions.push(
    vscode.commands.registerCommand('nonstop.checkAndInject', () => {
      const r = checkAndInject(context, { interactive: true });
      if (r.changed > 0) offerReload();
      else vscode.window.showInformationMessage(`Nonstop: nothing to update (${r.targets} target(s) already current).`);
    }),
    vscode.commands.registerCommand('nonstop.removeInjection', () => {
      const n = removeInjection();
      vscode.window.showInformationMessage(`Nonstop: removed injection from ${n} target(s). Reload to apply.`);
    }),
    vscode.commands.registerCommand('nonstop.stopNow', () => {
      vscode.window.showWarningMessage(
        'Nonstop "Stop Now" is best-effort only (no host↔webview channel in MVP). The reliable stop is the OFF button in the Claude panel.'
      );
    }),
    vscode.commands.registerCommand('nonstop.showMenu', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(syringe) Check & Inject', cmd: 'nonstop.checkAndInject' },
          { label: '$(trash) Remove Injection', cmd: 'nonstop.removeInjection' },
          { label: '$(debug-stop) Stop Now (best effort)', cmd: 'nonstop.stopNow' },
        ],
        { placeHolder: 'Claude Code Nonstop' }
      );
      if (pick) vscode.commands.executeCommand(pick.cmd);
    })
  );

  // Re-inject when relevant settings change (refresh seed config in the injected block).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('nonstop')) {
        checkAndInject(context, { interactive: false });
      }
    })
  );

  const r = checkAndInject(context, { interactive: false });
  if (r.changed > 0) offerReload();
  scheduleReinject(context);
  registerFocusReinject(context);
}

function deactivate() {
  if (reinjectTimer) clearInterval(reinjectTimer);
}

module.exports = { activate, deactivate };
