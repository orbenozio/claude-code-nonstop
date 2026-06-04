'use strict';

let statusBarItem;

/**
 * A small status bar item. Because there is no host<->webview channel in MVP
 * (SPEC.md §2.2), this reflects host-side injection status only (is Nonstop wired
 * into Claude's panel?), not the live ON/OFF shift state — that lives on the ♾️
 * button inside the panel.
 */
function create(vscode, context) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'nonstop.showMenu';
  statusBarItem.text = '$(sync) Nonstop';
  statusBarItem.tooltip = 'Claude Code Nonstop — click for menu';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  return statusBarItem;
}

function setText(text, tooltip) {
  if (!statusBarItem) return;
  statusBarItem.text = text;
  if (tooltip) statusBarItem.tooltip = tooltip;
}

/**
 * Reflect the result of a checkAndInject pass.
 * @param {{changed:number, targets:number}} r
 */
function reflect(r) {
  if (!statusBarItem) return;
  if (!r || r.targets === 0) {
    setText('$(circle-slash) Nonstop', 'Claude Code Nonstop — no Claude Code panel found to inject into. Click for menu.');
  } else if (r.changed > 0) {
    setText('$(warning) Nonstop — reload', 'Claude Code Nonstop injected. Reload the window to load it. Click for menu.');
  } else {
    setText('$(check) Nonstop', 'Claude Code Nonstop is active (injected & current). Click for menu.');
  }
}

module.exports = { create, setText, reflect };
