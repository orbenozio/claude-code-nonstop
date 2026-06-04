# TASKS

מסמך מעקב משימות חי. סמן `[x]` כשמשימה הושלמה; הוסף משימות חדשות מתחת תוך כדי עבודה.
נגזר מ-[SPEC.md](SPEC.md) (v0.2) ו-[RECON.md](RECON.md).

## Todo

### Phase 3 — המתנה-וחידוש מול rate limit (נותר לאימות חי)

* [ ] אימות תקפות token של usage-core בריצה לילית ארוכה
* [ ] אריזת `bin/usage-core-*` (win32-x64 מקומית; שאר הפלטפורמות בזמן VSIX)
* [ ] חיבור structured (host) ל-webview (דורש ערוץ host↔webview) — או להישאר על DOM fallback

### Phase 4 — ליטוש ואריזה

* [ ] אריזת usage-core לכל הפלטפורמות, VSIX, פרסום למרקטפלייס
* [ ] ריצת לילה אמיתית מקצה-לקצה (≥5 ערבים) + עמידה במטריקות §8.3

## In progress

* [ ] גרסת שימוש מוזרקת (Nonstop, ♾️, 60ש', debug כבוי) — מוכנה לניסיון אמיתי

## Done

* [x] **Phase 3 — זיהוי rate-limit אמיתי:** נלכד הנוסח האמיתי ("You've hit your session limit · resets 10:10pm (Asia/Jerusalem)"), תוקנו ה-regexes ו-`parseResetTime` (מאומת מקצה-לקצה). גם ריצת-לילה אמיתית אחת הצליחה: המתין, חידש מאותה נקודה, סיים ב-NONSTOP_DONE.
* [x] איפיון (SPEC.md v0.1) דרך architect DRAFT
* [x] ביקורת כפולה: spec-reviewer + architect REVIEW
* [x] עדכון איפיון ל-v0.2 (החלטות + תיקוני ביקורת + אילוץ מרקטפלייס)
* [x] Phase 0 recon: ניתוח bundle של Claude + מנגנון usage-core, תיעוד ב-RECON.md
* [x] Phase 1: אתחול repo (package.json, manifest, .gitignore, constants)
* [x] Phase 1: ליבת host — injector (idempotency מבוסס-מיקום), atomicWrite, targets, coexistence, statusBar, extension.js
* [x] Phase 1: סקריפט מוזרק webview/night-shift.js
* [x] בדיקות: 18 יוניט-טסטים + integration מול ה-bundle האמיתי — עוברים
* [x] README (RTL) + CHANGELOG + bin/README
* [x] **אימות חי בפאנל:** כפתור ON/OFF (ויזואל + מיקום ליד הזרוע)
* [x] **אימות חי:** שליחת פינג ל-contenteditable עובדת (execCommand + Enter)
* [x] **אימות חי:** זיהוי WORKING מבוסס output-growth (אמין, ללא תלות בסלקטורים)
* [x] **אימות חי:** לולאת פינג חוזרת + עצירת done-sentinel (ספירה, ללא false-positive)
* [x] **אימות חי:** דו-קיום עם RTL (ההזרקה נשמרת זה לצד זה)
* [x] תיקוני באגים מהאימות: stall per-ping, sentinel-count, user-activity scoped-to-input
* [x] **רברנדינג ל-Nonstop:** repo פרטי github.com/orbenozio/claude-code-nonstop + LICENSE
* [x] **רינשум פנימי מלא** Night Shift → Nonstop (מזהים, markers, localStorage, שם קובץ, אייקון ♾️)
* [x] **קליק-ימני על הכפתור:** popup הגדרות (אינטרוול/טקסט/שעות-שקט/תקרות) עם labels ברורים
* [x] git: gh נמצא + הוסף ל-PATH הקבוע (דורש restart ל-VS Code)
* [x] שינוי שם התיקייה הפיזית → `claude-code-nonstop` (junctions תקינים — מצביעים ל-Agents המרכזי)
* [x] עדכון "Night Shift" בתיעוד היסטורי (SPEC.md / RECON.md נקיים)
* [x] הקשחת דו-קיום עם RTL: reinject גם ב-window focus (onDidChangeWindowState, throttle 30ש') — מצמצם "זמן מת" אחרי שחזור RTL מ-6ש' לשניות

