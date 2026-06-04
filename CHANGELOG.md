# Changelog

## [0.1.3] - 2026-06-04

### Changed

- **חלונית ההגדרות (קליק-ימני) שופרה:** הכותרת מציגה מצב חי `● ON`/`● OFF`, השדה "Pause during" קיבל placeholder ברור (`e.g. 09:00-17:00`), ו-"Stop after (minutes)" מציג המרה חיה לשעות (`= 8h`). תוקנה חריגה מגבולות הפאנל — החלונית נמדדת ומתמקמת בתוך המסך (כולל הקצה התחתון).
- **טקסט הפינג קריא יותר:** `continue - reply NONSTOP_DONE when fully done` (במקום שורות שנבלעו בתיבת הקלט והודבקו זו לזו).
- **status bar משקף מצב הזרקה אמיתי:** `$(check)` פעיל / `$(warning) reload` / `$(circle-slash)` אין פאנל.

### Added

- צילומי מסך ל-README (כפתור ה-♾️ ב-footer + חלונית ההגדרות) ומטא-דאטה ל-Marketplace (`galleryBanner`, קטגוריית `AI`, `homepage`/`bugs`).
- בדיקות יחידה לקצוות מעברי DST (spring-forward gap / fall-back overlap).

### Removed

- ניקוי dead code מה-VSIX (`src/ratelimit/**` הוחרג) — 18→16 קבצים.

## [0.1.2] - 2026-06-04

### Added

- **זיהוי rate-limit אמיתי + timezone-aware.** נלכד הנוסח האמיתי של Claude ("You've hit your session limit · resets 10:10pm (Asia/Jerusalem)"). הזיהוי נכתב מחדש סביבו, וזמן האיפוס נפתר ב-timezone שדווח (IANA) — נכון לכל משתמש בעולם גם כששעון ה-OS שלו באזור אחר, כולל DST.
- **מנגנון לכידה (capture harness).** סורק את הפאנל ברשת-מילים רחבה ושומר snippet של הודעת מגבלה אמיתית ל-localStorage (נגיש דרך `__nonstopDebug.rateLimitCapture()`), לכיוונון עתידי גם בלי DevTools פתוח.
- **בדיקות יחידה לזיהוי/פרסור ה-rate-limit** (`src/ratelimit/resetTime.js`): 11 טסטים חדשים (29 בסך הכל), כולל timezone-aware מאומת תחת כמה אזורי-זמן, DST, וגלילה ל"מחר".

### Changed

- **מיקום הכפתור.** ה-♾️ יושב כעת ב-div משלו משמאל לכפתור ה-mode הנייטיב של Claude ("Auto mode"), במקום להיתלות בתוסף חיצוני — מיקום אחיד לכל המשתמשים, ללא תלות בתוספים.

### Decided

- **usage-core (structured rate-limit) נדחה מה-MVP.** זיהוי ה-DOM אומת ומדויק, אז אין צורך בערוץ host↔webview ובאריזת בינארי לכל פלטפורמה. נשמר כאופציה עתידית.

## [0.1.1] - 2026-06-04

### Changed

- **חוסן הזרקה.** נוסף מנגנון reinject שמופעל כשחלון VS Code חוזר לפוקוס (`onDidChangeWindowState`, עם throttle של 30ש'). אם משהו משנה את קובץ ה-webview המשותף של Claude וההזרקה של Nonstop מוסרת, ההתאוששות עד כה הסתמכה רק על בדיקה תקופתית כל 6 שעות. כעת ה"זמן המת" מצטמצם משעות לשניות.

## [0.1.0] - 2026-06-03

מימוש ראשוני (Phase 0 + שלד Phase 1):

- ליבת הזרקה ב-host: `injector` עם idempotency מבוסס-מיקום (זוג markers דו-צדדי), `atomicWrite` (כתיבה אטומית + verify-after-write), `targets/claude-code` (זיהוי גרסה פעילה), `coexistence` (זיהוי הזרקה של תוסף אחר ואי-דריסה).
- `extension.js`: מחזור הזרקה, reinject תקופתי, פקודות VS Code, status bar.
- סקריפט מוזרק `webview/nonstop.js`: כפתור ON/OFF (♾️), זיהוי מצב שכבתי (postMessage→DOM→heuristic), מנוע פינג, זיהוי done (sentinel + stall), טיפול בשאלות (`onQuestion`), המתנה מול rate-limit (DOM), backstops (maxRuntime/maxPings/quiet hours/user-activity), כלל בעלות לריבוי-פאנלים, ומצב debug.
- מודול `ratelimit/structured` (usage-core מצורף) — מוכן, ממתין לערוץ host↔webview.
- 18 יוניט-טסטים ב-host (injector/coexistence/atomicWrite/ratelimit) — כולם עוברים.

> דורש אימות חי מול הפאנל (ראו README → "אימות חי נדרש") לפני שימוש לילי.
