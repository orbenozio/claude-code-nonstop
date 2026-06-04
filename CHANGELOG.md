# Changelog

## \[0.2.1] - 2026-06-04

### Added

* The status bar and the right-click popup header now show the running version (e.g. `Nonstop v0.2.1`). The status bar reflects the installed extension; the popup reflects the injected webview — so if they ever differ, a stale injection is obvious at a glance.

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

