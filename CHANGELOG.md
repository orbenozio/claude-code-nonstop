# Changelog

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

