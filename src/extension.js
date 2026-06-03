'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const { BACKUP_SUFFIX, DONE_SENTINEL } = require('./constants');
const injector = require('./injector');
const { writeAndVerify } = require('./atomicWrite');
const { resolveTargets } = require('./targets/claude-code');
const { detectRtlInjection } = require('./coexistence');
const statusBar = require('./statusBar');

let reinjectTimer = null;

function getConfig() {
  return vscode.workspace.getConfiguration('nightShift');
}

/** Build the seed config object passed to the webview via __NIGHTSHIFT_CONFIG__. */
function buildSeedConfig() {
  const c = getConfig();
  return {
    pingText: c.get('pingText', 'continue'),
    pingIntervalMs: c.get('pingIntervalMs', 60000),
    pollMs: c.get('pollMs', 1000),
    maxRuntimeMs: c.get('maxRuntimeMs', 28800000),
    maxPings: c.get('maxPings', 100),
    quietHours: c.get('quietHours', ''),
    onQuestion: c.get('onQuestion', 'stop'),
    questionAnswer: c.get('questionAnswer', 'continue, use your best judgment'),
    doneStallPings: c.get('doneStallPings', 3),
    sentinelDoneDetection: c.get('sentinelDoneDetection', true),
    rateLimitFallbackMs: c.get('rateLimitFallbackMs', 18000000),
    userActivityPauseMs: c.get('userActivityPauseMs', 120000),
    debug: c.get('debug', false),
    doneSentinel: DONE_SENTINEL,
  };
}

function loadWebviewScript(context) {
  const p = path.join(context.extensionPath, 'webview', 'night-shift.js');
  return fs.readFileSync(p, 'utf8');
}

function backupPathFor(indexPath) {
  return indexPath + BACKUP_SUFFIX;
}

/** Ensure a backup exists. Note: if RTL already injected, the backup will contain
 *  RTL's injection — that's acceptable (see SPEC.md §6.4); we never rely on it for
 *  a pristine restore, only for emergency recovery. */
function ensureBackup(indexPath) {
  const bp = backupPathFor(indexPath);
  if (!fs.existsSync(bp)) {
    try { fs.copyFileSync(indexPath, bp); } catch (_) { /* best effort */ }
  }
}

/** Inject (or refresh) Night Shift into a single target. Returns true if changed. */
function injectTarget(target, version, scriptBody, configJson) {
  let content;
  try {
    content = fs.readFileSync(target.indexPath, 'utf8');
  } catch (_) {
    return false;
  }
  if (injector.hasValidInjection(content, version)) {
    return false; // already correct
  }
  ensureBackup(target.indexPath);

  const next = injector.inject(content, version, configJson, scriptBody);
  const ok = writeAndVerify(
    target.indexPath,
    next,
    (written) => injector.hasValidInjection(written, version),
    { retries: 3, backoffMs: 50 }
  );
  if (!ok) {
    console.error(`[Night Shift] write race not resolved for ${target.indexPath}`);
  }
  // Touching RTL? We never remove it; just note coexistence for diagnostics.
  if (detectRtlInjection(next)) {
    console.log('[Night Shift] coexisting with RTL injection in', target.name);
  }
  return ok;
}

function checkAndInject(context, { interactive = false } = {}) {
  const c = getConfig();
  if (!c.get('autoInject', true) && !interactive) return { changed: 0, targets: 0 };

  const version = context.extension.packageJSON.version;
  const scriptBody = loadWebviewScript(context);
  const configJson = JSON.stringify(buildSeedConfig());
  const targets = resolveTargets(vscode);

  let changed = 0;
  for (const t of targets) {
    if (injectTarget(t, version, scriptBody, configJson)) changed++;
  }
  return { changed, targets: targets.length };
}

/** Remove only our blocks from every target (never blind-restore — could delete RTL). */
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

/** Re-inject after a Night Shift version change (refreshes the injected script). */
function handleVersionUpgrade(context) {
  const version = context.extension.packageJSON.version;
  const stored = context.globalState.get('nightShift.installedVersion');
  if (stored && stored !== version) {
    checkAndInject(context, { interactive: false });
  }
  context.globalState.update('nightShift.installedVersion', version);
}

function offerReload() {
  vscode.window.showInformationMessage(
    'Night Shift injected. Reload the Claude Code window (or restart the Extension Host) to load it.',
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
    vscode.commands.registerCommand('nightShift.checkAndInject', () => {
      const r = checkAndInject(context, { interactive: true });
      if (r.changed > 0) offerReload();
      else vscode.window.showInformationMessage(`Night Shift: nothing to update (${r.targets} target(s) already current).`);
    }),
    vscode.commands.registerCommand('nightShift.removeInjection', () => {
      const n = removeInjection();
      vscode.window.showInformationMessage(`Night Shift: removed injection from ${n} target(s). Reload to apply.`);
    }),
    vscode.commands.registerCommand('nightShift.stopNow', () => {
      vscode.window.showWarningMessage(
        'Night Shift "Stop Now" is best-effort only (no host↔webview channel in MVP). The reliable stop is the OFF button in the Claude panel.'
      );
    }),
    vscode.commands.registerCommand('nightShift.showMenu', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(syringe) Check & Inject', cmd: 'nightShift.checkAndInject' },
          { label: '$(trash) Remove Injection', cmd: 'nightShift.removeInjection' },
          { label: '$(debug-stop) Stop Now (best effort)', cmd: 'nightShift.stopNow' },
        ],
        { placeHolder: 'Claude Code Night Shift' }
      );
      if (pick) vscode.commands.executeCommand(pick.cmd);
    })
  );

  // Re-inject when relevant settings change (refresh seed config in the injected block).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('nightShift')) {
        checkAndInject(context, { interactive: false });
      }
    })
  );

  const r = checkAndInject(context, { interactive: false });
  if (r.changed > 0) offerReload();
  scheduleReinject(context);
}

function deactivate() {
  if (reinjectTimer) clearInterval(reinjectTimer);
}

module.exports = { activate, deactivate };
