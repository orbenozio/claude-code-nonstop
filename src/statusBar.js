'use strict';

let statusBarItem;

/**
 * A small status bar item. Because there is no host<->webview channel in MVP
 * (SPEC.md §2.2), this reflects injection status only, not live ON/OFF state.
 */
function create(vscode, context) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'nightShift.showMenu';
  statusBarItem.text = '$(moon) Night Shift';
  statusBarItem.tooltip = 'Claude Code Night Shift — click for menu';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  return statusBarItem;
}

function setText(text, tooltip) {
  if (!statusBarItem) return;
  statusBarItem.text = text;
  if (tooltip) statusBarItem.tooltip = tooltip;
}

module.exports = { create, setText };
