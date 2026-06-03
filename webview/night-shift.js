// Claude Code Night Shift — injected webview script.
// Runs inside the Claude Code panel DOM (appended to webview/index.js by the host).
// Wrapped in an IIFE so it never pollutes Claude's globals.
(function () {
  'use strict';

  // ── Config (seeded from the host via __NIGHTSHIFT_CONFIG__) ──────────────────
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
    doneSentinel: 'NIGHTSHIFT_DONE',
  };
  var CFG = Object.assign({}, DEFAULTS, (window.__NIGHTSHIFT_CONFIG__ || {}));

  // Guard against double-injection in the same document.
  if (window.__NIGHTSHIFT_ACTIVE__) return;
  window.__NIGHTSHIFT_ACTIVE__ = true;

  function log() {
    if (!CFG.debug) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[NightShift]');
    console.log.apply(console, args);
  }

  // ── localStorage state (survives reload; source of truth at runtime) ─────────
  var LS = {
    enabled: 'nightshift-enabled',
    sleepUntil: 'nightshift-sleep-until',
    sessionStart: 'nightshift-session-start',
    pingCount: 'nightshift-ping-count',
    ownerId: 'nightshift-owner-id',
    sleptAccum: 'nightshift-slept-accum-ms',
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
    primaryButtonContainer: '[class*="footerButtonPrimary_"]',
    // TUNE: indicators of an in-progress turn (stop/interrupt button, spinner).
    workingHints: ['[aria-label*="Stop" i]', '[aria-label*="Interrupt" i]', '[class*="streaming_"]', '[class*="loading_"]'],
    // TUNE: approval / question UI (YOLO in RTL keys off a Yes radio + Submit).
    questionHints: ['[role="radiogroup"]', '[class*="approval_"]', '[class*="permission_"]'],
    // TUNE: rate-limit message phrasing (server-streamed text, collected in Phase 3).
    rateLimitRegexes: [
      /usage limit reached.*reset/i,
      /\b\d+\s*-?\s*hour limit reached/i,
      /limit will reset at\s+(.+)/i,
      /resets?\s+at\s+(.+)/i,
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
    // TUNE: the actual send button selector. Try an aria-label, else the primary btn.
    return $('[aria-label*="Send" i]', footer) || $(SIGNALS.primaryButtonContainer + ' button', footer) || null;
  }

  function buildPingText() {
    if (CFG.sentinelDoneDetection) {
      return CFG.pingText + '\n\n(If the task is fully complete, reply with exactly: ' + CFG.doneSentinel + ')';
    }
    return CFG.pingText;
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
    if (!CFG.maxRuntimeMs) return false;
    var start = lsNum(LS.sessionStart, Date.now());
    var slept = lsNum(LS.sleptAccum, 0); // rate-limit sleep doesn't count
    return (Date.now() - start - slept) >= CFG.maxRuntimeMs;
  }
  function pingsExceeded() {
    return CFG.maxPings > 0 && lsNum(LS.pingCount, 0) >= CFG.maxPings;
  }

  function inQuietHours() {
    var q = (CFG.quietHours || '').trim();
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
      if ((Date.now() - lastPingAt) < CFG.pingIntervalMs) return;

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

  // Parse a human reset time like "3:30 PM" / "15:30" into a future timestamp.
  function parseResetTime(str) {
    if (!str) return 0;
    var m = String(str).match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (!m) return 0;
    var h = +m[1], min = +m[2];
    if (m[3]) { var pm = /pm/i.test(m[3]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
    var d = new Date();
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); // already passed → tomorrow
    // jitter 30–120s so we don't all wake at the exact reset instant.
    return d.getTime() + (30000 + Math.floor(Math.random() * 90000));
  }

  // ── The ON/OFF button ─────────────────────────────────────────────────────────
  function ensureStyle() {
    if (document.getElementById('nightshift-style')) return;
    var st = document.createElement('style');
    st.id = 'nightshift-style';
    st.textContent =
      // OFF: greyed out & dim (like the YOLO arm when off).
      '#nightshift-btn{background:transparent;border:none;cursor:pointer;font-size:15px;' +
      'padding:2px 6px;line-height:1;vertical-align:middle;' +
      'filter:grayscale(1) brightness(0.85);opacity:0.5;transition:opacity .15s,filter .15s;}' +
      '#nightshift-btn:hover{opacity:0.8;}' +
      // ON: full colour + glow + gentle pulse.
      '#nightshift-btn.ns-on{filter:none;opacity:1;animation:ns-pulse 1.8s ease-in-out infinite;}' +
      '@keyframes ns-pulse{0%,100%{transform:scale(1);filter:drop-shadow(0 0 0 transparent)}' +
      '50%{transform:scale(1.15);filter:drop-shadow(0 0 5px gold)}}';
    document.head.appendChild(st);
  }

  function injectButton() {
    if (document.getElementById('nightshift-btn')) return;
    var footer = $(SIGNALS.footer);
    if (!footer) return;
    ensureStyle();

    var btn = document.createElement('button');
    btn.id = 'nightshift-btn';
    btn.type = 'button';
    btn.title = 'Night Shift: keep Claude working (ping + wait out rate limits)';
    btn.textContent = '🌕';
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); toggleShift(); });

    // Prefer to sit right next to the RTL button group (the YOLO arm) as a sibling,
    // so it survives RTL re-rendering its own <nav>. Fall back to before the primary
    // (send/permission) container, then to the footer end.
    var rtlNav = footer.querySelector('#rtl-msg-nav') || document.getElementById('rtl-msg-nav');
    if (rtlNav && rtlNav.parentNode) {
      rtlNav.parentNode.insertBefore(btn, rtlNav.nextSibling);
    } else {
      var primary = footer.querySelector(SIGNALS.primaryButtonContainer);
      if (primary && primary.parentNode) primary.parentNode.insertBefore(btn, primary);
      else footer.appendChild(btn);
    }
    updateButton();
    log('button injected next to', rtlNav ? 'RTL nav' : 'footer primary');
  }
  function updateButton() {
    var btn = document.getElementById('nightshift-btn');
    if (!btn) return;
    var on = isEnabled() && isOwner();
    btn.classList.toggle('ns-on', on);
    btn.title = on ? 'Night Shift: ON (click to stop)' : 'Night Shift: OFF (click to start)';
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
        console.log('[NightShift] heartbeat — state:', detectState(),
          '| streaming:', isStreaming(), '| enabled:', isEnabled(),
          '| inputEmpty:', inputText() === '', '| len:', panelLen());
      } catch (e) {
        console.log('[NightShift] heartbeat error:', e && e.message);
      }
    }, 3000);
  }

  // Recon/debug handle for live tuning (only does anything in debug mode).
  window.__nightShiftDebug = {
    state: detectState,
    rateLimit: detectRateLimit,
    input: getInput,
    config: CFG,
    instance: INSTANCE_ID,
    dumpFooter: function () { var f = $(SIGNALS.footer); return f ? f.outerHTML : '(no footer)'; },
  };

  log('initialized', { instance: INSTANCE_ID, debug: CFG.debug });
})();
