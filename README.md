# Claude Code Night Shift 🌙

תוסף VS Code שמאפשר ל-Claude Code להמשיך לעבוד בשעות שאתם ישנים. כפתור הפעלה/כיבוי בתוך פאנל Claude, "פינג" אוטומטי שממשיך משימות ארוכות, ומודעות למגבלת השימוש (rate limit) — המתנה עד פתיחת החלון הבא והמשך עבודה אוטומטי.

> **סטטוס: בפיתוח (0.1.0).** ליבת ה-host והסקריפט המוזרק קיימים ונבדקו ביוניט-טסטים. כמה חלקים תלויי-DOM דורשים אימות וכיוונון מול הפאנל החי לפני שימוש לילי לא-מפוקח — ראו "אימות חי נדרש".

## איך זה עובד

ל-VS Code אין API להוספת כפתורים לפאנל של Claude Code, ולכן התוסף משתמש בטכניקת **הזרקת webview** מוכחת:

1. בצד ה-host (`src/extension.js`) — מאתר את גרסת Claude Code הפעילה ומצרף את הסקריפט `webview/night-shift.js` לסוף קובץ ה-`webview/index.js` שלה (עם גיבוי וכתיבה אטומית).
2. הסקריפט המוזרק רץ בתוך ה-DOM של הפאנל: בונה כפתור 🌙 ב-footer, מזהה מתי Claude ממתין להמשך, ושולח "פינג".

ההזרקה **דו-צדדית מבוססת markers** כדי לחיות בשלום לצד תוסף ה-RTL שמזריק לאותו קובץ.

## שימוש

* לחיצה על 🌙 ב-footer של תיבת הקלט מדליקה/מכבה את המשמרת. כשהיא ON הכפתור פועם.
* פקודות (Command Palette): `Night Shift: Check & Inject`, `Night Shift: Remove Injection`, `Night Shift: Menu`.
* אחרי הזרקה ראשונה — Reload Window כדי שהסקריפט ייטען.

## הגדרות עיקריות

| הגדרה | ברירת מחדל | מה |
| --- | --- | --- |
| `nightShift.pingText` | `continue` | ההודעה שנשלחת בכל פינג |
| `nightShift.pingIntervalMs` | `60000` | מרווח מינימלי בין פינגים |
| `nightShift.maxRuntimeMs` | `28800000` (8ש') | תקרת אורך משמרת (זמן sleep מול rate-limit לא נספר) |
| `nightShift.maxPings` | `100` | תקרת פינגים למשמרת |
| `nightShift.quietHours` | `""` | חלון ללא פינג, למשל `23:00-07:00` |
| `nightShift.onQuestion` | `stop` | כש-Claude שואל שאלה: `stop` (לעצור) או `answer` (תשובה ניטרלית) |
| `nightShift.sentinelDoneDetection` | `true` | להוסיף לפינג בקשת סימן סיום (`NIGHTSHIFT_DONE`) |
| `nightShift.rateLimitFallbackMs` | `18000000` (5ש') | המתנה כשלא ניתן לקבוע זמן איפוס מדויק |
| `nightShift.debug` | `false` | לוג recon מפורט בסקריפט המוזרק |

## בטיחות

* **עצירה אמינה = כפתור ה-OFF בפאנל.** (פקודת "Stop Now" מה-host היא best-effort בלבד — אין ערוץ host↔webview ב-MVP.)
* תקרות `maxRuntime`/`maxPings`, שעות שקט, והשהיה אוטומטית כשמזוהה פעילות משתמש — מונעים לולאה בורחת.
* מול rate limit התוסף **ישן** עד האיפוס במקום לפנג בלולאה.

## אזהרת מדיניות שימוש (ToS)

המשך אוטומטי לא-מפוקח של מודל עשוי לעמוד בניגוד למדיניות השימוש של הספק ו/או לבזבז מכסה על עבודה לא רצויה. השימוש באחריותכם. ברירות המחדל שמרניות בכוונה.

## אימות חי נדרש (לפני שימוש לילי)

הופק מ-recon סטטי של ה-bundle; הפריטים הבאים דורשים כיוונון מול הפאנל החי (הפעילו `nightShift.debug` והשתמשו ב-`window.__nightShiftDebug` ב-DevTools של הפאנל):

1. האם ניטור `postMessage` תופס את מצב ה-session (`running`/`waiting_input`/`idle`).
2. הסלקטורים בפועל ל-WORKING (כפתור Stop/streaming) ול-WAITING_QUESTION (UI אישור/שאלה) — מסומנים `TUNE` ב-`webview/night-shift.js` תחת `SIGNALS`.
3. איזו שיטת הזרקת-טקסט שולחת בפועל את הפינג (execCommand / InputEvent / כפתור שליחה).
4. ניסוחי הודעת ה-rate-limit ב-DOM (ל-fallback) + תקפות ה-token של usage-core בריצה לילית.

## פיתוח

```
npm test     # מריץ את יוניט-הטסטים של ה-host (18 בדיקות)
```

ראו [SPEC.md](SPEC.md) לאיפיון המלא, [RECON.md](RECON.md) לממצאי ה-recon, ו-[TASKS.md](TASKS.md) למעקב.

## רישוי

MIT.
