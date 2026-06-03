# Changelog

## 0.1.0 — לא פורסם (בפיתוח)

מימוש ראשוני (Phase 0 + שלד Phase 1):

- ליבת הזרקה ב-host: `injector` עם idempotency מבוסס-מיקום (זוג markers דו-צדדי), `atomicWrite` (כתיבה אטומית + verify-after-write), `targets/claude-code` (זיהוי גרסה פעילה), `coexistence` (זיהוי RTL ואי-דריסה).
- `extension.js`: מחזור הזרקה, reinject תקופתי, פקודות VS Code, status bar.
- סקריפט מוזרק `webview/night-shift.js`: כפתור ON/OFF (🌙), זיהוי מצב שכבתי (postMessage→DOM→heuristic), מנוע פינג, זיהוי done (sentinel + stall), טיפול בשאלות (`onQuestion`), המתנה מול rate-limit (DOM), backstops (maxRuntime/maxPings/quiet hours/user-activity), כלל בעלות לריבוי-פאנלים, ומצב debug.
- מודול `ratelimit/structured` (usage-core מצורף) — מוכן, ממתין לערוץ host↔webview.
- 18 יוניט-טסטים ב-host (injector/coexistence/atomicWrite/ratelimit) — כולם עוברים.

> דורש אימות חי מול הפאנל (ראו README → "אימות חי נדרש") לפני שימוש לילי.
