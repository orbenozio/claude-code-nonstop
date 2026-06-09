'use strict';

/*
 * Dependency-free DOM sandbox for the injected webview script (webview/nonstop.js).
 *
 * The webview runs in a browser context and is never required() by the host tests,
 * so its runtime behaviour (state detection, rate-limit sleep/resume, the served-limit
 * no-re-sleep guard) had only *structural* grep guards in run.js — nothing actually
 * executed it. This harness stubs the handful of browser globals the script touches,
 * evaluates the real source, and returns the window.__nonstopDebug surface plus the
 * fake localStorage so a test can drive real behaviour and assert on observable state.
 *
 * It is deliberately a minimal DOM: enough for boot() not to throw and for the public
 * debug API to run. It does NOT try to be jsdom. Tests here exercise behaviour reachable
 * through __nonstopDebug + localStorage; pieces that need real layout/DOM (button paint,
 * contenteditable send) are out of scope and noted in the QA report.
 *
 * v0.3.0 additions (all backward compatible / opt-in):
 *   - opts.store        : pass an existing Map to share localStorage across loads
 *                         (simulates a PANEL RELOAD: persisted LS survives, in-memory
 *                         closure state resets — exactly the inputIsForeign reload case).
 *   - opts.inputText    : seed the contenteditable input's text (drives inputIsForeign).
 *   - opts.withSendButton: when true, provide a fake <button class="sendButton_…"> so the
 *                          real setInputAndSend() prefers it over a synthetic Enter.
 *   - returned setInput(t): swap the input text at will.
 *   - returned pump()      : fire every captured setInterval callback once (incl. tick()),
 *                            so tests can drive a real poll without exposing tick().
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    style: {},
    classList: { _s: new Set(), add() {}, remove() {}, toggle() {}, contains() { return false; } },
    attributes: {},
    _text: '',
    parentNode: null,
    disabled: false,
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    get innerText() { return this._text; }, // present but tests assert it's unused in source
    set innerText(v) { this._text = String(v); },
    innerHTML: '',
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { width: 200, height: 150, top: 0, left: 0 }; },
    contains(n) { return n === this; },
    click() { if (typeof this._onclick === 'function') this._onclick(); },
    focus() {},
    remove() {},
    get offsetWidth() { return 10; },   // counts as "visible" for isVisible()
    get offsetHeight() { return 10; },
    getClientRects() { return [{}]; },
    get offsetParent() { return {}; },
  };
  return el;
}

/**
 * Build a sandbox, evaluate the webview source in it, and return handles.
 * @param {object} opts { config, transcriptText, now, store, inputText, withSendButton }
 *   - config: object merged into window.__NONSTOP_CONFIG__
 *   - transcriptText: text returned by the messages-container textContent (state input)
 */
function load(opts) {
  opts = opts || {};
  const store = opts.store instanceof Map ? opts.store : new Map();
  const localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
  };

  // A single transcript element whose text the tests can swap at will.
  const transcriptEl = makeEl('div');
  transcriptEl.attributes.class = 'messagesContainer_abc';
  transcriptEl.textContent = opts.transcriptText || '';

  // Optional contenteditable input (so inputText()/getInput() resolve) and a real send
  // button (so setInputAndSend prefers it). Both are opt-in to keep existing tests' DOM
  // minimal — when absent, the SIGNALS.input / SIGNALS.sendButton selectors return null
  // exactly as before.
  const inputEl = makeEl('div');
  inputEl.attributes.contenteditable = 'plaintext-only';
  inputEl.attributes.role = 'textbox';
  inputEl.textContent = opts.inputText || '';
  let sendClicks = 0;
  const sendBtn = makeEl('button');
  sendBtn.attributes.class = 'sendButton_xyz';
  sendBtn.attributes.type = 'submit';
  sendBtn._onclick = function () { sendClicks++; };

  const body = makeEl('body');
  function selMatch(sel, el, classRe) {
    return classRe.test(sel) ? el : null;
  }
  const documentStub = {
    body,
    activeElement: null,
    head: makeEl('head'),
    addEventListener() {},
    removeEventListener() {},
    createElement(tag) { return makeEl(tag); },
    execCommand(cmd, _ui, val) {
      // Faithfully model selectAll+delete+insertText against the input the source targets.
      if (cmd === 'selectAll' || cmd === 'delete') { inputEl.textContent = ''; return true; }
      if (cmd === 'insertText') { inputEl.textContent = String(val == null ? '' : val); return true; }
      return true;
    },
    getElementById() { return null; },
    querySelector(sel) {
      if (/messagesContainer_/.test(sel)) return transcriptEl;
      if (opts.input && /contenteditable.*textbox|role="textbox"|textbox.*contenteditable/.test(sel)) return inputEl;
      if (opts.input && /contenteditable="plaintext-only"/.test(sel)) return inputEl;
      if (opts.withSendButton && /sendButton_/.test(sel)) return sendBtn;
      return null;
    },
    querySelectorAll(sel) {
      if (/messagesContainer_/.test(sel)) return [transcriptEl];
      return [];
    },
  };

  const intervals = [];
  const timers = [];
  const windowStub = {
    __NONSTOP_CONFIG__: Object.assign({ debug: false }, opts.config || {}),
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1200,
    innerHeight: 800,
    setInterval(fn) { intervals.push(fn); return intervals.length; }, // capture, never auto-poll
    clearInterval() {},
    setTimeout(fn) { timers.push(fn); return timers.length; }, // capture, never auto-fire
    clearTimeout() {},
  };

  // Minimal InputEvent / KeyboardEvent constructors so setInputAndSend's fallback path
  // (synthetic events) doesn't throw under vm.
  function FakeEvent(type, init) { this.type = type; Object.assign(this, init || {}); }

  const sandbox = {
    window: windowStub,
    document: documentStub,
    localStorage,
    console,
    navigator: { userAgent: 'node-harness' },
    setInterval: windowStub.setInterval,
    clearInterval: windowStub.clearInterval,
    setTimeout: windowStub.setTimeout,
    clearTimeout: windowStub.clearTimeout,
    InputEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
    Intl,
    Date,
    Math,
    JSON,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
  };
  // window self-reference for `window.foo` reads that also appear as bare globals.
  windowStub.window = windowStub;

  const src = fs.readFileSync(path.join(__dirname, '..', 'webview', 'nonstop.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'webview/nonstop.js' });

  return {
    window: windowStub,
    debug: windowStub.__nonstopDebug,
    ls: localStorage,
    store,
    setTranscript(t) { transcriptEl.textContent = String(t); },
    setInput(t) { inputEl.textContent = String(t); },
    transcriptEl,
    inputEl,
    sendBtn,
    sendClicks: () => sendClicks,
    pump() { intervals.forEach(fn => { try { fn(); } catch (e) {} }); },
    fireTimers() { while (timers.length) { const t = timers.shift(); try { t(); } catch (e) {} } },
  };
}

module.exports = { load, makeEl };
