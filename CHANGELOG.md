# Changelog

## \[Unreleased]

### Fixed

* **The "5-hour limit" notice is now recognised as a rate limit.** Claude Code now words the notice "You've hit your 5-hour limit · resets 8pm (America/Sao_Paulo)", which none of the strict patterns matched (the qualifier list was `session|usage|rate`), so `detectRateLimit()` returned null and the shift kept pinging into the limit instead of sleeping. The qualifier is now any one or two words, the pattern still requires the full "hit your … limit … resets <time>" structure, and the loose "N-hour / weekly / Opus / Sonnet" forms are flagged too.

## \[0.5.0] - 2026-06-15

### Added

* **Nonstop no longer takes the first "done" at face value - it double-checks.** Autonomous agents often declare completion prematurely (e.g. an agent that finished the feature but hadn't run the QA/test pass yet). When Claude emits the completion sentinel, Nonstop now pushes a verification nudge - "before you finish, double-check nothing real is left: tests, edge cases, error handling, docs, pending spec items; reply NONSTOP_DONE only if truly done" - and stops only if Claude still reports done after it. The number of nudges is the new `nonstop.doneConfirmNudges` setting (default 1; 0 restores the old stop-on-first-signal behaviour; also editable in the panel's settings popup as "Re-check before stopping (times)"). Each nudge carries the sentinel so the done-accounting stays balanced and Claude re-signals when it confirms. A useful side effect: this also softens false "done" detection - a stray sentinel now triggers a harmless verification nudge instead of ending the shift.

## \[0.4.6] - 2026-06-15

### Changed

* **`__nonstopDebug.status()` now reports the EFFECTIVE state, matching what the loop actually does.** It recomputed `detectState()` without the "already-served limit" flag that `tick()` passes, so a window that had waited out a limit and was actively resuming still showed `state: RATE_LIMITED` - alarming, but only a readout artifact. `status()` now applies the served-limit flag (so it shows `WAITING_CONTINUE` while resuming), and adds `rawState` (the unflagged detector view) and `rateLimitServed` (true when a limit notice is on screen but already waited out) for debugging.

## \[0.4.5] - 2026-06-15

### Fixed

* **An hour-only reset time ("resets 1pm") is now parsed, instead of sleeping 5 hours.** The session-limit notice often shows a whole-hour reset with no minutes ("resets 1pm (Asia/Jerusalem)"), but the reset-time patterns required `H:MM`, so the time was never captured and Nonstop fell back to its 5-hour default sleep - it stayed asleep for hours after the limit had already reset. Minutes are now optional in both the detection and the parser ("1pm" and "1:00pm" both work).
* **A reset time that has already passed now resumes immediately instead of sleeping ~24h.** When the on-screen notice's reset time is in the recent past (the limit has already reset - e.g. you reopen to a stale notice), Nonstop no longer rolls it to "tomorrow" and sleeps a full day. It treats the time as already reset, marks the notice served, and resumes pinging. A genuinely upcoming reset that crosses midnight is still handled (an 8-hour grace cleanly separates "just passed" from "next occurrence").

### Notes

* Recovery for a window already stuck in the old 5-hour sleep: run `__nonstopDebug.simulateRateLimit(2)` in that panel's webview console - it clears the committed sleep and resumes within a couple of seconds.

## \[0.4.4] - 2026-06-15

### Fixed

* **Each VS Code window now runs its own independent shift.** The Claude webview's `localStorage` is shared across all windows of one VS Code install, so the single global shift state made every window move in lockstep - turning Nonstop on in one window lit the button in all of them, and turning it off in one stopped them all. The shift state (enabled, owner lease, ping count, sleep, etc.) is now namespaced per conversation (`nonstop-s-<sessionId>-…`), so windows on different conversations are fully independent: toggling one never touches the others, and each button reflects only its own conversation. The conversation id comes from the host-message sniffer (now also bootstrapped from any message carrying a `session_id`, so the namespace is known quickly); a shift toggled on before the id is known migrates onto the conversation once it's learned, so the early toggle isn't lost. Settings and the diagnostic log stay global. Switching conversations in a window shows that conversation's own on/off (a different conversation starts off).

## \[0.4.3] - 2026-06-15

### Fixed

* **A leftover completion sentinel from a previous run no longer kills a fresh shift on sight.** If an earlier shift in the same conversation finished and left its `NONSTOP_DONE` in the transcript, starting a new shift would immediately stop with `done-sentinel` at `pings=0` - it read the old sentinel as a reply to a ping it never sent (and the baseline count taken at start can also under-count while the transcript is still lazy-loading, then "grow" into a false completion). Done-by-sentinel is now ignored until we've actually pinged with the sentinel instruction at least once this shift (`sentinelPings > 0`), so a pre-existing `NONSTOP_DONE` can't end a shift before it begins. A real completion (a sentinel that appears *after* our ping) still stops immediately.
* **Application output that merely contains the word "RateLimitError" is no longer mistaken for a Claude usage limit.** The "looks rate-limited" safety net matched a qualifier glued straight onto "limit" (e.g. the `RateLimitError` exception that a yfinance/FRED data project prints verbatim), which risked putting a shift to sleep for hours over ordinary error text. It now requires a real separator between the qualifier and "limit" (`rate limit`, `session limit`, `5-hour limit` all still match; `RateLimitError` does not). The strict notice detector that actually triggers sleep was already anchored on the full `hit your … limit … resets …` structure and is unchanged.

### Changed

* Diagnostic-log conversation titles are collapsed to a single line (whitespace/newlines squashed), so a conversation auto-titled from pasted multi-line text stays readable in the log.

## \[0.4.2] - 2026-06-15

### Fixed

* **The diagnostic log now labels each line with the real conversation and project** instead of `(unknown)`. The 0.4.0 sniffer looked for `sessionId`/`title` at the top level of incoming messages, but the host actually wraps its traffic as `{ type:'from-extension', message:{…} }`: the conversation comes from a `session_states_update` request (its `sessions[]` each carry `{sessionId, state, title}`, with `activeSessionId` naming the current one), and the working directory arrives as both `update_state`'s `state.defaultCwd` and a `system`/`init` `cwd`. The sniffer now reads those real shapes - picking the active session's title/id and the cwd's last path segment as the project - verified live against Claude 2.1.177. It still only extracts identity for the log and never feeds state detection, so the 0.3.0 security boundary holds (a forged `running` state can't suppress or force pings); there's a test for exactly that.

## \[0.4.1] - 2026-06-15

### Fixed

* **Pings now actually send.** On the current Claude Code build the shift would run (`enabled`, `owner`, state `WAITING_CONTINUE`) but `pings` stayed at `0`: the ping typed its text into the box and then found the send button still `disabled`, so it cleared the text and bailed - every tick. Root cause, traced live: Claude's composer is a React-controlled `contenteditable` (not Lexical), and its send button is gated on React state that `onInput` populates by reading the element's `textContent`. `execCommand('insertText')` puts visible text in the box but does **not** reach React's delegated `onInput` in this webview, so React still thought the input was empty and kept the button disabled. The fix pushes the text into React state by invoking the component's own `onInput` prop directly (its prop key is hashed per render, so it's found dynamically). Because that `setState` is out-of-band it flushes a tick later, so the click is now deferred and retried on short timers (up to ~800ms) until the button enables, then accounted once - a button that never becomes clickable no longer inflates the ping count, and a stranded ping is still cleared for a clean retry. The DOM-only test harness (whose button tracks input emptiness, with no React) still passes unchanged.

## \[0.4.0] - 2026-06-15

### Added

* **A lean, always-on diagnostic log you can pull after the fact.** When an unattended shift misbehaves you no longer need to have had DevTools open: a capped ring buffer in `localStorage` (last 300 entries / 64KB) records the discrete lifecycle events - `start`, `stop` (with reason), `ping` (with count), `sleep`/`wake`, and `permission`/`decision` actions - each tagged with the conversation and project. Read it back with `__nonstopDebug.dumpLog()` (current conversation) or `dumpLog(true)` (every conversation seen in the panel), get a shareable export with `__nonstopDebug.report()`, or use the new **"Copy diagnostic log"** button in the settings popup, which copies the whole report (identity + live status + log) to the clipboard - so you can paste the *relevant* log into an email or issue. `clearLog()` empties it.
* **The log is labeled per conversation and project.** A best-effort sniffer reads Claude's own `update_session_state` host message (RECON §1) to learn the `sessionId`, conversation title, and a project name, so a multi-window / multi-project setup stays disambiguable in the log. This sniffer only extracts identity and never feeds state detection, so reading those (non-namespaced) messages can't be used to forge a ping-suppressing or ping-forcing state - the security boundary from 0.3.0 is preserved.

### Fixed

* **The ♾️ button no longer lies about the shift state.** Its glow was repainted only when *that panel* toggled/started/stopped - the 2.5s re-injector's fast path returned early without refreshing it - so when the shift state changed any other way (an auto-stop, or simply comparing one window's button to another's storage) the button could show ON while the shift was OFF, or vice versa. It now self-heals to the live state on every re-inject pass. (Storage is per-window, so each window still has its own independent shift; the reliable source of truth remains `__nonstopDebug.status().enabled`.)

## \[0.3.2] - 2026-06-14

### Fixed

* **A ping no longer interrupts Claude mid-tool, and no longer gets stranded in the input box.** These were two faces of one bug: Claude's send control and its Stop/interrupt control are the *same* button, and while Claude was running a tool the transcript doesn't grow - so the growth-based "is it streaming" check (a 2s window) went blind, no other busy signal fired (the real Stop button carries no `aria-label`), and `detectState` fell through to `WAITING_CONTINUE`. The ping then typed its text and clicked that button while it was acting as Stop: the turn showed `INTERRUPTED`, and because the click stopped instead of sending, the "continue..." text was left sitting in the box. There's now a reliable busy signal that doesn't depend on output growth - `sendButtonIsStop()`: the send control being *enabled while the input is empty* uniquely means it's the Stop button (you can't send an empty message), i.e. Claude is busy. That state now reads as `WORKING` (checked after popup detection so permission/decision popups aren't masked), `setInputAndSend` re-checks it right before sending to close the tick-to-send race, and the fragile synthetic-Enter fallback - which frequently got dropped by the contenteditable and was the other way a ping got stranded - was removed in favor of clearing the box for a clean retry.

### Tests

* The webview DOM harness now models Claude's send/stop control faithfully (disabled over an empty input while idle; enabled over an empty input while busy/Stop), and two behavioural tests cover the new busy detection.

## \[0.3.1] - 2026-06-09

### Changed

* **The ♾️ button now follows the shared `#orb-tools` toggle convention, so it behaves like the user's other injected panel buttons.** It gets a colored hover (its own gold accent, matching how each sibling tool hovers in its own hue), a press feedback (`:active` scale), and exposes `aria-pressed` for its on/off state. The lit ON state is now a clean static gold accent on a subtle gold background instead of the pulsing gold pill (so there's no animation to reduce-motion away). ON/OFF still reflects the real shift state from storage, not an optimistic guess.

## \[0.3.0] - 2026-06-09

Reviewer-pass hardening: correctness, resilience, performance, security, and accessibility fixes across the host and the injected webview.

### Fixed

* **The injected loop no longer blocks the Extension Host with a CPU-spinning busy-wait.** `atomicWrite`'s retry backoff (only taken when another injector clobbers our write) was a `while (Date.now() < until) {}` loop that pegged a core. It now parks the thread with `Atomics.wait` (no CPU spin), and the temp-file name gained a random suffix so two writes in the same millisecond can't collide.
* **A shift now survives a transient failure to resume instead of dying until morning.** When output stalls and it isn't a rate limit, Nonstop used to stop immediately. It now retries the resume ping a few times with a growing backoff (`maxStallRetries`, default 4; doubles the interval each retry, capped at 15 min) before giving up - so a one-off dropped ping overnight doesn't end an unattended shift. A real completion sentinel still stops the shift immediately, and `maxRuntime`/`maxPings` still cap everything.
* **A two-notice transcript now sleeps to the freshest reset time, not the oldest.** `detectRateLimit` took the first regex match in the tail; with two limit notices on screen that could be an older, already-past time (a path back into the ~24h silent-sleep bug). It now takes the last (bottom-most) match in both the host module and the webview copy.
* **A fixed-window limit notice (no reset time) keeps a stable signature across a reload.** The fallback `rateLimitSignature` keyed on a raw 80-char snippet that shifts as the transcript scrolls between sleep and wake, which could resurrect the re-sleep bug. It now normalizes to just the limit phrase's letters.
* **A ping left stranded in the input is now recovered after a panel reload instead of blocking the shift forever.** `inputIsForeign` compared only against an in-memory `lastInsertedText` that resets on reload, so a ping left in the box during a reload looked like a user draft. Two parts: the last ping text is now persisted (`LS.lastPing`) so a reloaded panel still recognizes its own stuck ping as ours, and `detectState` now routes a non-foreign input (empty, or only our own stranded ping) to `WAITING_CONTINUE` so the clear-and-resend path actually runs. A genuine user draft is still never touched - `setInputAndSend` re-checks `inputIsForeign` immediately before clearing.

### Security

* **The webview's `postMessage` listener no longer trusts arbitrary same-document messages.** It fed `observedState` (used by state detection) from any `message` event, so another script in Claude's document could forge a state to suppress or force pings. It now accepts only messages explicitly namespaced to us (`__nonstop: true`).

### Changed

* **Performance:** the footer button re-injector skips the footer DOM re-query on every tick when the button is still docked (fast `getElementById` path), and its interval relaxed from 1.5s to 2.5s.
* **Accessibility:** the right-click settings popup is now reachable and usable from the keyboard - opens with the ContextMenu key or Shift+F10, is a real `role="dialog"` with `aria-modal` and a label, traps Tab, moves focus in on open and restores it on close, and every field carries an `aria-label`.
* **Theming & motion:** the button and popup colors now derive from VS Code theme variables (correct contrast on light themes), a visible focus ring was added, the ON pulse animation respects `prefers-reduced-motion` (static gold pill when motion is reduced), and the button hit target grew slightly.
* **Polish:** "Reset to defaults" now refreshes the fields inline with a confirmation instead of closing the popup; a brief "saved" cue flashes on any field change; the popup header uses the same infinity SVG as the button (not the unreliable emoji); the status bar's initial icon is no longer the misleading `$(sync)`; a stopped shift releases its ownership lease; dead code (`lastOutputSig`) removed.

### Tests

* Wired the behavioural webview tests and reset-time edge tests into `npm test` (was running only `run.js`). 67 unit tests plus the real-bundle integration test pass.

## \[0.2.6] - 2026-06-07

### Fixed

* **The panel no longer freezes ("no response, stuck") every few minutes during a shift.** The injected loop read `document.body.innerText` 5–8 times per `tick()` (once a second), and `innerText` forces a *synchronous reflow of the entire conversation DOM*. Running on the same main thread as Claude's UI, that reflow storm periodically froze the panel — and got worse the longer (and larger) the conversation grew, matching the "once every few minutes" report. The detectors now read `textContent` (same characters, zero layout — every consumer only slices the tail and regex-matches, so rendered-vs-raw is immaterial), **scoped to Claude's transcript/messages container** instead of the whole `document.body`, and **memoized per tick** so those 5–8 reads collapse into one. Scoping to the transcript also avoids a subtle false-positive: Claude's footer usage meter renders the literal strings "usage limits" / "Resets <time>", which—at the end of `body`, inside the scanned tail—would have tripped `looksRateLimited()` and silently put a *finished* shift to sleep instead of stopping it. `sampleGrowth()` is now a no-op while the shift is OFF instead of materializing the transcript every second.
* **Your in-progress message is no longer wiped when a "continue" ping fires ("my last request wasn't even captured — I had to retype it").** `setInputAndSend()` did `selectAll`+`delete` on the input, and the only guard was a check in `maybePing()` that ran *before* the wipe — a time-of-check/time-of-use race: start typing in that gap and your draft was selected-all-deleted, replaced with "continue", and sent. Claude keeps the draft only in memory, so a reload lost it for good. The clear is now re-guarded *immediately* before it runs (`inputIsForeign()`), aborting if anything we didn't type is in the box; user-activity detection also now listens for `input` events (paste/IME/dropped keys), not just `keydown`/`pointerdown`.
* **Pings now submit via Claude's real Send button instead of a fragile synthetic Enter.** `findSendButton()` searched for `[aria-label*="Send"]`, but Claude's submit control is a `<button type="submit" class="sendButton_…">` with **no aria-label** — so it never matched and every ping fell back to dispatching an untrusted `Enter` key event, which can be dropped, stranding the ping text in the input. We now click the real button (scoped to the footer; skipped while busy/streaming so we never hit its Stop/interrupt mode), falling back to Enter only if it's absent. A ping we did leave stuck is now recognized as ours (not a user draft) so it can be cleared and resent rather than blocking further pings.

## \[0.2.5] - 2026-06-06

### Fixed

* **No more endless "Reload Window" prompts when another injector (e.g. Agentville) shares the panel.** Injection used to strip our block and re-append it at the *end* of Claude's `webview/index.js`. With two coexisting injectors both appending to the end, each activation re-ordered the file so the other was no longer last — so both saw the file "changed" on every window reload and both re-prompted a reload, forever. Injection is now **in-place**: an existing block is replaced where it sits (duplicates dropped, foreign blocks and surrounding whitespace untouched), so re-injecting a current block is a byte-for-byte no-op. A reload is only offered when our block's own content actually changed. Added regression tests for the no-op guarantee and for not reordering a foreign block.

## \[0.2.4] - 2026-06-06

### Changed

* **The ♾️ button now docks into a shared `#orb-tools` toolbar instead of its own private wrapper.** Previously Nonstop inserted its own `#nonstop-nav` wrapper to the left of Claude's mode button. With more than one injected tool in the panel, each spawned its own footer chip. Nonstop now follows the shared-toolbar convention: it reuses `#orb-tools` if a sibling tool already created it, otherwise creates it once — so Nonstop and any other injected tools (e.g. a launcher) line up in one container. The self-match guard that keeps our own button from being read as "Claude is working" now scopes to `#orb-tools`, covering sibling buttons too. No behaviour change for users; the toggle, settings popup, and rate-limit handling are unchanged. Updated the drift-guard test and added one for the shared-toolbar convention.

## \[0.2.3] - 2026-06-05

### Fixed

* **A shift now resumes after a usage limit instead of silently sleeping ~24h.** When Claude posts "You've hit your session limit · resets 10:10pm", Nonstop correctly sleeps until that time — but the notice stays in the transcript after the reset passes. On wake, `detectState()` re-detected the same on-screen notice, `parseResetTime` resolved its now-past time to the **next** day, and the shift went back to sleep until tomorrow — toggle still lit, never resuming (the cause of "it's on, the limit message is showing, but it won't continue"). Nonstop now records the signature of the limit it slept out (`servedRl`) and, while that same notice is still showing, ignores the rate-limit layer so the resume ping goes through; the stall→sleep safety net is likewise suppressed for an already-served notice. The signature self-clears once the notice scrolls out of view, so a genuinely new limit is still honored. Added structural guard tests.

## \[0.2.2] - 2026-06-05

### Fixed

* **The shift now actually pings again — our own button no longer reads as "Claude is working".** The injected ♾️ button's `aria-label` is `Nonstop`, whose substring `…stop` matched the `[aria-label*="Stop" i]` working-indicator selector. With the shift on, the button is always present, so `detectState()` returned `WORKING` on every tick and never reached the "ready to nudge" state — no ping ever fired (the deepest cause of "it was on all night but never made progress"). `matchAny()` now skips our own injected DOM (`#nonstop-nav` / `#nonstop-settings`) and requires the matched indicator to be visible; `isStreaming()` still backstops real generation. Added a self-match guard test.
* **A shift no longer puts itself to sleep on conversation text that merely *mentions* a limit.** Rate-limit detection scanned the whole panel transcript, so a bare `resets 10:10pm` or `limit will reset` appearing in ordinary chat — for example while the conversation was discussing this very feature — was read as a real usage-limit notice. The shift then went into a silent multi-hour sleep with the toggle still lit and no popup on screen (the likely cause of "it was on overnight but stopped making progress and never went grey"). Detection now requires the canonical `hit/reached your <session|usage|rate> limit` notice structure; the loose reset-time patterns moved to a separate set used only to extract the reset time **after** a real limit is already confirmed. The stall-time `looksRateLimited` safety net was likewise narrowed to limit-anchored phrases so a stray `resets <time>` / `429` in chat can't block a finished shift from stopping. Added a regression test.

## \[0.2.1] - 2026-06-04

### Added

* The status bar and the right-click popup header now show the running version (e.g. `Nonstop v0.2.1`). The status bar reflects the installed extension; the popup reflects the injected webview — so if they ever differ, a stale injection is obvious at a glance.
* The new `onPermission` / `permissionGraceMs` / `onDecision` / `decisionAnswer` options are now exposed in VS Code Settings (previously only in the right-click popup).

### Changed

* Injection now refreshes on **any** change to the version, seed config, or injected script — not just a version bump. Changing a setting in VS Code Settings now takes effect on the next panel reload, instead of being ignored because the version was unchanged.

## \[0.2.0] - 2026-06-04

### Added

* **Permission prompts are now handled separately from decision prompts.** Claude's two interaction popups share the same outer container, so they're disambiguated by content: a decision popup ("choose an option") renders `role="radio"` options; a permission popup ("Allow this bash command?") does not. New `detectPopup()` classifies them and `detectState()` emits `WAITING_PERMISSION` / `WAITING_DECISION`.
* **`onPermission` setting (`defer` / `approve` / `stop`, default `defer`).** `defer` leaves permission popups to another approver (e.g. the RTL extension's YOLO) or to you; `approve` auto-clicks the safe "Yes" (allow once); `stop` halts and hands it back.
* **`permissionGraceMs` setting (default 10s).** Before acting on a permission popup, wait this long so any other approver can clear it first — if it disappears within the window we never interfere. **Set this higher than your YOLO auto-approve delay** so YOLO always wins the race. Exposed in the right-click settings popup.
* **`onDecision` setting (`stop` / `best-judgment`, default `stop`).** `stop` leaves the choice to you (recommended); `best-judgment` picks the last "Other" option and answers with `decisionAnswer` ("use your best judgment"), falling back to `stop` if it can't drive the popup.

### Fixed

* A `waiting_input` postMessage with no popup on screen now correctly maps to `WAITING_CONTINUE` (a nudge) instead of being mistaken for a question — the previous `questionHints` selectors (`[role="radiogroup"]`, `approval_`, `permission_`) never matched the real DOM, so real permission/decision popups could slip through and get a blind "continue".

## \[0.1.4] - 2026-06-04

### Fixed

* **A shift no longer gets orphaned by a window reload.** Ownership of a shift was pinned to the webview instance id, so after any reload the new instance saw the shift as "on" but not owned by it and did nothing — the shift silently stalled until manually toggled. Ownership is now a heartbeat lease: a live panel takes over automatically when the previous owner's lease goes stale. This is the most likely cause of "turned it on overnight and it never resumed".
* **Shift no longer dies during a rate limit it didn't precisely detect.** If a usage limit hit but the exact notice wasn't matched, output stopped growing, the stall detector mistook it for "task done", and the shift stopped, so nothing resumed after the reset. Now, before declaring done on a stall, a wide net checks for any limit-looking text and sleeps (waiting out the reset) instead of stopping. `enterSleep` also tries harder to parse the reset time from surrounding text.

### Added

* `__nonstopDebug.status()` for live diagnostics (enabled, state, sleeping-until, pings, last-stop reason) and `__nonstopDebug.simulateRateLimit(seconds)` to test the wait→resume cycle in seconds instead of waiting for a real limit. The last-stop reason is also persisted.

## \[0.1.3] - 2026-06-04

### Changed

* **Settings popup (right-click) improved:** the header shows live `● ON`/`● OFF` state, the "Pause during" field got a clearer placeholder (`e.g. 09:00-17:00`), and "Stop after (minutes)" shows a live hours conversion (`= 8h`). Fixed it spilling past the panel edges — the popup is now measured and clamped within the viewport (including the bottom edge).
* **More readable ping text:** `continue - reply NONSTOP_DONE when fully done` (instead of line breaks that got swallowed by the plaintext input and mashed together).
* **Status bar reflects real injection state:** `$(check)` active / `$(warning) reload` / `$(circle-slash)` no panel found.

### Added

* README screenshots (the ♾️ button in the footer + the settings popup) and Marketplace metadata (`galleryBanner`, `AI` category, `homepage`/`bugs`).
* Unit tests for DST transition edges (spring-forward gap / fall-back overlap).

### Removed

* Trimmed dead code from the VSIX (`src/ratelimit/**` excluded) — 18 → 16 files.

## \[0.1.2] - 2026-06-04

### Added

* **Real, timezone-aware rate-limit detection.** Captured Claude's actual notice ("You've hit your session limit · resets 10:10pm (Asia/Jerusalem)"). Detection was rewritten around it, and the reset time is resolved in the reported IANA timezone — correct for every user worldwide even when their OS clock is in a different zone, including DST.
* **Capture harness.** Scans the panel with a wide keyword net and stashes a snippet of a real limit notice to localStorage (readable via `__nonstopDebug.rateLimitCapture()`), so it can be tuned later even without DevTools open.
* **Unit tests for rate-limit detection/parsing** (`src/ratelimit/resetTime.js`): 11 new tests (29 total), including timezone-aware resolution verified under several host timezones, DST, and roll-to-tomorrow.

### Changed

* **Button placement.** The ♾️ now sits in its own div to the left of Claude's native mode button ("Auto mode") instead of depending on an external extension — a consistent spot for all users, with no extension dependency.

### Decided

* **usage-core (structured rate-limit) deferred from the MVP.** DOM detection is verified and accurate, so there's no need for a host↔webview channel or a per-platform binary. Kept as a future option.

## \[0.1.1] - 2026-06-04

### Changed

* **Injection resilience.** Added a reinject pass triggered when the VS Code window regains focus (`onDidChangeWindowState`, throttled to 30s). If something edits Claude's shared webview file and removes Nonstop's injection, recovery previously relied only on the 6-hour periodic check. The "dead window" now shrinks from hours to seconds.

## \[0.1.0] - 2026-06-03

Initial implementation (Phase 0 + Phase 1 skeleton):

* Host-side injection core: `injector` with position-based idempotency (a two-sided marker pair), `atomicWrite` (atomic write + verify-after-write), `targets/claude-code` (active-version detection), `coexistence` (detect another extension's injection and never clobber it).
* `extension.js`: injection lifecycle, periodic reinject, VS Code commands, status bar.
* Injected script `webview/nonstop.js`: ON/OFF button (♾️), layered state detection (postMessage→DOM→heuristic), ping engine, done detection (sentinel + stall), question handling (`onQuestion`), rate-limit waiting (DOM), backstops (maxRuntime/maxPings/quiet hours/user-activity), a multi-panel ownership rule, and a debug mode.
* 18 host unit tests (injector/coexistence/atomicWrite/ratelimit) — all passing.

> Requires live verification against the panel (see README) before unattended overnight use.

