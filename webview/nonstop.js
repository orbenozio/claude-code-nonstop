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
    // Legacy generic-question handling (kept for back-compat / postMessage-only path).
    onQuestion: 'stop',
    questionAnswer: 'continue, use your best judgment',
    // Permission prompts ("Allow this bash command?"): defer = let another approver
    // (e.g. the RTL extension's YOLO) or the user handle it; approve = auto-click Yes
    // after the grace window; stop = halt and leave it to the user.
    onPermission: 'defer',
    // How long to wait for another approver to clear a permission popup before we
    // apply onPermission. Set HIGHER than your YOLO auto-approve delay so YOLO wins.
    permissionGraceMs: 10000,
    // Decision prompts (Claude asks you to choose between options): stop = halt and
    // leave it (recommended); best-judgment = pick the last "Other" option + answer.
    onDecision: 'stop',
    decisionAnswer: 'use your best judgment',
    doneStallPings: 3,
    // After output stalls (looks done but no completion sentinel), retry the resume ping
    // this many more times with a growing backoff before finally stopping — so a transient
    // overnight failure to resume doesn't kill the shift. A real completion sentinel still
    // stops immediately. 0 = give up as soon as the stall threshold is hit (old behaviour).
    maxStallRetries: 4,
    sentinelDoneDetection: true,
    rateLimitFallbackMs: 18000000,
    userActivityPauseMs: 120000,
    debug: false,
    doneSentinel: 'NONSTOP_DONE',
    version: '', // extension version, seeded by the host — shown in the popup header
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
    ownerBeat: 'nonstop-owner-beat', // owner's lease heartbeat (epoch ms)
    sleptAccum: 'nonstop-slept-accum-ms',
    rlCapture: 'nonstop-rl-capture', // Phase 3: stashed real rate-limit notice
    lastStop: 'nonstop-last-stop',   // why/when the last shift ended (diagnostics)
    pendingRlSig: 'nonstop-pending-rl-sig', // signature of the limit we're currently sleeping out
    servedRl: 'nonstop-served-rl',   // signature of a limit we've ALREADY waited out (don't re-sleep it)
    lastPing: 'nonstop-last-ping',   // the exact text we last typed (survives reload — see inputIsForeign)
  };
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) {} }
  function lsNum(k, d) { var n = parseInt(lsGet(k, ''), 10); return isNaN(n) ? d : n; }
  function isEnabled() { return lsGet(LS.enabled, 'false') === 'true'; }

  // Unique id for this webview instance (ownership for multi-panel; SPEC §4.7).
  var INSTANCE_ID = 'ns-' + Math.random().toString(36).slice(2) + '-' + Date.now();
  // Ownership is a heartbeat lease: the active panel renews LS.ownerBeat every tick.
  // If the owner's beat goes stale (e.g. it was reloaded/closed), another live panel
  // takes over — so an enabled shift never gets orphaned by a reload.
  var OWNER_LEASE_MS = 8000;
  function isOwner() { return lsGet(LS.ownerId, '') === INSTANCE_ID; }
  function ownerAlive() {
    var beat = lsNum(LS.ownerBeat, 0);
    return beat > 0 && (Date.now() - beat) < OWNER_LEASE_MS;
  }
  // Become/stay owner if it's mine, unowned, or the current owner's lease expired.
  function claimOwnership() {
    if (isOwner() || !lsGet(LS.ownerId, '') || !ownerAlive()) {
      lsSet(LS.ownerId, INSTANCE_ID);
      lsSet(LS.ownerBeat, Date.now());
      return true;
    }
    return false; // another LIVE panel owns the shift
  }

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
    // Claude's real send/submit control: <button type="submit" class="sendButton_…">,
    // no aria-label (verified against the live bundle). Doubles as Stop while busy.
    sendButton: 'button[class*="sendButton_"]',
    // The conversation transcript scroll region (Claude's messages container). We scan
    // THIS, not document.body, so the detectors never see Claude's footer chrome — its
    // usage meter renders the literal strings "usage limits" / "Resets <time>" which sit
    // at the end of body (inside our -4000 tail) and would false-trip looksRateLimited().
    // The real "hit your … limit · resets <time>" notice renders inside the transcript,
    // so scoping here keeps detection intact while dropping the chrome. Cheaper too.
    transcript: '[class*="messagesContainer_"]',
    // TUNE: indicators of an in-progress turn (stop/interrupt button, spinner).
    workingHints: ['[aria-label*="Stop" i]', '[aria-label*="Interrupt" i]', '[class*="streaming_"]', '[class*="loading_"]'],
    // Permission AND decision popups share this outer container (verified against the
    // live panel 2026-06). The inner content disambiguates them — see detectPopup().
    popupRoot: '[class*="permissionRequestContainer_"]',
    // A DECISION popup (choose-an-option) renders role="radio" options inside an
    // options/questions container. A PERMISSION popup ("Allow this command?") does not.
    decisionHints: ['[role="radio"]', '[class*="optionsContainer_"]', '[class*="questionsContainer_"]'],
    // Action buttons live in this container; the FIRST one is the safe "Yes" (allow
    // once), not "Yes, for all projects". Used to auto-approve when onPermission=approve.
    popupButtons: '[class*="buttonContainer_"] button',
    // Real format (captured live): "You've hit your session limit · resets 10:10pm (Asia/Jerusalem)".
    // ⚠ These are the ONLY patterns allowed to put a shift to sleep, so they must NOT
    // match ordinary conversation that merely *mentions* a limit or a reset time (a
    // bare "resets 10:10pm" in chat — e.g. while debugging this very feature — used to
    // false-trigger a silent multi-hour sleep). Each one therefore requires the canonical
    // "hit/reached your <session|usage|rate> limit" NOTICE structure. The first also
    // captures the reset time (m[1]) for parseResetTime; the others flag a limit and let
    // enterSleep() extract the time via resetTimeRegexes below.
    rateLimitRegexes: [
      /hit your (?:session|usage|rate) limit[\s\S]{0,80}?resets?\s+(\d{1,2}:\d{2}\s*[ap]m\b(?:\s*\([^)]+\))?)/i,
      /\b\d+\s*-?\s*hour limit reached/i,
      /(?:hit|reached)[^\n]{0,30}\b(?:session|usage|rate) limit/i,
    ],
    // Loose time extractors — used ONLY to pull a reset time AFTER a notice above has
    // already confirmed a real limit. Never trigger sleep on their own (that's the bug
    // that the strict rateLimitRegexes set fixes), so a stray "resets <time>" in chat
    // is harmless here.
    resetTimeRegexes: [
      /\bresets?\s+(?:at\s+)?(\d{1,2}:\d{2}\s*[ap]m\b(?:\s*\([^)]+\))?)/i,
      /limit will reset at\s+(\d{1,2}:\d{2}\s*[ap]m\b(?:\s*\([^)]+\))?)/i,
    ],
  };

  // postMessage observation (best-effort; SPEC/RECON §1 — host→webview state msgs).
  // There is no host->webview channel in the MVP, so this is speculative infrastructure.
  // It runs inside Claude's webview document, where any other script (a sibling injector,
  // an iframe, page content) could postMessage a forged {state:'running'} to suppress our
  // pings — or {state:'waiting_input'} to force one. We therefore accept ONLY messages that
  // carry our namespace marker (__nonstop:true), which a real host channel would send and a
  // stray/hostile postMessage won't. Until that channel exists this layer simply stays inert.
  var observedState = null; // 'running' | 'waiting_input' | 'idle'
  var observedStateAt = 0;
  window.addEventListener('message', function (ev) {
    var d = ev && ev.data;
    if (!d || typeof d !== 'object') return;
    if (d.__nonstop !== true) return; // reject anything not explicitly addressed to us
    var st = d.state || (d.payload && d.payload.state);
    if (st === 'running' || st === 'waiting_input' || st === 'idle') {
      observedState = st;
      observedStateAt = Date.now();
      log('observed state via message:', st);
    }
  });

  function $(sel, root) { try { return (root || document).querySelector(sel); } catch (e) { return null; } }

  // Our own injected DOM must NEVER count as a Claude state signal. (Our ♾️ button's
  // aria-label "Nonstop" contains the substring "stop", so [aria-label*="Stop" i] in
  // workingHints matched it and pegged detectState to WORKING forever → no ping ever
  // fired while the shift was on. Same class of self-reference bug as the rate-limit
  // text scan.) Skip anything inside our injected wrappers.
  // Anything inside the shared #orb-tools toolbar (our ♾️ button or a sibling tool's
  // button) or our settings popup is injected UI — never a Claude state signal.
  function isOurNode(el) {
    return !!(el && el.closest && el.closest('#orb-tools, #nonstop-settings'));
  }
  function isVisible(el) {
    return !!(el && (el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length)));
  }

  // First element matching any selector that is NOT ours and is actually visible. A real
  // working indicator (stop/interrupt button, spinner) is on-screen; a hidden or
  // self-injected match is not a signal. isStreaming() is the primary WORKING signal, so
  // being strict here is safe — genuine generation is still caught by output growth.
  function matchAny(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var els;
      try { els = document.querySelectorAll(selectors[i]); } catch (e) { continue; }
      for (var j = 0; j < els.length; j++) {
        if (!isOurNode(els[j]) && isVisible(els[j])) return els[j];
      }
    }
    return null;
  }

  function getInput() { return $(SIGNALS.input); }
  function inputText() { var el = getInput(); return el ? (el.textContent || '').trim() : ''; }

  // The DOM subtree the detectors scan. Prefer Claude's transcript container (excludes
  // the footer chrome whose usage meter would false-trip the rate-limit detectors, and a
  // smaller subtree is cheaper). Fall back to document.body if the selector ever breaks
  // (graceful degradation — detection keeps working, just wider).
  function scanRoot() { return $(SIGNALS.transcript) || document.body; }

  // Bounded scan of the conversation area for rate-limit / sentinel detection.
  // Uses textContent (NOT innerText): innerText forces a synchronous reflow of the
  // whole growing transcript on every call, and tick() calls this 5–8× per second on
  // the SAME main thread as Claude's UI — that reflow storm is what periodically froze
  // the panel ("no response"), worsening as the conversation grew. textContent reads
  // the same characters with zero layout. All consumers .slice(-4000) and regex-match,
  // so the rendered-vs-raw difference is immaterial.
  // Memoized for a short window so the many calls within one tick materialize the
  // (still large) string only once instead of 5–8 times.
  var _ptCache = '', _ptAt = 0;
  function panelText() {
    var now = Date.now();
    if (now - _ptAt < 250 && _ptAt !== 0) return _ptCache;
    var root = scanRoot();
    _ptCache = (root && root.textContent) || '';
    _ptAt = now;
    return _ptCache;
  }

  // Cheap length probe (textContent triggers no layout) for streaming detection.
  // Same scope as panelText so footer-meter ticks never read as Claude "streaming".
  function panelLen() {
    var root = scanRoot();
    return (root && root.textContent || '').length;
  }

  // ── Streaming detection by output growth (selector-independent, robust) ───────
  // If the conversation's text is actively growing, Claude is generating → WORKING.
  // This is what a human sees ("it's still typing"), and survives DOM/class churn.
  var lastLen = -1;
  var lastGrowthAt = 0;
  function sampleGrowth() {
    // No shift running → don't materialize the whole transcript every second.
    if (!isEnabled()) { lastLen = -1; return; }
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

  // Last (freshest) match of `re` in `text`. The newest notice sits at the BOTTOM of the
  // transcript, so with two limit notices we want the later one's reset time — an earlier
  // notice may carry an already-past time that would otherwise sleep us ~24h.
  function lastMatch(text, re) {
    var g = new RegExp(re.source, re.flags.indexOf('g') === -1 ? re.flags + 'g' : re.flags);
    var m, last = null;
    while ((m = g.exec(text)) !== null) {
      last = m;
      if (m.index === g.lastIndex) g.lastIndex++; // guard zero-width matches
    }
    return last;
  }

  function detectRateLimit() {
    var text = panelText();
    if (!text) return null;
    // Only look at the tail (most recent messages) to limit cost / false hits.
    var tail = text.slice(-4000);
    for (var i = 0; i < SIGNALS.rateLimitRegexes.length; i++) {
      var m = lastMatch(tail, SIGNALS.rateLimitRegexes[i]); // freshest occurrence, not the first
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

  // Safety net — true if the panel tail looks like a usage/rate-limit notice, even when
  // the precise detectRateLimit() regex didn't match. Used so a real limit is never
  // mistaken for "task done" and the shift killed. Deliberately WIDER than detectRateLimit
  // (which gates proactive sleeping) but NARROWER than RL_CAPTURE_RE: every alternative is
  // anchored on the word "limit" (or an unambiguous limit phrase), so a stray "resets
  // 10:10pm" or "429" in ordinary chat no longer trips it. (A transcript that literally
  // discusses "session limit" can still match — the only airtight fix is anchoring on the
  // notice DOM element, which needs a verified selector; tracked as future work.)
  var LOOKS_LIMITED_RE = /(?:session|usage|rate|hour)[\s-]*limit|limit\s*(?:reached|will\s*reset|reset)|too many requests|approaching your usage/i;
  function looksRateLimited() {
    var text = panelText();
    return !!text && LOOKS_LIMITED_RE.test(text.slice(-4000));
  }

  // A stable id for the limit notice CURRENTLY on screen. The limit message stays in
  // the transcript after its reset time passes, so without this we'd re-detect the same
  // notice on wake, re-parse its now-past reset time to the NEXT day, and silently sleep
  // ~24h instead of resuming. We remember the signature we slept out (LS.servedRl) and
  // suppress re-sleeping while the same notice is still showing.
  // Prefer the reset time (changes per limit window); fall back to a snippet of the notice
  // so a fixed-window notice (no time) isn't re-slept forever either.
  function rateLimitSignature() {
    var rl = detectRateLimit();
    if (rl && rl.captured) return 't:' + rl.captured;
    var tail = (panelText() || '').slice(-4000);
    for (var i = 0; i < SIGNALS.resetTimeRegexes.length; i++) {
      var m = lastMatch(tail, SIGNALS.resetTimeRegexes[i]);
      if (m) return 't:' + m[1];
    }
    var idx = tail.search(LOOKS_LIMITED_RE);
    if (idx >= 0) {
      // Fixed-window notice with no reset time: key only on the limit PHRASE, stripped of
      // digits/punctuation. The raw snippet shifts as the transcript scrolls between sleep
      // and wake, which would change the signature and let the ~24h re-sleep bug back in;
      // normalising to just the lowercase letters keeps it stable across that movement.
      var norm = tail.slice(idx, idx + 80).toLowerCase().replace(/[^a-z]+/g, ' ').replace(/\s+/g, ' ').trim();
      return 's:' + norm;
    }
    return '';
  }

  // Classify a visible interaction popup. Permission and decision popups share the
  // same outer container (SIGNALS.popupRoot); a decision popup is the one that also
  // contains the choose-an-option structure (role="radio" / optionsContainer_).
  // Returns 'DECISION' | 'PERMISSION' | null (no popup).
  function detectPopup() {
    var root = $(SIGNALS.popupRoot);
    if (!root) return null;
    for (var i = 0; i < SIGNALS.decisionHints.length; i++) {
      if ($(SIGNALS.decisionHints[i], root)) return 'DECISION';
    }
    return 'PERMISSION';
  }

  // Returns one of WORKING / WAITING_PERMISSION / WAITING_DECISION / WAITING_QUESTION
  // / WAITING_CONTINUE / RATE_LIMITED / DONE / UNKNOWN
  function detectState(ignoreRateLimit) {
    // Layer 0: rate limit takes precedence (so we never ping into a wall). Skipped when
    // we've already slept out THIS notice (ignoreRateLimit) — otherwise the persistent
    // on-screen notice would re-sleep us instead of letting the resume ping through.
    if (!ignoreRateLimit && detectRateLimit()) return 'RATE_LIMITED';

    // Layer 0.5: output is actively growing → Claude is generating. Primary,
    // selector-independent WORKING signal.
    if (isStreaming()) return 'WORKING';

    // Layer 1: a visible popup is a concrete DOM signal — most reliable when present.
    var popup = detectPopup();
    if (popup === 'PERMISSION') return 'WAITING_PERMISSION';
    if (popup === 'DECISION') return 'WAITING_DECISION';

    // Layer 2: observed postMessage state (fresh only).
    if (observedState && (Date.now() - observedStateAt) < 5000) {
      if (observedState === 'running') return 'WORKING';
      // waiting_input with no classified popup above = Claude finished its turn and is
      // waiting on us → exactly when we want to nudge "continue".
      if (observedState === 'waiting_input') return 'WAITING_CONTINUE';
      // idle
      return inputText() === '' ? 'WAITING_CONTINUE' : 'UNKNOWN';
    }

    // Layer 3: DOM reflection.
    if (matchAny(SIGNALS.workingHints)) return 'WORKING';

    // Layer 4: heuristic — input present and holding nothing foreign (empty, or only our own
    // stranded ping) = ready to (re)ping. Treating our own stuck ping as WAITING_CONTINUE is
    // what actually lets a reloaded panel clear and resend it: LS.lastPing makes the
    // not-foreign check survive the reload, and setInputAndSend re-guards inputIsForeign right
    // before it clears, so a genuine user draft is still never touched.
    var input = getInput();
    if (input && !inputIsForeign()) return 'WAITING_CONTINUE';
    return 'UNKNOWN';
  }

  // ── Popup handling: permission (approve/defer/stop) and decision (stop/answer) ──
  var permissionSig = '';        // identity of the permission popup we're timing
  var permissionSeenAt = 0;      // when that popup first appeared (grace clock)
  var permissionHandledSig = ''; // a popup we already auto-approved (don't double-click)
  var decisionSeenAt = 0;        // when the current decision popup first appeared

  // Stable-ish identity of the current popup, so a NEW popup restarts the grace clock
  // and a lingering one isn't acted on twice.
  function popupSignature() {
    var root = $(SIGNALS.popupRoot);
    if (!root) return '';
    return (root.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  // Click the first action button (the safe "Yes" / allow-once) in a permission popup.
  function approvePermission() {
    var root = $(SIGNALS.popupRoot);
    if (!root) return false;
    var btn = root.querySelector(SIGNALS.popupButtons) || root.querySelector('button');
    if (!btn) { log('approve: no button found in popup'); return false; }
    weAreTyping = true; // suppress our own click from user-activity detection
    try { btn.click(); } finally { setTimeout(function () { weAreTyping = false; }, 250); }
    return true;
  }

  function handlePermission() {
    var mode = liveCfg('onPermission'); // defer | approve | stop
    if (mode === 'defer') return; // never touch it — another approver or the user owns it

    var sig = popupSignature();
    if (sig !== permissionSig) { // a new/changed permission popup → (re)start the grace clock
      permissionSig = sig;
      permissionSeenAt = Date.now();
    }
    // Grace: let any other approver (e.g. YOLO) clear it first. If it disappears within
    // the window we never get here again for this popup, so we never interfere.
    if ((Date.now() - permissionSeenAt) < liveCfg('permissionGraceMs')) return;

    if (mode === 'stop') { stopShift('permission'); return; }

    // mode === 'approve': click Yes once per popup.
    if (sig && sig === permissionHandledSig) return;
    if (approvePermission()) { permissionHandledSig = sig; log('permission auto-approved'); }
  }

  // best-judgment: select the last option ("Other"), type the answer into the revealed
  // free-text field, then Submit. Returns true once submitted. Defensive: the revealed
  // field's exact class is unverified, so we scope to any contenteditable inside the
  // popup and only submit when the Submit button has become enabled.
  function answerDecisionBestJudgment() {
    var root = $(SIGNALS.popupRoot);
    if (!root) return false;
    var options = root.querySelectorAll('[role="radio"]');
    if (!options.length) return false;
    weAreTyping = true;
    try {
      var other = options[options.length - 1]; // "Other" is always the last option
      if (other.getAttribute('aria-checked') !== 'true') other.click();
      var field = root.querySelector('[contenteditable]');
      if (field) {
        field.focus();
        try { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); } catch (e) {}
        var txt = liveCfg('decisionAnswer');
        try {
          if (!document.execCommand('insertText', false, txt)) field.textContent = txt;
        } catch (e) { field.textContent = txt; }
      }
      var submit = root.querySelector(SIGNALS.popupButtons);
      if (submit && !submit.disabled) { submit.click(); return true; }
      return false; // submit not enabled yet — try again next tick
    } finally {
      setTimeout(function () { weAreTyping = false; }, 250);
    }
  }

  function handleDecision() {
    if (liveCfg('onDecision') === 'best-judgment') {
      if (!decisionSeenAt) decisionSeenAt = Date.now();
      if (answerDecisionBestJudgment()) { decisionSeenAt = 0; return; }
      // Couldn't complete the answer yet — give it a short window, then fall back to
      // stopping so we never spin silently on a popup we can't drive.
      if ((Date.now() - decisionSeenAt) < 6000) return;
    }
    stopShift('decision'); // default: leave the choice to the user
  }

  // ── Sending text into the contenteditable input ──────────────────────────────
  var weAreTyping = false;
  var lastInsertedText = ''; // the exact text WE last typed into the box (a ping)

  // Text in the input that we did NOT put there = a user draft. Our own previously
  // injected ping that got stuck (e.g. a submit that didn't take) is NOT foreign, so
  // we can still clear/resend it. This is the guard that stops us from selectAll+delete
  // -ing a request the user is mid-typing — which used to wipe it unrecoverably (Claude
  // keeps the draft only in memory, so a reload lost it: "my request wasn't captured").
  //
  // lastInsertedText is in-memory and resets to '' on reload. If the panel reloads while
  // our ping is stranded in the box, the in-memory value is gone and the ping would read
  // as a foreign user draft — blocked forever (never cleared, never resent). So we fall
  // back to the persisted copy (LS.lastPing) to still recognise our own stuck ping.
  function inputIsForeign() {
    var t = inputText();
    if (t === '') return false;
    var mine = (lastInsertedText || lsGet(LS.lastPing, '') || '').trim();
    return t !== mine;
  }

  function setInputAndSend(text) {
    var input = getInput();
    if (!input) { log('no input box found'); return false; }
    // Re-check RIGHT before we clear — closes the time-of-check/time-of-use race where
    // the user starts typing between maybePing()'s guard and this wipe.
    if (inputIsForeign()) { log('abort send: user draft in input'); return false; }
    weAreTyping = true;
    try {
      input.focus();
      // Clear any leftover (e.g. a previous failed send that became a newline, or our
      // own stuck ping). Safe now: a foreign user draft was rejected just above.
      try { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); } catch (e) {}
      var ok = false;
      try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
      if (!ok) {
        // Fallback: synthetic InputEvent.
        input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }));
        input.textContent = text;
        input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
      }
      lastInsertedText = text; // remember it's ours, so a stuck copy isn't read as a user draft
      lsSet(LS.lastPing, text); // persist it too, so a reload still recognises our own stuck ping
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
    // Claude's real submit control is a <button type="submit" class="sendButton_…">
    // with NO aria-label (confirmed against the live bundle). The old [aria-label*="Send"]
    // selector therefore NEVER matched, so every ping fell back to a synthetic Enter —
    // fragile (untrusted key events can be dropped, stranding the ping text in the box).
    // Prefer the real button; scope to the footer, fall back to document-wide.
    var footer = $(SIGNALS.footer);
    var btn = (footer && $(SIGNALS.sendButton, footer)) || $(SIGNALS.sendButton);
    // While Claude is busy this same button acts as Stop/interrupt — never click it then
    // (we only get here in WAITING_CONTINUE, but guard anyway so a mid-turn race can't
    // interrupt Claude). disabled also means nothing to send.
    if (btn && !btn.disabled && !isStreaming()) return btn;
    return null;
  }

  function buildPingText() {
    var txt = liveCfg('pingText');
    if (CFG.sentinelDoneDetection) {
      // Keep it on one line with a space separator — line breaks get stripped when
      // the text is inserted into the plaintext input.
      return txt + ' - reply ' + CFG.doneSentinel + ' when fully done';
    }
    return txt;
  }

  // ── Shift lifecycle ──────────────────────────────────────────────────────────
  function startShift() {
    lsSet(LS.enabled, 'true');
    lsSet(LS.ownerId, INSTANCE_ID);
    lsSet(LS.ownerBeat, Date.now());
    lsSet(LS.sessionStart, Date.now());
    lsSet(LS.pingCount, 0);
    lsSet(LS.sleptAccum, 0);
    lsSet(LS.sleepUntil, '');
    lsSet(LS.pendingRlSig, '');
    lsSet(LS.servedRl, '');
    // Reset in-memory ping/stall state for a fresh shift.
    stallCount = 0; stallRetries = 0; lastPingSig = null; lastPingAt = 0; lastSendAt = 0; lastGrowthAt = 0;
    baseSentinel = sentinelCount(); sentinelPings = 0;
    log('shift started; owner', INSTANCE_ID);
    updateButton();
  }
  function stopShift(reason) {
    lsSet(LS.enabled, 'false');
    lsSet(LS.sleepUntil, '');
    // Release ownership so a stale beat pointing at this (now-idle) instance can't briefly
    // block another panel from taking a fresh shift.
    if (isOwner()) { lsSet(LS.ownerId, ''); lsSet(LS.ownerBeat, 0); }
    lsSet(LS.lastStop, (reason || 'manual') + ' @ ' + new Date().toISOString());
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
  var stallCount = 0;
  var stallRetries = 0;   // how many growing-backoff resume retries we've spent on this stall
  var STALL_MAX_INTERVAL_MS = 900000; // cap the backoff growth at 15 min between resume tries
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
  // 'input' is included so any actual text change the user makes registers as activity
  // even if its keydown was missed (e.g. paste, IME, or a dropped key during jank).
  ['keydown', 'pointerdown', 'input'].forEach(function (evt) {
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
    if (!claimOwnership()) return; // another LIVE panel owns this shift

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
      // Mark the limit we just waited out. Its notice is still on screen, so without this
      // the next detectState() would re-sleep us to the SAME (now-past → tomorrow) reset
      // time and the shift would never resume. Make a resume ping eligible immediately.
      var served = lsGet(LS.pendingRlSig, '');
      if (served) lsSet(LS.servedRl, served);
      lsSet(LS.pendingRlSig, '');
      lastPingAt = 0;
    }

    // Have we already waited out the limit notice that's still showing? If so, ignore it
    // for state detection (resume) instead of treating it as a fresh wall to sleep behind.
    var rlSig = rateLimitSignature();
    var servedSig = lsGet(LS.servedRl, '');
    var alreadyServed = !!rlSig && rlSig === servedSig;
    // Self-clean: once the served notice has scrolled out of the tail, forget it so a
    // genuinely new limit with the same reset-time string is still honored.
    if (servedSig && !rlSig) { lsSet(LS.servedRl, ''); }

    var state = detectState(alreadyServed);
    log('state:', state);

    // Reset the popup grace clocks whenever the matching popup isn't on screen, so a
    // future popup starts its grace window fresh.
    if (state !== 'WAITING_PERMISSION') { permissionSig = ''; permissionSeenAt = 0; }
    if (state !== 'WAITING_DECISION') { decisionSeenAt = 0; }

    if (state === 'RATE_LIMITED') {
      enterSleep();
      return;
    }
    if (state === 'WORKING') { stallCount = 0; stallRetries = 0; return; }

    if (state === 'DONE' || sawDoneSentinel()) { stopShift('done-sentinel'); return; }

    if (state === 'WAITING_PERMISSION') { handlePermission(); return; }
    if (state === 'WAITING_DECISION') { handleDecision(); return; }

    if (state === 'WAITING_QUESTION') {
      // Legacy generic-question path (only reachable via postMessage without a popup).
      if (CFG.onQuestion === 'answer') {
        maybePing(CFG.questionAnswer);
      } else {
        stopShift('question'); // leave the question for the user
      }
      return;
    }

    if (state === 'WAITING_CONTINUE') {
      // Act only at PING cadence — not every poll (counting stall per-poll wrongly
      // declared "done" within seconds and never pinged). While we're in stall-retry
      // backoff the interval grows (2x per retry, capped) so repeated failed resume
      // attempts space out instead of hammering; a fresh, progressing shift uses the base.
      var effInterval = Math.min(liveCfg('pingIntervalMs') * Math.pow(2, stallRetries), STALL_MAX_INTERVAL_MS);
      if ((Date.now() - lastPingAt) < effInterval) return;

      // Done heuristic: did output change since our previous ping? Only meaningful
      // once we've actually pinged at least once (lastPingSig !== null).
      var sig = outputSignature();
      if (lastPingSig !== null && sig === lastPingSig) {
        stallCount++;
        if (stallCount >= CFG.doneStallPings) {
          // Output stopped growing. Before declaring "done", make sure this isn't a
          // rate limit that the precise detector missed — otherwise we'd kill the
          // shift mid-limit and never resume after the reset. But NOT if this is the
          // notice we already slept out (alreadyServed): re-sleeping it is the ~24h
          // silent-sleep bug. There, a real stall just means resume didn't take → stop.
          if (looksRateLimited() && !alreadyServed) {
            log('stall looks like a rate limit — sleeping instead of stopping');
            stallCount = 0;
            enterSleep();
            return;
          }
          // Not a limit. Rather than give up immediately, retry the resume a few times with
          // a growing backoff (the effInterval above) — a transient overnight failure to
          // resume shouldn't end an unattended shift. A real completion sentinel still stops
          // instantly (handled above as DONE), and maxRuntime/maxPings still cap us.
          if (stallRetries < liveCfg('maxStallRetries')) {
            stallRetries++;
            stallCount = 0;
            log('output stalled — resume retry', stallRetries, 'of', liveCfg('maxStallRetries'), '(backoff grows)');
            // fall through and ping again this tick
          } else {
            stopShift('output-stall');
            return;
          }
        }
      } else {
        stallCount = 0;
        stallRetries = 0; // real progress → reset the backoff escalation
      }
      if (maybePing(buildPingText())) {
        lastPingSig = outputSignature();
      }
    }
  }

  function maybePing(text) {
    if (userRecentlyActive()) { log('paused: user active'); return false; }
    if (inQuietHours()) { log('paused: quiet hours'); return false; }
    if (inputIsForeign()) { log('paused: user draft in input'); return false; }
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
    if (!until) {
      // Precise detect confirmed a limit but didn't capture the time — pull a reset time
      // out of the tail via the loose extractors before falling back to the fixed window.
      // Safe here because we only reach enterSleep once a real limit was already detected.
      var tail = (panelText() || '').slice(-4000);
      for (var i = 0; i < SIGNALS.resetTimeRegexes.length; i++) {
        var m = tail.match(SIGNALS.resetTimeRegexes[i]);
        if (m) { var p2 = parseResetTime(m[1]); if (p2) { until = p2; break; } }
      }
    }
    if (!until) until = Date.now() + CFG.rateLimitFallbackMs;
    // Accumulate slept time so maxRuntime ignores it.
    var slept = lsNum(LS.sleptAccum, 0) + Math.max(0, until - Date.now());
    lsSet(LS.sleptAccum, slept);
    lsSet(LS.sleepUntil, until);
    // Remember which notice we're sleeping out, so on wake we don't re-sleep the same one.
    lsSet(LS.pendingRlSig, rateLimitSignature());
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
  var _settingsOpener = null; // element to restore focus to when the popup closes
  function closeSettingsPopup() {
    var p = document.getElementById('nonstop-settings');
    if (p) {
      if (p._cleanup) p._cleanup();
      p.remove();
      // Return focus to whatever opened the popup (the button), so keyboard users aren't dropped.
      try { if (_settingsOpener && _settingsOpener.focus) _settingsOpener.focus(); } catch (e) {}
      _settingsOpener = null;
    }
  }
  function showSettingsPopup(e) {
    closeSettingsPopup();
    // Anchor: the pointer position for a right-click, or the button's corner when opened
    // from the keyboard (no pointer coords). Remember the opener to restore focus on close.
    var btn = document.getElementById('nonstop-btn');
    _settingsOpener = (document.activeElement && document.activeElement.focus) ? document.activeElement : btn;
    var ax, ay;
    if (e && typeof e.clientX === 'number' && (e.clientX || e.clientY)) { ax = e.clientX; ay = e.clientY; }
    else if (btn && btn.getBoundingClientRect) { var br = btn.getBoundingClientRect(); ax = br.left; ay = br.top; }
    else { ax = 100; ay = 100; }

    var pop = document.createElement('div');
    pop.id = 'nonstop-settings';
    // Dialog semantics so screen readers announce it and Esc/focus management make sense.
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'true');
    pop.setAttribute('aria-label', 'Nonstop settings');
    pop.tabIndex = -1; // focusable container so we can move focus into the dialog on open
    pop.style.cssText = 'position:fixed;z-index:999999;background:var(--vscode-editorWidget-background,#252526);' +
      'color:var(--vscode-editorWidget-foreground,#ccc);border:1px solid var(--vscode-editorWidget-border,#454545);' +
      'border-radius:6px;padding:10px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.4);min-width:240px;direction:ltr;';
    var x = Math.min(ax, window.innerWidth - 270);
    var y = Math.min(ay, window.innerHeight - 260);
    pop.style.left = Math.max(8, x) + 'px';
    pop.style.top = Math.max(8, y) + 'px';

    function row(label, inputEl) {
      var r = document.createElement('div');
      r.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin:4px 0;';
      var l = document.createElement('span'); l.textContent = label; l.style.whiteSpace = 'nowrap';
      // Name the field for assistive tech (each row is just a span + control, no <label for>).
      if (inputEl && !inputEl.getAttribute('aria-label')) inputEl.setAttribute('aria-label', label);
      r.appendChild(l); r.appendChild(inputEl); pop.appendChild(r);
    }
    // All inputs and selects share one width (border-box) so their right edges line up.
    var FIELD_W = 120;
    var fieldCss = 'width:' + FIELD_W + 'px;box-sizing:border-box;background:var(--vscode-input-background,#3c3c3c);' +
      'color:inherit;border:1px solid var(--vscode-input-border,#555);border-radius:3px;padding:2px 4px;';
    function mkInput(type, val) {
      var i = document.createElement('input'); i.type = type; i.value = val;
      i.style.cssText = fieldCss;
      return i;
    }
    function mkSelect(opts, val) {
      var s = document.createElement('select');
      s.style.cssText = fieldCss;
      opts.forEach(function (o) {
        var op = document.createElement('option');
        op.value = o; op.textContent = o; if (o === val) op.selected = true;
        s.appendChild(op);
      });
      return s;
    }

    var title = document.createElement('div');
    title.style.cssText = 'font-weight:bold;margin-bottom:2px;display:flex;align-items:center;gap:5px;';
    // Same infinity glyph as the button (the ♾️ emoji rendered grey/unreliably in the webview).
    title.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">' +
      '<path d="M18.6 6.62c-1.44 0-2.8.56-3.77 1.53L12 10.66 10.48 12h.01L7.8 14.39c-.64.64-1.49.99-2.4.99-1.87 0-3.39-1.51-3.39-3.38S3.53 8.62 5.4 8.62c.91 0 1.76.35 2.44 1.03l1.13 1 1.51-1.34L9.22 8.2C8.2 7.18 6.84 6.62 5.4 6.62 2.42 6.62 0 9.04 0 12s2.42 5.38 5.4 5.38c1.44 0 2.8-.56 3.77-1.53l2.83-2.5.01.01L14.49 11h-.01l2.69-2.39c.64-.64 1.49-.99 2.4-.99 1.87 0 3.39 1.51 3.39 3.38s-1.52 3.38-3.39 3.38c-.9 0-1.76-.35-2.44-1.03l-1.14-1.01-1.51 1.34 1.27 1.12c1.02 1.01 2.37 1.57 3.82 1.57 2.98 0 5.4-2.42 5.4-5.38s-2.42-5.38-5.4-5.38z"/></svg>';
    var titleText = document.createElement('span');
    titleText.textContent = 'Nonstop' + (CFG.version ? ' v' + CFG.version : '');
    title.appendChild(titleText);
    var titleState = document.createElement('span');
    var on = isEnabled();
    titleState.textContent = on ? '● ON' : '● OFF';
    // Theme-derived so the state colour holds contrast on light themes too.
    titleState.style.cssText = 'font-weight:normal;font-size:11px;margin-left:auto;color:' +
      (on ? 'var(--vscode-charts-green,#4ec9b0)' : 'var(--vscode-descriptionForeground,#888)') + ';';
    title.appendChild(titleState);
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

    var ptext = mkInput('text', liveCfg('pingText'));
    ptext.title = 'The text sent to Claude to continue (e.g. "continue").';
    ptext.onchange = function () { setOverride('pingText', ptext.value); };
    row('Message to send', ptext);

    var quiet = mkInput('text', liveCfg('quietHours') || '');
    quiet.placeholder = 'e.g. 09:00-17:00';
    quiet.title = 'Optional. A window when Nonstop pauses and sends nothing — e.g. your work hours. Leave empty to run anytime, including overnight.';
    quiet.onchange = function () { setOverride('quietHours', quiet.value); };
    row('Pause during (optional)', quiet);

    var mp = mkInput('number', liveCfg('maxPings'));
    mp.title = 'Stop automatically after this many messages. 0 = no limit.';
    mp.onchange = function () { setOverride('maxPings', Math.max(0, parseInt(mp.value, 10) || 0)); };
    row('Stop after N messages (0=off)', mp);

    var mr = mkInput('number', Math.round(liveCfg('maxRuntimeMs') / 60000));
    mr.title = 'Stop automatically after running this long. 0 = no limit. (e.g. 480 = 8h)';
    var mrWrap = document.createElement('div');
    mrWrap.style.cssText = 'display:flex;align-items:center;gap:6px;';
    var mrHint = document.createElement('span');
    mrHint.style.cssText = 'opacity:.6;white-space:nowrap;';
    // Hint sits to the LEFT of the input, so read it as "8h = [480]" (= goes after the hours).
    function updMrHint() { var m = parseInt(mr.value, 10) || 0; mrHint.textContent = m > 0 ? (Math.round(m / 6) / 10) + 'h =' : ''; }
    updMrHint();
    mr.oninput = updMrHint;
    mr.onchange = function () { setOverride('maxRuntimeMs', Math.max(0, parseInt(mr.value, 10) || 0) * 60000); updMrHint(); };
    mrWrap.appendChild(mrHint); mrWrap.appendChild(mr); // "= 8h" sits to the LEFT of the input
    row('Stop after (minutes, 0=off)', mrWrap);

    // Divider: everything below is about how Nonstop handles Claude's interaction popups
    // (permission + decision), as opposed to the general ping/stop settings above.
    var popupDivider = document.createElement('div');
    popupDivider.style.cssText = 'border-top:1px solid var(--vscode-editorWidget-border,#454545);' +
      'margin:9px 0 5px;padding-top:6px;font-size:10px;text-transform:uppercase;letter-spacing:.4px;opacity:.55;';
    popupDivider.textContent = 'Popup handling';
    pop.appendChild(popupDivider);

    var perm = mkSelect(['defer', 'approve', 'stop'], liveCfg('onPermission'));
    perm.title = 'When Claude asks permission to run a tool (e.g. a bash command):\n' +
      'defer = let another approver (YOLO) or you handle it;\n' +
      'approve = auto-click Yes after the grace window;\n' +
      'stop = halt and leave it to you.';
    perm.onchange = function () { setOverride('onPermission', perm.value); };
    row('On permission prompt', perm);

    var grace = mkInput('number', Math.round(liveCfg('permissionGraceMs') / 1000));
    grace.min = 0;
    grace.title = 'How long to wait for another approver (e.g. YOLO) to clear a permission popup before applying the action above. Set this HIGHER than your YOLO auto-approve delay so YOLO always wins.';
    grace.onchange = function () { setOverride('permissionGraceMs', Math.max(0, parseInt(grace.value, 10) || 0) * 1000); };
    row('Permission grace (sec)', grace);

    var dec = mkSelect(['stop', 'best-judgment'], liveCfg('onDecision'));
    dec.title = 'When Claude asks you to choose between options:\n' +
      'stop = halt and leave it to you (recommended);\n' +
      'best-judgment = pick the last "Other" option and answer "use your best judgment".';
    dec.onchange = function () { setOverride('onDecision', dec.value); };
    row('On decision prompt', dec);

    var reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'Reset to defaults';
    reset.style.cssText = 'margin-top:8px;width:100%;cursor:pointer;background:var(--vscode-button-secondaryBackground,#3a3d41);' +
      'color:var(--vscode-button-secondaryForeground,#ccc);border:none;border-radius:3px;padding:4px;';
    var resetMsg = document.createElement('div');
    resetMsg.style.cssText = 'text-align:center;font-size:11px;height:13px;margin-top:4px;' +
      'color:var(--vscode-charts-green,#4ec9b0);opacity:0;transition:opacity .15s;';
    resetMsg.textContent = '✓ Reset to defaults';
    reset.onclick = function () {
      ['pingIntervalMs', 'pingText', 'quietHours', 'maxPings', 'maxRuntimeMs',
        'onPermission', 'permissionGraceMs', 'onDecision'].forEach(function (k) { setOverride(k, null); });
      // Refresh the visible fields to the restored defaults rather than closing — the reset
      // is then visible and immediately re-editable, no destructive close-and-reopen.
      interval.value = Math.round(liveCfg('pingIntervalMs') / 1000);
      ptext.value = liveCfg('pingText');
      quiet.value = liveCfg('quietHours') || '';
      mp.value = liveCfg('maxPings');
      mr.value = Math.round(liveCfg('maxRuntimeMs') / 60000); updMrHint();
      perm.value = liveCfg('onPermission');
      grace.value = Math.round(liveCfg('permissionGraceMs') / 1000);
      dec.value = liveCfg('onDecision');
      resetMsg.style.opacity = '1';
      setTimeout(function () { resetMsg.style.opacity = '0'; }, 1500);
    };
    pop.appendChild(reset);
    pop.appendChild(resetMsg);

    // Brief "saved" cue on any field change (change bubbles, so one listener covers all
    // fields) — confirms the blur-to-save took effect without a per-field handler.
    pop.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t || !t.style) return;
      var orig = t.style.borderColor;
      t.style.borderColor = 'var(--vscode-charts-green,#4ec9b0)';
      setTimeout(function () { t.style.borderColor = orig || ''; }, 600);
    });

    // Never let it spill past the panel: cap width to the viewport, then re-clamp
    // position using the popup's real measured size (it grows with labels/hints, and
    // usually opens near the bottom edge next to the footer button).
    pop.style.maxWidth = (window.innerWidth - 16) + 'px';
    pop.style.maxHeight = (window.innerHeight - 24) + 'px';
    pop.style.overflowY = 'auto';
    document.body.appendChild(pop);
    var rect = pop.getBoundingClientRect();
    var left = Math.min(ax, window.innerWidth - rect.width - 12);
    // Bottom margin is generous: the popup opens from the footer button, so leave
    // room above the footer/input so its last row isn't clipped.
    var top = Math.min(ay, window.innerHeight - rect.height - 24);
    pop.style.left = Math.max(8, left) + 'px';
    pop.style.top = Math.max(8, top) + 'px';

    // Move focus into the dialog so keyboard users land inside it (and the Esc/Tab
    // handlers below are meaningful). Restored to the opener on close.
    function focusables() {
      return pop.querySelectorAll('input,select,button,[tabindex]:not([tabindex="-1"])');
    }
    var ff = focusables();
    try { (ff.length ? ff[0] : pop).focus(); } catch (e2) {}

    function outside(ev) { if (!pop.contains(ev.target)) closeSettingsPopup(); }
    function keyHandler(ev) {
      if (ev.key === 'Escape') { closeSettingsPopup(); return; }
      if (ev.key !== 'Tab') return;
      // Trap Tab inside the dialog so focus can't fall through to Claude's DOM behind it.
      var f = focusables();
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1], active = document.activeElement;
      if (!pop.contains(active)) { ev.preventDefault(); first.focus(); }
      else if (ev.shiftKey && active === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
    }
    pop._cleanup = function () {
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('keydown', keyHandler, true);
    };
    setTimeout(function () {
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('keydown', keyHandler, true);
    }, 0);
  }

  // ── The shared toolbar div (#orb-tools convention) ───────────────────────────
  // All of the user's injected buttons share ONE container, #orb-tools: reuse it if
  // a sibling tool already created it, otherwise create it and dock it just to the
  // LEFT of Claude's native mode button (fall back to the footer end). Re-query every
  // call (never cache the node) — Claude re-renders the footer and detaches it.
  function ensureToolbar() {
    var existing = document.getElementById('orb-tools');
    if (existing && existing.isConnected) return existing;
    var footer = $(SIGNALS.footer);
    if (!footer) return null;
    var bar = existing || document.createElement('div');
    bar.id = 'orb-tools';
    bar.style.cssText = 'display:inline-flex;align-items:center;gap:4px;';
    var modeBtn = footer.querySelector(SIGNALS.modeButton);
    var modeContainer = modeBtn ? modeBtn.parentElement : null;
    if (modeContainer && modeContainer.parentNode) {
      modeContainer.parentNode.insertBefore(bar, modeContainer);
    } else {
      footer.appendChild(bar);
    }
    return bar;
  }

  function ensureStyle() {
    if (document.getElementById('nonstop-style')) return;
    var st = document.createElement('style');
    st.id = 'nonstop-style';
    st.textContent =
      // Toggle button per the #orb-tools convention (claude-panel-button skill): three
      // distinct states - base (dim), :hover, and .ns-on (lit) - so the button behaves like
      // its sibling tools in the shared toolbar. Same mechanics as the skill's reference, but
      // in Nonstop's gold accent instead of the default blue. The SVG infinity is coloured
      // via currentColor (emoji render grey/inconsistently in the webview).
      // OFF: dim grey. padding 4px 7px keeps the hit target ~26px.
      '#nonstop-btn{background:transparent;border:none;cursor:pointer;' +
      'padding:4px 7px;line-height:0;vertical-align:middle;border-radius:6px;' +
      'color:#8a8a8a;opacity:.6;transition:color .15s,opacity .15s,background .15s;}' +
      '#nonstop-btn svg{display:block;width:18px;height:18px;}' +
      '#nonstop-btn:hover{opacity:1;color:#e3b341;background:rgba(255,215,0,.16);}' +
      '#nonstop-btn:focus-visible{outline:2px solid #e3b341;outline-offset:1px;}' +
      // ON: lit gold accent on a subtle gold background — overrides the dim base.
      '#nonstop-btn.ns-on{opacity:1;color:#e3b341;background:rgba(255,215,0,.22);}' +
      // Press feedback.
      '#nonstop-btn:active{transform:scale(.92);}';
    document.head.appendChild(st);
  }

  function injectButton() {
    var btn0 = document.getElementById('nonstop-btn');
    if (btn0) {
      // Button exists. Fast path: if it's still docked inside a live #orb-tools, there's
      // nothing to do — skip the footer re-query that ran on every interval before. Only
      // when it's been detached (Claude re-rendered the footer) do we rebuild the toolbar
      // and re-dock.
      var existingBar = document.getElementById('orb-tools');
      if (existingBar && existingBar.isConnected && btn0.parentNode === existingBar) return;
      var bar0 = ensureToolbar();
      if (bar0 && btn0.parentNode !== bar0) bar0.appendChild(btn0);
      return;
    }
    var bar = ensureToolbar();
    if (!bar) return;
    ensureStyle();

    var btn = document.createElement('button');
    btn.id = 'nonstop-btn';
    btn.type = 'button';
    btn.title = 'Nonstop: keep Claude working (ping + wait out rate limits). Right-click or Shift+F10 for settings.';
    btn.setAttribute('aria-label', 'Nonstop: toggle keep-going. Right-click or Shift+F10 for settings.');
    btn.setAttribute('aria-pressed', isEnabled() ? 'true' : 'false'); // it's a toggle button
    btn.setAttribute('aria-haspopup', 'dialog');
    // Inline SVG infinity (Material "all_inclusive"), coloured via currentColor so
    // ON/OFF is deterministic — the ♾️ emoji rendered unreliably (grey) in the webview.
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      '<path d="M18.6 6.62c-1.44 0-2.8.56-3.77 1.53L12 10.66 10.48 12h.01L7.8 14.39c-.64.64-1.49.99-2.4.99-1.87 0-3.39-1.51-3.39-3.38S3.53 8.62 5.4 8.62c.91 0 1.76.35 2.44 1.03l1.13 1 1.51-1.34L9.22 8.2C8.2 7.18 6.84 6.62 5.4 6.62 2.42 6.62 0 9.04 0 12s2.42 5.38 5.4 5.38c1.44 0 2.8-.56 3.77-1.53l2.83-2.5.01.01L14.49 11h-.01l2.69-2.39c.64-.64 1.49-.99 2.4-.99 1.87 0 3.39 1.51 3.39 3.38s-1.52 3.38-3.39 3.38c-.9 0-1.76-.35-2.44-1.03l-1.14-1.01-1.51 1.34 1.27 1.12c1.02 1.01 2.37 1.57 3.82 1.57 2.98 0 5.4-2.42 5.4-5.38s-2.42-5.38-5.4-5.38z"/></svg>';
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); toggleShift(); });
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); e.stopPropagation(); showSettingsPopup(e); });
    // Keyboard access to settings (the context menu is mouse-only): the dedicated
    // ContextMenu key, or Shift+F10 — the platform-standard "open context menu" chord.
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault(); e.stopPropagation(); showSettingsPopup(e);
      }
    });

    // Dock into the shared #orb-tools toolbar (created/positioned by ensureToolbar),
    // so we sit alongside the user's other injected tools instead of in our own wrapper.
    bar.appendChild(btn);
    updateButton();
    log('button injected into #orb-tools');
  }
  function updateButton() {
    var btn = document.getElementById('nonstop-btn');
    if (!btn) return;
    // Reflect the shift state itself — ownership is an internal coordination detail,
    // and a reloaded panel claims it within a tick, so don't gate the visual on it.
    var on = isEnabled();
    btn.classList.toggle('ns-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false'); // toggle-button state for a11y
    btn.title = (on ? 'Nonstop: ON (click to stop)' : 'Nonstop: OFF (click to start)') +
      '. Right-click or Shift+F10 for settings.';
  }

  // ── Boot ───────────────────────────────────────────────────────────────────────
  // 2.5s is responsive enough to re-dock after a footer re-render while doing far less
  // work than the old 1.5s — and the fast path above makes the common (still-docked) tick
  // a single getElementById with no footer query.
  setInterval(injectButton, 2500); // re-inject if Claude re-renders the footer
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
          '| popup:', detectPopup(), '| streaming:', isStreaming(), '| enabled:', isEnabled(),
          '| inputEmpty:', inputText() === '', '| len:', panelLen());
      } catch (e) {
        console.log('[Nonstop] heartbeat error:', e && e.message);
      }
    }, 3000);
  }

  // Recon/debug handle for live tuning (only does anything in debug mode).
  window.__nonstopDebug = {
    state: detectState,
    popup: detectPopup,
    rateLimit: detectRateLimit,
    input: getInput,
    config: CFG,
    instance: INSTANCE_ID,
    dumpFooter: function () { var f = $(SIGNALS.footer); return f ? f.outerHTML : '(no footer)'; },
    // Phase 3 helpers: read or clear the stashed real rate-limit notice.
    rateLimitCapture: function () { return lsGet(LS.rlCapture, '(none captured)'); },
    clearRateLimitCapture: function () { lsSet(LS.rlCapture, ''); return 'cleared'; },
    // Live shift status — the one-stop diagnostic ("why did it stop? is it sleeping?").
    status: function () {
      var s = lsNum(LS.sleepUntil, 0);
      return {
        enabled: isEnabled(),
        owner: isOwner(),
        state: detectState(),
        popup: detectPopup(),
        looksRateLimited: looksRateLimited(),
        pings: lsNum(LS.pingCount, 0),
        sleepingUntil: s ? new Date(s).toISOString() : null,
        rlSignature: rateLimitSignature() || null,
        servedRl: lsGet(LS.servedRl, '') || null,   // limit already waited out (won't re-sleep)
        pendingRl: lsGet(LS.pendingRlSig, '') || null, // limit currently being slept out
        lastStop: lsGet(LS.lastStop, '(none)'),
      };
    },
    // Test the wait→resume path WITHOUT a real limit: turns the shift on (if needed)
    // and sleeps for `sec` seconds, then resumes (a ping fires on wake). Watch the
    // console: you'll see "sleeping…" now and a "pinged:" line ~sec seconds later.
    simulateRateLimit: function (sec) {
      sec = sec || 15;
      if (!isEnabled()) startShift();
      claimOwnership(); // make sure THIS panel drives the test
      lastPingAt = 0; // make a ping eligible immediately on wake
      lsSet(LS.sleepUntil, Date.now() + sec * 1000);
      log('TEST: simulating a rate-limit sleep for', sec, 's — will resume with a ping on wake');
      return 'sleeping ~' + sec + 's; expect a ping after wake. Check __nonstopDebug.status().';
    },
  };

  log('initialized', { instance: INSTANCE_ID, debug: CFG.debug });
})();
