// Claude Code Nonstop — injected webview script.
// Runs inside the Claude Code panel DOM (appended to webview/index.js by the host).
// Wrapped in an IIFE so it never pollutes Claude's globals.
(function () {
  'use strict';

  // ── Config (seeded from the host via __NONSTOP_CONFIG__) ──────────────────
  var DEFAULTS = {
    pingText: 'continue',
    pingIntervalMs: 60000,
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
    debug: false,
    doneSentinel: 'NONSTOP_DONE',
  };
  var CFG = Object.assign({}, DEFAULTS, (window.__NONSTOP_CONFIG__ || {}));

  // Guard against double-injection in the same document.
  if (window.__NONSTOP_ACTIVE__) return;
  window.__NONSTOP_ACTIVE__ = true;

  // Live config: a value set via the right-click popup (localStorage override)
  // takes precedence over the seed config. Read fresh each time so changes apply
  // without a reload.
  var OV_PREFIX = 'nonstop-ov-';
  function liveCfg(key) {
    try {
      var v = localStorage.getItem(OV_PREFIX + key);
      if (v !== null && v !== '') {
        if (typeof CFG[key] === 'number') { var n = parseFloat(v); return isNaN(n) ? CFG[key] : n; }
        return v;
      }
    } catch (e) {}
    return CFG[key];
  }
  function setOverride(key, value) {
    try {
      if (value === null || value === '') localStorage.removeItem(OV_PREFIX + key);
      else localStorage.setItem(OV_PREFIX + key, String(value));
    } catch (e) {}
  }

  function log() {
    if (!CFG.debug) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[Nonstop]');
    console.log.apply(console, args);
  }

  // ── localStorage state (survives reload; source of truth at runtime) ─────────
  var LS = {
    enabled: 'nonstop-enabled',
    sleepUntil: 'nonstop-sleep-until',
    sessionStart: 'nonstop-session-start',
    pingCount: 'nonstop-ping-count',
    ownerId: 'nonstop-owner-id',
    sleptAccum: 'nonstop-slept-accum-ms',
    rlCapture: 'nonstop-rl-capture', // Phase 3: stashed real rate-limit notice
  };
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) {} }
  function lsNum(k, d) { var n = parseInt(lsGet(k, ''), 10); return isNaN(n) ? d : n; }
  function isEnabled() { return lsGet(LS.enabled, 'false') === 'true'; }

  // Unique id for this webview instance (ownership for multi-panel; SPEC §4.7).
  var INSTANCE_ID = 'ns-' + Math.random().toString(36).slice(2) + '-' + Date.now();
  function isOwner() { return lsGet(LS.ownerId, '') === INSTANCE_ID; }

  // ── Signals: selectors + state detection (LAYERED, DEFENSIVE) ────────────────
  // Rule: never hardcode full class names — Claude's class suffixes are hashed and
  // change between versions. Always [class*="prefix_"].
  //
  // ⚠ The selectors / strings marked TUNE below were NOT verified against the live
  // panel (static recon only) — they are the live-tuning targets. The detector
  // degrades gracefully: postMessage → DOM → heuristic.
  var SIGNALS = {
    footer: '[class*="inputFooter_"]',
    input: 'div[contenteditable="plaintext-only"][role="textbox"]',
    // Native Auto/Plan permission-mode button in the footer (carries
    // footerButtonPrimary_; confirmed against the live panel — it wraps a
    // <span> like "Auto mode"). We dock our ♾️ right after it.
    modeButton: '[class*="footerButtonPrimary_"]',
    // TUNE: indicators of an in-progress turn (stop/interrupt button, spinner).
    workingHints: ['[aria-label*="Stop" i]', '[aria-label*="Interrupt" i]', '[class*="streaming_"]', '[class*="loading_"]'],
    // TUNE: approval / question UI (typically a Yes radio + Submit).
    questionHints: ['[role="radiogroup"]', '[class*="approval_"]', '[class*="permission_"]'],
    // Real format (captured live): "You've hit your session limit · resets 10:10pm (Asia/Jerusalem)".
    // Time-capturing patterns first — their group (m[1]) feeds parseResetTime; the bare
    // detector last just flags a limit so we sleep on the fallback window.
    rateLimitRegexes: [
      /hit your (?:session|usage|rate) limit[\s\S]{0,80}?resets?\s+(\d{1,2}:\d{2}\s*[ap]m\b(?:\s*\([^)]+\))?)/i,
      /\bresets?\s+(?:at\s+)?(\d{1,2}:\d{2}\s*[ap]m\b(?:\s*\([^)]+\))?)/i,
      /limit will reset at\s+([^\n]+)/i,
      /\b\d+\s*-?\s*hour limit reached/i,
      /(?:hit|reached)[^\n]{0,30}\b(?:session|usage|rate) limit/i,
    ],
  };

  // postMessage observation (best-effort; SPEC/RECON §1 — host→webview state msgs).
  var observedState = null; // 'running' | 'waiting_input' | 'idle'
  var observedStateAt = 0;
  window.addEventListener('message', function (ev) {
    var d = ev && ev.data;
    if (!d || typeof d !== 'object') return;
    var st = d.state || (d.payload && d.payload.state);
    if (st === 'running' || st === 'waiting_input' || st === 'idle') {
      observedState = st;
      observedStateAt = Date.now();
      log('observed state via message:', st);
    }
  });

  function $(sel, root) { try { return (root || document).querySelector(sel); } catch (e) { return null; } }

  function matchAny(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = $(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function getInput() { return $(SIGNALS.input); }
  function inputText() { var el = getInput(); return el ? (el.textContent || '').trim() : ''; }

  function panelText() {
    // Bounded scan of the conversation area for rate-limit / sentinel detection.
    var main = document.body;
    return main ? (main.innerText || '') : '';
  }

  // Cheap length probe (textContent triggers no layout) for streaming detection.
  function panelLen() {
    return (document.body && document.body.textContent || '').length;
  }

  // ── Streaming detection by output growth (selector-independent, robust) ───────
  // If the conversation's text is actively growing, Claude is generating → WORKING.
  // This is what a human sees ("it's still typing"), and survives DOM/class churn.
  var lastLen = -1;
  var lastGrowthAt = 0;
  function sampleGrowth() {
    var len = panelLen();
    if (lastLen >= 0 && len !== lastLen) lastGrowthAt = Date.now();
    lastLen = len;
  }
  function isStreaming() {
    return lastGrowthAt > 0 && (Date.now() - lastGrowthAt) < 2000;
  }

  // Debug helper: fingerprint the buttons around the input so we can spot what
  // changes between idle and streaming (e.g. a Stop button appearing). The send/
  // stop control may sit just outside inputFooter, so we widen to its parent.
  function footerButtonsFingerprint() {
    var footer = $(SIGNALS.footer);
    if (!footer) return '(no footer)';
    var scope = footer.parentElement || footer;
    var btns = scope.querySelectorAll('button,[role="button"]');
    var out = [];
    for (var i = 0; i < btns.length && out.length < 24; i++) {
      var b = btns[i];
      var label = (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 22);
      out.push(label || '·');
    }
    return out.join(' | ');
  }

  function detectRateLimit() {
    var text = panelText();
    if (!text) return null;
    // Only look at the tail (most recent messages) to limit cost / false hits.
    var tail = text.slice(-4000);
    for (var i = 0; i < SIGNALS.rateLimitRegexes.length; i++) {
      var m = tail.match(SIGNALS.rateLimitRegexes[i]);
      if (m) return { matched: true, captured: m[1] || null };
    }
    return null;
  }

  // ── Phase 3 capture ───────────────────────────────────────────────────────────
  // The detection regexes above are unverified guesses. Until we've seen a real
  // usage-limit notice we cast a WIDE keyword net here (recall over precision — this
  // never triggers sleeping, only stashing) and persist a context snippet + timestamp
  // to localStorage. That way a real overnight hit is recoverable even if DevTools
  // was closed: read window.__nonstopDebug.rateLimitCapture() afterwards.
  var RL_CAPTURE_RE = /(session limit|usage limit|rate limit|limit reached|limit will reset|\bresets?\s+\d|too many requests|\b429\b|approaching your usage)/i;
  function captureRateLimitCandidate() {
    var text = panelText();
    if (!text) return;
    var tail = text.slice(-4000);
    var idx = tail.search(RL_CAPTURE_RE);
    if (idx < 0) return;
    var snippet = tail.slice(Math.max(0, idx - 200), idx + 500).replace(/\s+/g, ' ').trim();
    var prev = '';
    try { prev = (JSON.parse(lsGet(LS.rlCapture, '') || '{}').snippet) || ''; } catch (e) {}
    if (prev === snippet) return; // unchanged → don't re-log/re-store
    lsSet(LS.rlCapture, JSON.stringify({ at: new Date().toISOString(), snippet: snippet }));
    log('⚠️ RATE-LIMIT CANDIDATE captured (read __nonstopDebug.rateLimitCapture()):', snippet);
  }

  // Returns one of WORKING / WAITING_QUESTION / WAITING_CONTINUE / RATE_LIMITED / DONE / UNKNOWN
  function detectState() {
    // Layer 0: rate limit takes precedence (so we never ping into a wall).
    if (detectRateLimit()) return 'RATE_LIMITED';

    // Layer 0.5: output is actively growing → Claude is generating. Primary,
    // selector-independent WORKING signal.
    if (isStreaming()) return 'WORKING';

    // Layer 1: observed postMessage state (fresh only).
    if (observedState && (Date.now() - observedStateAt) < 5000) {
      if (observedState === 'running') return 'WORKING';
      if (observedState === 'waiting_input') {
        return matchAny(SIGNALS.questionHints) ? 'WAITING_QUESTION' : 'WAITING_CONTINUE';
      }
      // idle
      return inputText() === '' ? 'WAITING_CONTINUE' : 'UNKNOWN';
    }

    // Layer 2: DOM reflection.
    if (matchAny(SIGNALS.workingHints)) return 'WORKING';
    if (matchAny(SIGNALS.questionHints)) return 'WAITING_QUESTION';

    // Layer 3: heuristic — input present & empty & nothing working = ready to ping.
    var input = getInput();
    if (input && inputText() === '') return 'WAITING_CONTINUE';
    return 'UNKNOWN';
  }

  // ── Sending text into the contenteditable input ──────────────────────────────
  var weAreTyping = false;
  function setInputAndSend(text) {
    var input = getInput();
    if (!input) { log('no input box found'); return false; }
    weAreTyping = true;
    try {
      input.focus();
      // Clear any leftover (e.g. a previous failed send that became a newline).
      try { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); } catch (e) {}
      var ok = false;
      try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
      if (!ok) {
        // Fallback: synthetic InputEvent.
        input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }));
        input.textContent = text;
        input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
      }
      // Submit: prefer a send button, else Enter.
      var sendBtn = findSendButton();
      if (sendBtn) {
        sendBtn.click();
      } else {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
      return true;
    } finally {
      // Release the typing flag shortly after, so user-activity detection ignores us.
      setTimeout(function () { weAreTyping = false; }, 250);
    }
  }

  function findSendButton() {
    var footer = $(SIGNALS.footer);
    if (!footer) return null;
    // TUNE (Phase 3): confirm the real send-button selector against the live panel.
    // Note: footerButtonPrimary_ is the MODE button, not send — so we can't key off it here.
    return $('[aria-label*="Send" i]', footer) || null;
  }

  function buildPingText() {
    var txt = liveCfg('pingText');
    if (CFG.sentinelDoneDetection) {
      return txt + '\n\n(If the task is fully complete, reply with exactly: ' + CFG.doneSentinel + ')';
    }
    return txt;
  }

  // ── Shift lifecycle ──────────────────────────────────────────────────────────
  function startShift() {
    lsSet(LS.enabled, 'true');
    lsSet(LS.ownerId, INSTANCE_ID);
    lsSet(LS.sessionStart, Date.now());
    lsSet(LS.pingCount, 0);
    lsSet(LS.sleptAccum, 0);
    lsSet(LS.sleepUntil, '');
    // Reset in-memory ping/stall state for a fresh shift.
    stallCount = 0; lastPingSig = null; lastPingAt = 0; lastSendAt = 0; lastGrowthAt = 0;
    baseSentinel = sentinelCount(); sentinelPings = 0;
    log('shift started; owner', INSTANCE_ID);
    updateButton();
  }
  function stopShift(reason) {
    lsSet(LS.enabled, 'false');
    lsSet(LS.sleepUntil, '');
    log('shift stopped:', reason || 'manual');
    updateButton();
  }
  function toggleShift() { isEnabled() ? stopShift('toggle') : startShift(); }

  // Backstops (kill-switch lives here in the webview; SPEC §8.1).
  function runtimeExceeded() {
    var max = liveCfg('maxRuntimeMs');
    if (!max) return false;
    var start = lsNum(LS.sessionStart, Date.now());
    var slept = lsNum(LS.sleptAccum, 0); // rate-limit sleep doesn't count
    return (Date.now() - start - slept) >= max;
  }
  function pingsExceeded() {
    var max = liveCfg('maxPings');
    return max > 0 && lsNum(LS.pingCount, 0) >= max;
  }

  function inQuietHours() {
    var q = (liveCfg('quietHours') || '').trim();
    if (!q) return false;
    var m = q.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) return false;
    var now = new Date();
    var cur = now.getHours() * 60 + now.getMinutes();
    var s = (+m[1]) * 60 + (+m[2]);
    var e = (+m[3]) * 60 + (+m[4]);
    return s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e); // crosses midnight
  }

  // ── Done detection (sentinel + output stall) ─────────────────────────────────
  var lastOutputSig = '';
  var stallCount = 0;
  var baseSentinel = 0;   // sentinel occurrences already present when the shift started
  var sentinelPings = 0;  // sentinels WE injected via our own ping instructions
  function outputSignature() {
    var t = panelText();
    return t.length + ':' + t.slice(-120);
  }
  function sentinelCount() {
    var t = panelText(), c = 0, i = 0;
    while ((i = t.indexOf(CFG.doneSentinel, i)) !== -1) { c++; i += CFG.doneSentinel.length; }
    return c;
  }
  // "Done" only if the sentinel appears MORE times than we injected — our own ping
  // text names the sentinel, so a naive substring match false-positives instantly.
  function sawDoneSentinel() {
    return CFG.sentinelDoneDetection && sentinelCount() > (baseSentinel + sentinelPings);
  }

  // ── User activity detection (don't fight a returning user) ───────────────────
  var lastUserActivity = 0;
  ['keydown', 'pointerdown'].forEach(function (evt) {
    document.addEventListener(evt, function (e) {
      if (weAreTyping) return; // ignore our own synthetic events
      // Only count activity INSIDE the input box — clicking our button or elsewhere
      // in the UI must not pause pinging.
      var inp = getInput();
      if (inp && e.target && (e.target === inp || inp.contains(e.target))) {
        lastUserActivity = Date.now();
      }
    }, true);
  });
  function userRecentlyActive() {
    return CFG.userActivityPauseMs > 0 && (Date.now() - lastUserActivity) < CFG.userActivityPauseMs;
  }

  // ── Main poll loop ───────────────────────────────────────────────────────────
  var lastPingAt = 0;      // last time we sent a continue-ping
  var lastSendAt = 0;      // last time we sent ANY text (anti double-fire)
  var lastPingSig = null;  // output signature captured right after our last ping
  function tick() {
    if (!isEnabled()) return;
    if (!isOwner()) return; // another panel owns this shift

    // Phase 3: always try to capture a real limit notice while a shift runs —
    // even during the sleep window below, since that's when it's on screen.
    captureRateLimitCandidate();

    // Hard backstops first.
    if (runtimeExceeded()) { stopShift('maxRuntime'); return; }
    if (pingsExceeded()) { stopShift('maxPings'); return; }

    // Rate-limit sleep window.
    var sleepUntil = lsNum(LS.sleepUntil, 0);
    if (sleepUntil && Date.now() < sleepUntil) { return; }
    if (sleepUntil && Date.now() >= sleepUntil) {
      // Wake: account the slept time so it doesn't burn maxRuntime.
      lsSet(LS.sleepUntil, '');
    }

    var state = detectState();
    log('state:', state);

    if (state === 'RATE_LIMITED') {
      enterSleep();
      return;
    }
    if (state === 'WORKING') { stallCount = 0; lastOutputSig = outputSignature(); return; }

    if (state === 'DONE' || sawDoneSentinel()) { stopShift('done-sentinel'); return; }

    if (state === 'WAITING_QUESTION') {
      if (CFG.onQuestion === 'answer') {
        maybePing(CFG.questionAnswer);
      } else {
        stopShift('question'); // leave the question for the user
      }
      return;
    }

    if (state === 'WAITING_CONTINUE') {
      // Act only at PING cadence — not every poll (counting stall per-poll wrongly
      // declared "done" within seconds and never pinged).
      if ((Date.now() - lastPingAt) < liveCfg('pingIntervalMs')) return;

      // Done heuristic: did output change since our previous ping? Only meaningful
      // once we've actually pinged at least once (lastPingSig !== null).
      var sig = outputSignature();
      if (lastPingSig !== null && sig === lastPingSig) {
        stallCount++;
        if (stallCount >= CFG.doneStallPings) { stopShift('output-stall'); return; }
      } else {
        stallCount = 0;
      }
      if (maybePing(buildPingText(), false)) {
        lastPingSig = outputSignature();
      }
    }
  }

  function maybePing(text) {
    if (userRecentlyActive()) { log('paused: user active'); return false; }
    if (inQuietHours()) { log('paused: quiet hours'); return false; }
    if (inputText() !== '') { log('paused: user draft in input'); return false; }
    if ((Date.now() - lastSendAt) < 3000) return false; // anti double-fire

    if (setInputAndSend(text)) {
      lastSendAt = Date.now();
      lastPingAt = Date.now();
      if (text.indexOf(CFG.doneSentinel) !== -1) sentinelPings++;
      lsSet(LS.pingCount, lsNum(LS.pingCount, 0) + 1);
      log('pinged:', text.slice(0, 40));
      return true;
    }
    return false;
  }

  function enterSleep() {
    var rl = detectRateLimit();
    var until = 0;
    if (rl && rl.captured) {
      var parsed = parseResetTime(rl.captured);
      if (parsed) until = parsed;
    }
    if (!until) until = Date.now() + CFG.rateLimitFallbackMs;
    // Accumulate slept time so maxRuntime ignores it.
    var slept = lsNum(LS.sleptAccum, 0) + Math.max(0, until - Date.now());
    lsSet(LS.sleptAccum, slept);
    lsSet(LS.sleepUntil, until);
    log('rate limited — sleeping until', new Date(until).toISOString());
  }

  // Parse a human reset time like "10:10pm (Asia/Jerusalem)" / "3:30 PM" / "15:30"
  // into a future timestamp. If an IANA "(Zone)" is present we resolve the time IN
  // that zone — correct worldwide, even when the user's OS clock is in a different
  // timezone than the one Claude reports. Without a zone we read it as local time.
  function parseResetTime(str) {
    if (!str) return 0;
    var s = String(str);
    var m = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (!m) return 0;
    var h = +m[1], min = +m[2];
    if (m[3]) { var pm = /pm/i.test(m[3]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }

    var tz = null;
    var tzm = s.match(/\(([A-Za-z]+(?:\/[A-Za-z0-9_+\-]+)+)\)/); // e.g. (Asia/Jerusalem)
    if (tzm && isValidTimeZone(tzm[1])) tz = tzm[1];

    var until = tz ? nextTimeInZone(h, min, tz) : nextLocalTime(h, min);
    if (!until) return 0;
    // jitter 30–120s so we don't all wake at the exact reset instant.
    return until + (30000 + Math.floor(Math.random() * 90000));
  }

  function nextLocalTime(h, min) {
    var d = new Date();
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); // already passed → tomorrow
    return d.getTime();
  }

  function isValidTimeZone(tz) {
    try { Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
  }

  // Offset (ms) between a tz's wall-clock reading of `epoch` and real UTC.
  function zoneOffsetMs(epoch, tz) {
    var dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    var p = {};
    dtf.formatToParts(new Date(epoch)).forEach(function (x) { p[x.type] = x.value; });
    var asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === '24' ? 0 : p.hour), +p.minute, +p.second);
    return asUTC - epoch;
  }

  // Epoch for the next occurrence of HH:MM in timezone `tz` (today there, else tomorrow).
  function nextTimeInZone(h, min, tz) {
    var now = Date.now();
    var dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    var p = {};
    dtf.formatToParts(new Date(now)).forEach(function (x) { p[x.type] = x.value; });
    for (var addDay = 0; addDay <= 1; addDay++) {
      var guess = Date.UTC(+p.year, +p.month - 1, +p.day + addDay, h, min, 0);
      var epoch = guess - zoneOffsetMs(guess, tz);
      epoch = guess - zoneOffsetMs(epoch, tz); // refine once for DST boundaries
      if (epoch > now) return epoch;
    }
    return 0;
  }

  // ── The ON/OFF button ─────────────────────────────────────────────────────────
  // ── Right-click settings popup ───────────────────────────────────────────────
  function closeSettingsPopup() {
    var p = document.getElementById('nonstop-settings');
    if (p) { if (p._cleanup) p._cleanup(); p.remove(); }
  }
  function showSettingsPopup(e) {
    closeSettingsPopup();
    var pop = document.createElement('div');
    pop.id = 'nonstop-settings';
    pop.style.cssText = 'position:fixed;z-index:999999;background:var(--vscode-editorWidget-background,#252526);' +
      'color:var(--vscode-editorWidget-foreground,#ccc);border:1px solid var(--vscode-editorWidget-border,#454545);' +
      'border-radius:6px;padding:10px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.4);min-width:240px;direction:ltr;';
    var x = Math.min(e.clientX, window.innerWidth - 270);
    var y = Math.min(e.clientY, window.innerHeight - 260);
    pop.style.left = Math.max(8, x) + 'px';
    pop.style.top = Math.max(8, y) + 'px';

    function row(label, inputEl) {
      var r = document.createElement('div');
      r.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin:4px 0;';
      var l = document.createElement('span'); l.textContent = label; l.style.whiteSpace = 'nowrap';
      r.appendChild(l); r.appendChild(inputEl); pop.appendChild(r);
    }
    function mkInput(type, val, w) {
      var i = document.createElement('input'); i.type = type; i.value = val;
      i.style.cssText = 'width:' + (w || 70) + 'px;background:var(--vscode-input-background,#3c3c3c);' +
        'color:inherit;border:1px solid var(--vscode-input-border,#555);border-radius:3px;padding:2px 4px;';
      return i;
    }

    var title = document.createElement('div');
    title.textContent = '♾️ Nonstop'; title.style.cssText = 'font-weight:bold;margin-bottom:2px;';
    pop.appendChild(title);
    var hint = document.createElement('div');
    hint.textContent = 'Auto-sends a message to keep Claude going, and waits out usage limits.';
    hint.style.cssText = 'opacity:.7;margin-bottom:8px;line-height:1.3;';
    pop.appendChild(hint);

    var interval = mkInput('number', Math.round(liveCfg('pingIntervalMs') / 1000));
    interval.min = 15;
    interval.title = 'How often to send the "keep going" message when Claude is idle.';
    interval.onchange = function () { setOverride('pingIntervalMs', Math.max(15, parseInt(interval.value, 10) || 60) * 1000); };
    row('Send a message every (sec)', interval);

    var ptext = mkInput('text', liveCfg('pingText'), 130);
    ptext.title = 'The text sent to Claude to continue (e.g. "continue").';
    ptext.onchange = function () { setOverride('pingText', ptext.value); };
    row('Message to send', ptext);

    var quiet = mkInput('text', liveCfg('quietHours') || '', 95);
    quiet.placeholder = '09:00-17:00';
    quiet.title = 'Optional. A window when Nonstop pauses and sends nothing — e.g. your work hours. Leave empty to run anytime, including overnight.';
    quiet.onchange = function () { setOverride('quietHours', quiet.value); };
    row('Pause during (optional)', quiet);

    var mp = mkInput('number', liveCfg('maxPings'));
    mp.title = 'Stop automatically after this many messages. 0 = no limit.';
    mp.onchange = function () { setOverride('maxPings', Math.max(0, parseInt(mp.value, 10) || 0)); };
    row('Stop after N messages (0=off)', mp);

    var mr = mkInput('number', Math.round(liveCfg('maxRuntimeMs') / 60000));
    mr.title = 'Stop automatically after running this long. 0 = no limit.';
    mr.onchange = function () { setOverride('maxRuntimeMs', Math.max(0, parseInt(mr.value, 10) || 0) * 60000); };
    row('Stop after (minutes, 0=off)', mr);

    var reset = document.createElement('button');
    reset.textContent = 'Reset to defaults';
    reset.style.cssText = 'margin-top:8px;width:100%;cursor:pointer;background:var(--vscode-button-secondaryBackground,#3a3d41);' +
      'color:var(--vscode-button-secondaryForeground,#ccc);border:none;border-radius:3px;padding:4px;';
    reset.onclick = function () {
      ['pingIntervalMs', 'pingText', 'quietHours', 'maxPings', 'maxRuntimeMs'].forEach(function (k) { setOverride(k, null); });
      closeSettingsPopup();
    };
    pop.appendChild(reset);

    document.body.appendChild(pop);

    function outside(ev) { if (!pop.contains(ev.target)) closeSettingsPopup(); }
    function esc(ev) { if (ev.key === 'Escape') closeSettingsPopup(); }
    pop._cleanup = function () {
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('keydown', esc, true);
    };
    setTimeout(function () {
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('keydown', esc, true);
    }, 0);
  }

  function ensureStyle() {
    if (document.getElementById('nonstop-style')) return;
    var st = document.createElement('style');
    st.id = 'nonstop-style';
    st.textContent =
      // Own wrapper so we sit as a self-contained item next to the mode button.
      '#nonstop-nav{display:inline-flex;align-items:center;}' +
      // OFF: greyed out & dim.
      '#nonstop-btn{background:transparent;border:none;cursor:pointer;font-size:15px;' +
      'padding:2px 6px;line-height:1;vertical-align:middle;' +
      'filter:grayscale(1) brightness(0.85);opacity:0.5;transition:opacity .15s,filter .15s;}' +
      '#nonstop-btn:hover{opacity:0.8;}' +
      // ON: full colour + glow + gentle pulse.
      '#nonstop-btn.ns-on{filter:none;opacity:1;animation:ns-pulse 1.8s ease-in-out infinite;}' +
      '@keyframes ns-pulse{0%,100%{transform:scale(1);filter:drop-shadow(0 0 0 transparent)}' +
      '50%{transform:scale(1.15);filter:drop-shadow(0 0 5px gold)}}';
    document.head.appendChild(st);
  }

  function injectButton() {
    if (document.getElementById('nonstop-btn')) return;
    var footer = $(SIGNALS.footer);
    if (!footer) return;
    ensureStyle();

    var btn = document.createElement('button');
    btn.id = 'nonstop-btn';
    btn.type = 'button';
    btn.title = 'Nonstop: keep Claude working (ping + wait out rate limits)';
    btn.textContent = '♾️';
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); toggleShift(); });
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); e.stopPropagation(); showSettingsPopup(e); });

    // Give the button its own wrapper and place it just to the LEFT of Claude's
    // native mode button (the "Auto mode" / permission picker) — present for every
    // user, no extension required. Fall back to the footer end.
    var wrap = document.createElement('div');
    wrap.id = 'nonstop-nav';
    wrap.appendChild(btn);
    var modeBtn = footer.querySelector(SIGNALS.modeButton);
    var modeContainer = modeBtn ? modeBtn.parentElement : null;
    if (modeContainer && modeContainer.parentNode) {
      modeContainer.parentNode.insertBefore(wrap, modeContainer);
    } else {
      footer.appendChild(wrap);
    }
    updateButton();
    log('button injected', modeContainer ? 'left of mode button' : 'at footer end');
  }
  function updateButton() {
    var btn = document.getElementById('nonstop-btn');
    if (!btn) return;
    var on = isEnabled() && isOwner();
    btn.classList.toggle('ns-on', on);
    btn.title = on ? 'Nonstop: ON (click to stop)' : 'Nonstop: OFF (click to start)';
  }

  // ── Boot ───────────────────────────────────────────────────────────────────────
  setInterval(injectButton, 1500); // re-inject if Claude re-renders the footer
  setInterval(sampleGrowth, CFG.pollMs); // always sample output growth for streaming detection
  setInterval(tick, CFG.pollMs);
  sampleGrowth();
  injectButton();

  // Debug heartbeat: log detected state periodically even when OFF, so the state
  // detector can be verified from the Console without picking the right iframe,
  // turning the shift on, or pasting anything. Gated behind debug mode.
  if (CFG.debug) {
    setInterval(function () {
      try {
        console.log('[Nonstop] heartbeat — state:', detectState(),
          '| streaming:', isStreaming(), '| enabled:', isEnabled(),
          '| inputEmpty:', inputText() === '', '| len:', panelLen());
      } catch (e) {
        console.log('[Nonstop] heartbeat error:', e && e.message);
      }
    }, 3000);
  }

  // Recon/debug handle for live tuning (only does anything in debug mode).
  window.__nonstopDebug = {
    state: detectState,
    rateLimit: detectRateLimit,
    input: getInput,
    config: CFG,
    instance: INSTANCE_ID,
    dumpFooter: function () { var f = $(SIGNALS.footer); return f ? f.outerHTML : '(no footer)'; },
    // Phase 3 helpers: read or clear the stashed real rate-limit notice.
    rateLimitCapture: function () { return lsGet(LS.rlCapture, '(none captured)'); },
    clearRateLimitCapture: function () { lsSet(LS.rlCapture, ''); return 'cleared'; },
  };

  log('initialized', { instance: INSTANCE_ID, debug: CFG.debug });
})();
