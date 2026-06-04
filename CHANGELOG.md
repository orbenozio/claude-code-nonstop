# Changelog

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

