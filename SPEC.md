# Claude Code Nonstop — מסמך איפיון טכני

> תוסף VS Code עצמאי שמאפשר ל-Claude Code להמשיך לעבוד בשעות שאתם ישנים. כפתור הפעלה/כיבוי בפאנל, "פינג" אוטומטי שממשיך משימות ארוכות, ומודעות למגבלת השימוש (rate limit) — המתנה עד פתיחת החלון הבא והמשך עבודה אוטומטי.

גרסת מסמך: 0.2 · תאריך: 2026-06-03

> **מה השתנה מ-0.1 (אחרי spec-reviewer + architect REVIEW):** הוספת אילוץ פרסום למרקטפלייס (עצמאי לחלוטין); מעבר לזיהוי מצב מבוסס session-state של Claude במקום ניחוש DOM; מעבר למקור rate-limit מובנה (usage-core מצורף) במקום גירוד מחרוזות; תיקון מודל הדו-קיום עם RTL לפי הקוד האמיתי (RTL מזריק לשני קבצים, restore חותך עד-סוף-קובץ, יש write race); idempotency מבוסס-מיקום + כתיבה אטומית; טיפול במצב "Claude שואל שאלה" (ניתן להגדרה); kill-switch ב-webview; טבלת קונפיג מלאה; Phase 0 כ-recon spike.

***

## 1. מטרות, קהל יעד והיקף

### 1.1 מטרת המוצר

לאפשר למשתמש להפעיל מצב "משמרת לילה": Claude Code ממשיך להתקדם במשימה ארוכה ללא נוכחות אנושית, כולל התמודדות חכמה עם מגבלת השימוש (rate limit) — במקום לנסות שוב ושוב ולהיכשל, התוסף מזהה את זמן האיפוס וממתין עד שהחלון נפתח מחדש.

### 1.2 קהל יעד והקשר הפצה

* **המוצר ייצא כתוסף ציבורי ב-VS Code Marketplace.** מכאן נגזר אילוץ-על: **עצמאי לחלוטין** — אסור להניח קיומם של תוספים אחרים אצל מי שמתקין (בפרט אסור להישען על תוסף ה-`claude-code-usage-indicator` של המחבר; רוב המשתמשים לא יתקינו אותו). כל יכולת שנשענת על רכיב חיצוני — חייבת לארוז את אותו רכיב בתוך התוסף עצמו, או להתנוון בחן (graceful) בלעדיו.
* המשתמש הטיפוסי הראשוני: משתמש כוח על Windows 11 + VS Code desktop. אין מרובה-משתמשים, אין שרת, אין סנכרון ענן; כל ההגדרות מקומיות.

### 1.3 בתוך ההיקף (In Scope)

* כפתור הפעלה/כיבוי (ON/OFF) ב-footer של תיבת הקלט בפאנל Claude Code.
* מנגנון "פינג" שמזריק הודעת המשך לתיבת הקלט ושולח אותה, בתנאים מבוקרים.
* זיהוי מצב "עובד" / "ממתין להמשך" / "ממתין לתשובת-משתמש (שאלה)" / "סיים", כדי לא להפריע באמצע עבודה ולא לענות תשובות אקראיות.
* זיהוי מצב rate limit וזמן האיפוס, תזמון "השכמה" והמשך אוטומטי — ממקור מובנה מצורף (4.6) עם fallback ל-DOM.
* מנגנוני בטיחות: עצירה מיידית, זמן ריצה מקסימלי, שעות שקט, זיהוי חזרת המשתמש למקלדת.
* מחזור חיים של ההזרקה: התקנה אידמפוטנטית מבוססת-מיקום, גיבוי, כתיבה אטומית, הזרקה-מחדש אחרי עדכוני Claude Code/התוסף, הסרה נקייה.
* דו-קיום בטוח עם התוסף `rtl-for-vs-code-agents` שמזריק לאותו קובץ.

### 1.4 מחוץ להיקף (Out of Scope)

* אינטגרציה עם ה-API הרשמי של Anthropic או הרצת Claude ב-headless/CLI (המוצר עובד מול פאנל ה-UI הקיים בלבד).
* **תלות בתוסף `claude-code-usage-indicator` או בכל תוסף צד-שלישי אחר** (ראו 1.2). מנגנון ה-usage-core ייארז עצמאית.
* הרצה על פלטפורמות אחרות כמטרה ראשונית (Cursor/Insiders/WSL נתמכים ברמת "best effort" באיתור התקנות בלבד — ראו 6.2).
* כתיבת קוד, תכנון משימות, או קבלת החלטות תוכן עבור Claude. התוסף רק "דוחף המשך".
* אישור אוטומטי של קריאות כלים (tool approvals). זו אחריות פיצ'ר ה-YOLO בתוסף ה-RTL; ראו 4.5.
* מובייל / web / סביבות שאינן desktop VS Code.

### 1.5 הנחת יסוד מרכזית והצדקת הקיום

אין פיצ'ר מובנה ב-Claude Code ל"המתן עד איפוס מגבלה והמשך". `/loop` ו-`/goal` קיימים אך אינם מטפלים בהמתנה-וחידוש סביב rate limit. כאן הפער שהמוצר ממלא. *(הנחה לאימות חוזר: Claude Code מתעדכן מהר; יש לאמת שלא נוסף auto-retry מובנה על rate limit שמייתר חלק מהמוצר.)*

***

## 2. ארכיטקטורה

### 2.1 שני הקשרי הרצה (two execution contexts)

| חלק                      | רץ ב-                                                     | תפקיד                                                                                                                                 |
| ------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/extension.js`       | Extension Host (תהליך Node של VS Code)                    | מחזור חיי ההזרקה: איתור התקנות Claude Code, הזרקה/גיבוי/שחזור אטומיים, הזרקה-מחדש אחרי עדכון, פקודות, status bar. אין לו גישה ל-DOM. |
| `webview/nonstop.js` | Webview / browser context (תוך ה-DOM של פאנל Claude Code) | כל הלוגיקה התלויה-DOM: כפתור ON/OFF, מנוע פינג, זיהוי מצב (מבוסס session-state), זיהוי rate limit, תזמון חידוש, **ה-kill-switch הקשיח**. |

החלק השני **מצורף (appended) לסוף** קובץ ה-webview של Claude Code (`webview/index.js`) ע"י החלק הראשון, ולכן רץ בתוך ה-DOM של הפאנל.

### 2.2 גבולות ותקשורת בין החלקים

* **כיוון יחיד עיקרי:** ה-Host מזריק קוד; הקוד המוזרק רץ עצמאית ב-webview.
* **העברת קונפיגורציה:** ה-Host כותב `window.__NONSTOP_CONFIG__ = JSON.stringify(...)` לפני הסקריפט המוזרק (כמו `__RTL_CONFIG__`). seed ראשוני בלבד; חובה JSON.stringify כדי למנוע injection דרך `pingText`.
* **מצב חי + kill-switch:** נשמרים ב-`localStorage` של ה-webview. **החלטה: ה-kill-switch הקשיח (כל ה-backstops) חי ב-webview בלבד; אין ערוץ Host↔webview ב-MVP.**
* **השלכה מתועדת על "Stop Now" מה-Host:** מכיוון שאין postMessage ב-MVP, פקודת VS Code "Nonstop: Stop Now" שרצה ב-Host **אינה יכולה לעצור באופן ודאי** את הלולאה שב-webview (אין לה גישה ל-localStorage של ה-webview). לכן: **אמצעי העצירה האמין היחיד ב-MVP הוא הכפתור בתוך הפאנל.** פקודת ה-Host תוצג כ"best effort" בלבד (למשל ע"י כתיבת קובץ-דגל שה-webview בודק) או לא תיכלל ב-MVP. ראו 8.1.

### 2.3 גרעין + מתאמים (core + adapters)

* **גרעין (host):** `injector` — "אתר entry, גבה, הזרק עם marker אידמפוטנטי מבוסס-מיקום, כתוב אטומית, שחזר". מקבל target descriptor.
* **מתאם מטרה:** `targets/claude-code.js` — איפה Claude Code מותקן ומהו קובץ ה-entry. מטרה עתידית = קובץ נוסף.
* **מתאם מקור rate-limit (חדש):** `ratelimit/` — אבסטרקציה עם שני מימושים: (א) `structured` (usage-core מצורף, 4.6) כמקור ראשי, (ב) `dom-scrape` כ-fallback. ראו 5.4.
* ב-webview, הסלקטורים והאותות מרוכזים באובייקט `SIGNALS` יחיד (סלקטורים + נתיבי גישה ל-session-state) — עדכון בודד כשה-DOM/ה-state של Claude משתנה.

### 2.4 מבנה ה-repo

```
claude-code-nonstop/
├─ package.json                 # manifest: commands, configuration, activation
├─ README.md                    # תיעוד (עברית RTL, Markdown נקי)
├─ SPEC.md
├─ CHANGELOG.md
├─ src/
│  ├─ extension.js              # נקודת כניסה ל-Host (activate/deactivate)
│  ├─ injector.js               # גרעין: backup/inject/strip/restore אטומי + idempotency מבוסס-מיקום
│  ├─ atomicWrite.js            # כתיבה אטומית (temp + rename) + verify-after-write
│  ├─ targets/
│  │  └─ claude-code.js         # איתור התקנות + זיהוי הגרסה הפעילה
│  ├─ ratelimit/
│  │  ├─ structured.js          # קריאת usage-core המצורף → resets_at/retry_after/utilization
│  │  └─ bin/                   # ה-binary של usage-core, מצורף לכל פלטפורמה
│  ├─ coexistence.js            # זיהוי הזרקת RTL וכללי דו-קיום
│  └─ statusBar.js              # status bar + פקודות
├─ webview/
│  └─ nonstop.js            # הסקריפט המוזרק (browser context, IIFE)
├─ media/
└─ test/
```

***

## 3. בחירות טכנולוגיות

| תחום        | בחירה                                            | הצדקה (שורה אחת)                                                                   |
| ----------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| שפה         | JavaScript (CommonJS)                            | תואם לדפוס המוכח של RTL; מונע סיבוכי build של TS על קוד שמוזרק כטקסט גולמי.        |
| API         | VS Code Extension API (`engines.vscode ^1.85.0`) | רף תואם ל-RTL שכבר רץ אצל המשתמש.                                                  |
| הזרקה       | append ל-`webview/index.js` + backup + כתיבה אטומית | הטכניקה המוכחת היחידה — אין API רשמי להוספת כפתורים לפאנל.                       |
| מקור rate-limit | `usage-core` binary מצורף (JSON) + DOM fallback | מקור מובנה ומדויק (`resets_at`/`retry_after`), עצמאי, עמיד לשינויי UI.            |
| מצב webview | `localStorage`                                   | שורד reload, דפוס מוכח.                                                            |
| מצב Host    | `context.globalState`                            | injectedPaths/installedVersion, כמו ב-RTL.                                         |
| זיהוי מצב   | session-state של Claude + DOM fallback           | אותות לוגיים (`busy`/`pendingInput`/`waiting_input`) יציבים מ-class hashes.        |
| Node libs   | מובנים בלבד (`fs`, `path`, `os`, `child_process`)| `child_process` רק להרצת usage-core המצורף; אין תלויות צד-שלישי.                  |

אילוצי פלטפורמה: יעד ראשוני Windows 11 + VS Code desktop. ההזרקה כותבת לקובץ בתוך תיקיית ההתקנה של Claude Code (`~/.vscode/extensions`). ה-binary של usage-core חייב להיארז לכל פלטפורמה נתמכת (win/mac/linux × x64/arm64).

***

## 4. נתונים וממשקים

### 4.1 נקודת ההזרקה (host → webview)

* מיקום בסיס: `~/.vscode/extensions/anthropic.claude-code-<version>-<platform>/webview/index.js`. דוגמה אמיתית: `anthropic.claude-code-2.1.161-win32-x64`.
* אצל המשתמש קיימות **כ-8 גרסאות במקביל** (2.1.142 … 2.1.161). ההזרקה חייבת לטפל בזיהוי הגרסה ה**פעילה** — ראו 6.2.
* שמירת גיבוי: `index.js.nonstop-backup` (לא `index.js.backup` — תפוס ע"י RTL; ראו 7).

### 4.2 בלוק ההזרקה (פורמט)

מצורף לסוף הקובץ, עטוף ב-markers דו-צדדיים ייחודיים הכוללים גרסה:

```JavaScript
// >>> Claude Code Nonstop (injected) v<X.Y.Z> >>>
window.__NONSTOP_CONFIG__ = JSON.parse("...");  // seed, JSON.stringify מצד ה-Host
(function(){ /* תוכן webview/nonstop.js */ })();
// <<< Claude Code Nonstop (injected) <<<
```

ה-markers בשני הקצוות מאפשרים חיתוך מדויק של ההזרקה גם כשהזרקה אחרת (RTL) נמצאת לפניה או אחריה. זהו הבדל מהותי מ-RTL, שחותך מה-marker ועד סוף הקובץ. **החיתוך הדו-צדדי אינו "אופטימיזציה" אלא חובה** (ראו 7).

### 4.3 זיהוי מצב — מבוסס session-state (לב המוצר)

> ממצא הביקורת: ה-bundle של Claude Code כבר חושף מודל מצב לוגי. זה מחליף את הניחוש מבוסס-class-hashes ומקטין דרמטית את סיכון השבירות.

מקור ראשי — **session-state של Claude** (לאימות נתיב הגישה ב-Phase 0):

* `session.busy.value` — `true` בזמן שהמודל עובד/streaming.
* `session.pendingInput.value` / `state === "waiting_input"` — ממתין לקלט משתמש.
* `state === "idle"` — לא עובד, אין pending.

מצבים נגזרים שהמנוע מבחין ביניהם:

1. **WORKING** — `busy === true`. לא לפנג.
2. **WAITING_CONTINUE** — idle/ממתין להמשך כללי, תיבת קלט ריקה. מועמד לפינג.
3. **WAITING_QUESTION** — Claude שאל שאלת הבהרה/בחירה (לזהות ע"י נוכחות רכיב שאלה/אפשרויות ב-DOM, או הבחנה ב-pendingInput מסוג שאלה). **התנהגות ניתנת-להגדרה** (ראו 4.4 `onQuestion`).
4. **DONE** — ראו 5.3.

> Fallback: אם נתיב ה-session-state לא נגיש או נשבר בעדכון, ליפול ל-DOM heuristics (תיבה ריקה + היעדר אינדיקציית streaming). מסומן כ-fallback בלבד.
> סלקטורים יציבים-יחסית (אומתו מול RTL): footer = `[class*="inputFooter_"]`; תיבת קלט = `div[contenteditable="plaintext-only"][role="textbox"]`; כפתור ראשי = `[class*="footerButtonPrimary_"]`.

### 4.4 קונפיג מלא (seed מה-Host) + מצב localStorage

טבלת קונפיג (`window.__NONSTOP_CONFIG__`, וגם `contributes.configuration` ב-package.json):

| מפתח              | טיפוס   | ברירת מחדל | טווח/יחידה            | תיאור                                                              |
| ----------------- | ------- | ---------- | --------------------- | ----------------------------------------------------------------- |
| `pingText`        | string  | `"continue"` | טקסט חופשי           | ההודעה שנשלחת בכל פינג.                                            |
| `pingIntervalMs`  | number  | `60000`    | 15000–600000 (ms)     | מרווח מינימלי בין פינגים (לא בין poll-ים).                          |
| `pollMs`          | number  | `1000`     | 500–5000 (ms)         | תדירות בדיקת מצב.                                                  |
| `maxRuntimeMs`    | number  | `28800000` (8ש') | 0=ללא / עד 24ש'   | תקרת אורך משמרת. זמן sleep מול rate-limit **לא נספר** בתוכה (8.1). |
| `maxPings`        | number  | `100`      | 0=ללא / 1–10000       | תקרת פינגים למשמרת.                                                |
| `quietHours`      | string  | `""`       | `"23:00-07:00"` או ריק | חלון ללא פינג (תומך חציית-חצות).                                  |
| `onQuestion`      | enum    | `"stop"`   | `stop` / `answer`     | התנהגות במצב WAITING_QUESTION. `stop`=לעצור ולהמתין לבוקר; `answer`=לשלוח תשובה ניטרלית. |
| `questionAnswer`  | string  | `"continue, use your best judgment"` | טקסט | התשובה הניטרלית כש-`onQuestion="answer"`.            |
| `doneStallPings`  | number  | `3`        | 1–20                  | כמה פינגים רצופים ללא תוכן חדש משמעותי לפני קביעת DONE (5.3).        |
| `rateLimitFallbackMs` | number | `18000000` (5ש') | 600000–43200000 | המתנה כשלא ניתן להשיג זמן איפוס מדויק (5.4).                  |
| `reinjectCheckHours` | number | `6`      | 0=כבוי / 1–48         | תדירות בדיקת הזרקה-מחדש.                                           |

מצב localStorage (מקורות אמת בזמן ריצה):

* `nonstop-enabled` — `"true"`/`"false"`.
* `nonstop-sleep-until` — timestamp (ms) של השכמה אחרי rate limit, או ריק.
* `nonstop-session-start` — תחילת המשמרת (לאכיפת maxRuntime).
* `nonstop-ping-count` — מונה פינגים במשמרת.
* `nonstop-owner-id` — מזהה ה-instance שמנהל את המשמרת (לריבוי-פאנלים; ראו 4.7).

**מחזור חיי מוני המשמרת (חובה מוגדר):** `session-start` ו-`ping-count` מאופסים **רק במעבר ידני OFF→ON**. הם **שורדים reload ו-reinject** (אינם מתאפסים בטעינה מחדש), כדי שה-backstop לא "ייאפס" בכל עדכון של Claude וירוקן את משמעותו. בזמן `sleep-until` פעיל, מונה ה-runtime **מוקפא** (הפרש זמן ה-sleep מנוכה מחישוב maxRuntime) — sleep של 5 שעות לא "ישרוף" את תקציב ה-8 שעות.

### 4.5 גבול קריאה/כתיבה ואבטחה

* ה-Host **כותב** רק ל-`index.js` של Claude Code ול-backup שלו (כתיבה אטומית), ומריץ את ה-binary המצורף של usage-core. אינו נוגע בקבצים אחרים, ובפרט **לא נוגע ב-`extension.js`** (שם RTL מזריק את הזרקתו השנייה — ראו 7).
* ה-webview קורא מצב, כותב טקסט לתיבת הקלט, ו"לוחץ" שליחה. אינו מאשר קריאות כלים.
* `pingText`/`questionAnswer` עוברים JSON.stringify לפני הזרקה.

### 4.6 מקור rate-limit מובנה (usage-core מצורף)

* התוסף **אורז עותק משלו** של מנגנון usage-core (binary לכל פלטפורמה תחת `src/ratelimit/bin/`) — **ללא תלות** בתוסף ה-usage-indicator (1.2).
* המנגנון מחזיר JSON עם `five_hour.utilization`, `five_hour.resets_at`, `seven_day`, `retry_after`. זהו timestamp מדויק לאיפוס + אחוז ניצול — בדיוק מה שצריך כדי להחליט "לישון עד X".
* **אזהרת token (לאימות ב-Phase 0/3):** usage-core נשען על credentials של Claude Code; ייתכן שה-token מתרענן רק כשהפאנל פתוח/פעיל. לריצת לילה לא-מפוקחת יש לוודא שה-token תקף לאורך כל החלון; אחרת — נופלים ל-DOM fallback (5.4).

### 4.7 ריבוי פאנלים/חלונות (scoping)

ה-bundle מבחין בין `IS_SIDEBAR`, `IS_FULL_EDITOR`, `IS_SESSION_LIST_ONLY` — אותו `index.js` רץ בכמה הקשרים, וייתכנו כמה instances של הסקריפט המוזרק בו-זמנית (sidebar + editor tab + חלון שני), חולקים `localStorage`. **כלל בעלות:** instance בודד "בעל המשמרת" (לפי `nonstop-owner-id` שנכתב כשמדליקים ON), ורק הוא מפנג. instances אחרים מציגים מצב אך לא פועלים — כדי למנוע פינג כפול.

***

## 5. מנוע הפינג, זיהוי מצב, וחידוש אחרי rate limit

### 5.1 מתי לפנג?

הכלל: **לפנג רק במצב WAITING_CONTINUE**. לולאת ה-poll (כל `pollMs`):

1. **WORKING** → לא לפנג, להמתין.
2. **rate limit** (4.6/5.4) → לעבור ל-sleep, לא לפנג.
3. **DONE** (5.3) → לעצור משמרת.
4. **WAITING_QUESTION** → לפי `onQuestion`: `stop` → לעצור משמרת ולהשאיר את השאלה למשתמש; `answer` → לשלוח `questionAnswer`.
5. **WAITING_CONTINUE** → אם עבר `pingIntervalMs` מאז הפעולה האחרונה, לא בשעות שקט, התיבה ריקה ואני בעל-המשמרת → לפנג.

### 5.2 ביצוע הפינג (כתיבה ל-contenteditable + שליחה)

תיבת הקלט היא `contenteditable` — `.value` לא יעבוד. לפי סדר עדיפות לבדיקה אמפירית (Phase 0; RTL כבר מוכיח שליטה באותו פאנל, אז סיכון נמוך):

1. `el.focus()` ואז `document.execCommand('insertText', false, pingText)`.
2. אם נכשל: `InputEvent('beforeinput'/'input', { inputType:'insertText', data })` ידני.
3. שליחה: כפתור שליחה אם קיים; אחרת `KeyboardEvent('keydown',{key:'Enter'})`.

**טיפול בכשל שליחה (חובה):** לפני כל פינג, לוודא שהתיבה ריקה; אם נותר טקסט שלנו מפינג קודם (Enter יצר שורה חדשה במקום לשלוח) — לנקות ולא לצבור. אחרי שליחה: לעדכן `ping-count` + "זמן פעולה אחרון", cooldown קצר. **flag "אני כותב עכשיו"** מסמן את ה-events שלנו כדי שזיהוי חזרת-המשתמש (8.1) לא יתבלבל מהם.

### 5.3 זיהוי "המשימה הסתיימה" (done)

* **Backstop ראשי (תמיד פעיל):** `maxPings` + `maxRuntimeMs`.
* **Sentinel (מנגנון מומלץ):** הפינג כולל הוראה ש-Claude יכתוב מחרוזת סימן (למשל `NONSTOP_DONE`) כשהמשימה הושלמה; ה-webview מזהה אותה ועוצר. זהו אות ה-done **האמין ביותר** — מקודם מ"אופציונלי עתידי" ל**ברירת מחדל מומלצת** (כפוף להסכמת המשתמש על ניסוח הפינג).
* **Heuristic גיבוי:** אם `doneStallPings` פינגים רצופים לא הניבו תוכן חדש משמעותי (אורך/hash של ההודעה האחרונה לא משתנה) → לעצור. זהו מנגנון "לעצור בבטחה" (false-positive = עצירה מוקדמת, מקובל), לא מדד הצלחה.

### 5.4 זיהוי rate limit וחידוש (הבידול המרכזי)

**מקור ראשי — structured (4.6):** ב-poll, לקרוא `five_hour.utilization`/`resets_at`/`retry_after` מ-usage-core המצורף. אם מזוהה מיצוי מגבלה → לכתוב `sleep-until = resets_at` (או `now + retry_after`), לעצור פינגים, ולחדש בזמן (עם jitter 30–120ש'). **אין צורך בפרסור מחרוזות/אזורי-זמן** — הזמן מובנה ומדויק.

**Fallback — DOM scrape:** אם usage-core לא זמין/ה-token פג, לזהות הודעת מגבלה ב-DOM. *(הניסוחים המדויקים טרם נאספו — הם תוכן streamed מהשרת, לא מחרוזות סטטיות ב-bundle; ייאספו מ-rate-limit אמיתי ב-Phase 3. אין להניח ניסוח מסוים מראש.)* אם לא ניתן לפרסר זמן → להמתין `rateLimitFallbackMs` ואז פינג בודד "זהיר"; אם המגבלה עדיין שם — להמתין שוב. **לעולם לא לפנג בלולאה צמודה מול מגבלה.**

***

## 6. מחזור חיי ההזרקה

### 6.1 הפעלה (activate)

1. `handleVersionUpgrade`: אם גרסת התוסף השמורה שונה → לשחזר ולהזריק-מחדש את הסקריפט החדש.
2. לאתר את התקנת/גרסת Claude Code ה**פעילה** (6.2).
3. אם לא מוזרקת בגרסה הנוכחית — לגבות ולהזריק (אידמפוטנטי מבוסס-מיקום, כתיבה אטומית).
4. status bar + פקודות.
5. להציע "Restart Extension Host / Reload Window".

### 6.2 איתור ההתקנה והגרסה הפעילה

לסרוק את אותם בסיסים כמו RTL (best effort): `~/.vscode/extensions` (ראשי), `~/.vscode-server*`, `~/.cursor*`.

> **תיקון מהביקורת:** "להזריק רק לגרסה החדשה ביותר (semver-max)" שגוי — VS Code לא בהכרח טוען את הגבוהה (יש 8 גרסאות מקבילות; pin/rollback/עדכון-חלקי). **לזהות את הגרסה הפעילה בפועל** דרך `vscode.extensions.getExtension('anthropic.claude-code')?.extensionPath` ולהזריק אליה. אם לא ניתן לזהות חד-משמעית — fallback: להזריק לכל הגרסאות שחסרות marker (כמו RTL), כדי שהכפתור לא "ייעלם".

### 6.3 הזרקה אידמפוטנטית מבוססת-מיקום

> **תיקון קריטי מהביקורת:** בדיקת "ה-marker קיים?" אינה מספיקה. הבדיקה חייבת לאמת **invariant**: קיים *בדיוק זוג markers אחד* תקין (פתיחה+סגירה), בגרסה הנוכחית, ושום שריד Nonstop אחר מחוץ לו.

* אם ה-invariant מתקיים בגרסה הנוכחית → לא לעשות כלום.
* אחרת: לחתוך **את כל** זוגות ה-markers של Nonstop (כולל שרידים/כפילויות מ-restore של RTL), לוודא גיבוי (6.4), ולהוסיף בלוק עדכני יחיד.
* **אסור** לחתוך עד-סוף-הקובץ — תמיד מ-marker-פתיחה עד marker-סגירה בלבד, לכל המופעים.

### 6.4 גיבוי וכתיבה אטומית

* שם גיבוי: `index.js.nonstop-backup`.
* **כתיבה אטומית (חובה):** לכתוב לקובץ זמני ואז `rename`, ומיד אחרי הכתיבה **לקרוא ולאמת** שהבלוק שלנו שלם. אם לא — כותב אחר (RTL) דרס; לנסות שוב עם backoff. לשקול lockfile ליד `index.js`.
* **הסתייגות גיבוי מתועדת:** אם בעת ההזרקה כבר קיימת הזרקת RTL, הגיבוי שלנו יקפיא אותה בתוכו. לכן **הגיבוי שלנו אינו ערובה ל-rollback ל-Claude "טהור"** — הוא משחזר קובץ שעשוי להכיל RTL לגיטימי. אם נדרש rollback טהור (ראו שאלה פתוחה 9), צריך מוסכמת "המזריק-הראשון-תופס-עותק-נקי" משותפת עם RTL.

### 6.5 הזרקה-מחדש אחרי עדכון Claude Code

* עדכון Claude Code יוצר תיקיית גרסה חדשה עם `index.js` נקי. בכל activate + בדיקה תקופתית (`reinjectCheckHours`), לזהות ולהזריק לגרסה הפעילה אם חסרה.
* מכיוון שגם RTL עושה זאת עצמאית, **סדר ההזרקות אינו נשלט** → חיתוך דו-צדדי + כתיבה אטומית הם ההגנה.
* **debounce** על ה-reinject כדי למנוע מלחמת-כתיבה הדדית עם ה-restore של RTL.

### 6.6 הסרה / הסרת התקנה

* פקודה "Remove Nonstop Injection": לחתוך רק את זוגות ה-markers שלנו (לא לשחזר מ-backup עיוור — שלא למחוק RTL שהוזרק אחרינו).
* למחוק `index.js.nonstop-backup`.
* `deactivate`: ללא I/O כבד; שחזור הוא פעולה מפורשת של המשתמש.

***

## 7. דו-קיום עם RTL — הסעיף הקריטי

> **תוקן מהותית מול הקוד האמיתי של RTL (`local.rtl-for-vs-code-agents-10.1.1/src/extension.js`).**

עובדות מאומתות על RTL:

* RTL מזריק ל**שני** קבצים: `webview/index.js` (marker `RTL for VS Code Agents`, גיבוי `index.js.backup`) **וגם** `extension.js` (marker `RTL-Plan-Injection`, גיבוי `extension.js.rtl-backup`). **Nonstop נוגע רק ב-`webview/index.js`** ולא ב-`extension.js` — שם אין בינינו התנגשות.
* `ensureBackup` של RTL כותב `index.js.backup` **רק אם לא קיים** (לא מרענן). מי שמזריק ראשון תופס את העותק הנקי האמיתי.
* `restoreAllBackups` של RTL קורא את הגיבוי שלו, מריץ עליו `stripInjection` שחותך **מה-marker של RTL ועד סוף הקובץ**, כותב, ומוחק את הגיבוי. רץ בשלושה טריגרים שאיננו שולטים בהם: שדרוג גרסה, "Update Now", ו-"Remove All".

### 7.1 השלכות ועקרונות

1. **שם backup נפרד** (`index.js.nonstop-backup`); לעולם לא לגעת ב-`index.js.backup` של RTL.
2. **חיתוך דו-צדדי מבוסס markers — חובה, לא אופטימיזציה.**
3. **לא לדרוס הזרקה קיימת:** אם RTL כבר שם (זיהוי המחרוזת `RTL for VS Code Agents`), פשוט להוסיף את הבלוק שלנו בנוסף.
4. **תיקון סדר:** מכיוון ש-RTL חותך עד-סוף-קובץ ב-restore, בלוק Nonstop שנמצא **אחרי** ה-marker של RTL **יימחק** בשחזור RTL; בלוק **לפני** ה-marker של RTL ישרוד. כלומר דווקא הסדר "אחרי RTL" הוא ה**מסוכן**. אין סדר "בטוח" מובטח → ההגנה האמיתית = idempotency מבוסס-מיקום (6.3) + reinject תקופתי.

### 7.2 נתיב שחיתות אמיתי (לא רק "סיכון שיורי")

אם RTL גיבה *אחרי* שהזרקנו ואז משחזר: הקובץ המשוחזר עלול להכיל בלוק Nonstop "מאובן" ש-RTL לא יסיר (כי הוא חותך ב-marker של RTL, שאחרי שלנו). **idempotency נאיבי ("ה-marker קיים → לדלג") יותיר את השריד.** לכן 6.3 מחייב invariant מבוסס-מיקום שמזהה ומנקה שרידים/כפילויות. בנוסף יש **write race** (שני התוספים כותבים בלי נעילה) → כתיבה אטומית + verify-after-write (6.4).

### 7.3 פער זמן "מת"

בין מחיקה ע"י RTL ל-reinject שלנו, הכפתור עלול להיעלם לפרק זמן עד `reinjectCheckHours` — קריטי בלילה. מיתון: בדיקת reinject תכופה דיה (ברירת מחדל 6ש' עשויה להיות גבוהה מדי לתרחיש לילה — לשקול בדיקה גם ב-`visibilitychange`/focus).

### 7.4 חלופה שנשקלה

נתיב ה-`vscode_custom_css.imports` (כמו ש-RTL עושה ל-Copilot) טוען סקריפט לחלון הראשי במקום לתקן קבצי תוסף — שורד עדכוני Claude ומבטל את כל בעיית ה-shared-file. **נדחה ל-MVP** כי דורש loader צד-שלישי (`be5invis.vscode-custom-css`) + נאג "Unsupported" של VS Code, ואינו מתאים למוצר מרקטפלייס עצמאי. מתועד כחלופה לעתיד.

***

## 8. בטיחות, מעקות בטיחות ובדיקות

### 8.1 מעקות בטיחות — חובה ב-MVP

* **עצירה מיידית אמינה = הכפתור בפאנל (OFF).** (פקודת Host "Stop Now" היא best-effort בלבד — 2.2.)
* **maxRuntimeMs / maxPings:** בהגעה → OFF אוטומטי. זמן sleep מול rate-limit מוקפא מחישוב ה-runtime (4.4).
* **שעות שקט (quietHours).**
* **זיהוי חזרת המשתמש:** אם זוהתה הקלדה/לחיצה בתיבה שאינה שלנו (סינון לפי flag "אני כותב עכשיו", 5.2), או שהתיבה אינה ריקה (טיוטת משתמש) → להשהות פינגים, לא לדרוס. השהיה ניתנת-להגדרה אחרי פעילות משתמש.
* **מניעת לולאה צמודה:** cooldown מינימלי; מול rate limit לעולם לא בלולאה.

### 8.2 שיקולי מדיניות שימוש (ToS)

המשך אוטומטי לא-מפוקח עלול לעמוד בניגוד למדיניות שימוש ו/או לבזבז מכסה. מסומן כ**שאלה פתוחה למשתמש** (9). **למרקטפלייס:** לתעד זאת מפורשות ב-README ובתיאור, ולהגדיר ברירות מחדל שמרניות, כדי שכל משתמש יקבל החלטה מודעת.

### 8.3 בדיקות + מטריקות מדידות

* **Host (Node):** יוניט ל-`injector` (inject/strip/restore, חיתוך דו-צדדי, **invariant מבוסס-מיקום**, ניקוי כפילויות, כתיבה אטומית) ול-`coexistence` על fixtures — כולל fixture עם RTL לפני/אחרי, ו-fixture עם שריד Nonstop "מאובן". ובדיקת תרחיש: RTL `restoreAllBackups` → reinject שלנו מנרמל.
* **ratelimit:** פרסור פלט usage-core; fallback DOM על מחרוזות אמת (שייאספו ב-Phase 3).
* **Webview:** בדיקות שבירות אותות/סלקטורים מול snapshot.
* **מטריקות קבלה (מספריות):** אחוז false-ping (פינג ב-WORKING) < 1% על פני ≥5 ערבי בדיקה; זמן מקסימלי בין מחיקת-RTL ל-reinject < `reinjectCheckHours`; 0 מקרי דריסת-RTL בטסטים; ≥5 ריצות לילה רצופות ששורדות עדכון Claude/RTL עם שחזור נקי.

***

## 9. סיכונים, אי-ודאויות ושאלות פתוחות

### סיכונים טכניים (אחרי מיתון)

1. **שבירות session-state/DOM (בינוני, ירד מ-גבוה):** מבוסס כעת על אותות לוגיים יציבים יותר; עדיין API לא-מתועד שעלול להישבר בעדכון. מיתון: ריכוז ב-`SIGNALS`, DOM fallback, backstops לא-תלויי-DOM.
2. **token של usage-core בריצה לא-מפוקחת (בינוני):** ייתכן שיפוג בלילה. מיתון: DOM fallback ל-rate-limit.
3. **דו-קיום עם RTL (בינוני):** write race + restore חותך-עד-סוף. מיתון: idempotency מבוסס-מיקום, כתיבה אטומית, reinject תכוף.
4. **הזרקת טקסט ל-contenteditable (נמוך):** RTL מוכיח שליטה בפאנל; לאמת ב-Phase 0.
5. **פינג באמצע עבודה (נמוך-בינוני):** מבוסס כעת על `busy`; לא לשימוש לא-מפוקח עד Phase 2b.

### החלטות שהתקבלו (0.2)

* מקור rate-limit: **usage-core מצורף** (ראשי) + DOM fallback — בכפוף לעצמאות מלאה מהתוסף indicator.
* זיהוי מצב: **session-state** + DOM fallback.
* מצב WAITING_QUESTION: **ניתן-להגדרה** (`onQuestion`: stop/answer).
* kill-switch: **webview בלבד** (אין postMessage ב-MVP).

### שאלות פתוחות שנותרו

* **DOM/state reverse-engineering בפועל:** נתיב הגישה ל-`session.busy`/`pendingInput` מתוך ה-webview; זיהוי WAITING_QUESTION; ניסוחי הודעת ה-rate-limit ל-fallback. ייחקרו ב-Phase 0/3 מול הפאנל החי.
* **rollback טהור:** האם נדרש שחזור ל-Claude "נקי לגמרי" (מצריך מוסכמה משותפת עם RTL), או שמספיק שחזור שמשמר RTL?
* **אריזת usage-core:** רישוי/הפצה של ה-binary בתוך VSIX לכל פלטפורמה; גודל החבילה.
* **תאום עם RTL:** האם להציע ל-RTL בעתיד לחתוך דו-צדדית (לבטל 7.2)?

***

## 10. מפת דרכים מדורגת

עיקרון: כל שלב נבדק לבדו; spikes של מחקר מופרדים מ-build.

### Phase 0 — recon spike (אימות ההנחות המסוכנות באמת)

> תוקן מהביקורת: לא לאמת את הקל (כפתור+טקסט — RTL כבר מוכיח), אלא את מה שיכול להפיל את המוצר.

ידנית, ללכוד את הפאנל החי במצבים: working / idle / waiting-question / rate-limited / done. לאמת: (א) גישה ל-session-state (`busy`/`pendingInput`) מתוך ה-webview; (ב) צריכת usage-core מצורף → `resets_at` (כולל תקפות token); (ג) כתיבה+שליחה ל-contenteditable. **קריטריון יציאה:** מאומת איזה אות מבחין working/idle/question, ש-usage-core מחזיר זמן איפוס, ושפינג נשלח בהצלחה. החלטות Phase 2/3 מתקבלות מנתונים.

### Phase 1 — כפתור ON/OFF + פינג בסיסי + הזרקה בטוחה

מחזור הזרקה אידמפוטנטי מבוסס-מיקום + backup נפרד + כתיבה אטומית + דו-קיום בסיסי עם RTL (אי-דריסה); כפתור ON/OFF עם מצב ויזואלי + persistence; מנוע פינג עם backstops + עצירה מיידית (כפתור). **יציאה:** ON מפנג מחזורית, OFF עוצר מיד, מצב שורד reload, backstops עוצרים, RTL ממשיך במקביל, 0 דריסות בטסטים. (לא לשימוש לילי עדיין.)

### Phase 2a — discovery: זיהוי מצב

מיפוי מאושר של working/idle/question/done מ-session-state (+fallback). **יציאה:** go/no-go + אותות מאומתים.

### Phase 2b — build: פינג חכם

פינג רק ב-WAITING_CONTINUE; טיפול WAITING_QUESTION (`onQuestion`); DONE (sentinel + heuristic); זיהוי חזרת-משתמש; שעות שקט. **יציאה:** לא מפנג ב-streaming, נעצר ב-done/תקיעה, לא דורס טיוטה, לא עונה אקראית על שאלות.

### Phase 3a — discovery: rate-limit

אימות usage-core בריצה ארוכה (token) + איסוף ניסוחי DOM אמיתיים ל-fallback. **יציאה:** מקור זמן-איפוס מאומת.

### Phase 3b — build: המתנה-וחידוש (הבידול)

sleep עד `resets_at`, השכמה+חידוש, fallback קבוע. **יציאה:** בפגיעה במגבלה — עוצר, ממתין, מחדש; מאומת בריצת לילה אמיתית.

### Phase 4 — ליטוש, הגדרות, הקשחה ואריזה למרקטפלייס

מסך הגדרות מלא (טבלת 4.4), scoping ריבוי-פאנלים (4.7), הקשחת דו-קיום (7), status bar, README (כולל הבהרת ToS), אריזת usage-core לכל פלטפורמה, VSIX ופרסום. **יציאה:** ≥5 ריצות לילה יציבות ששורדות עדכוני Claude/RTL, שחזור/הסרה נקיים, עומד במטריקות 8.3.

***

## נספח א' — דפוסים מוכחים שאומצו מ-`rtl-for-vs-code-agents`

* מבנה שני-הקשרים (`src/extension.js` + סקריפט webview מצורף).
* איתור התקנות בכמה בסיסים (`listExtensionInstallations`).
* גיבוי לפני הזרקה + הזרקה אידמפוטנטית לפי marker (`ensureBackup`, `isInjected`, `injectScript`).
* הזרקה-מחדש בשדרוג גרסה (`handleVersionUpgrade`, `reinjectAll`).
* העברת seed דרך `window.__RTL_CONFIG__` (עם JSON.stringify — אומת בשורה 149).
* דפוס auto-action: `setInterval` poll שמאתר יעד ב-DOM ופועל (YOLO: `targetButton.click()`).
* בניית כפתור והכנסתו ל-footer מול `[class*="inputFooter_"]`.

**הבדלים מהותיים שאנו מוסיפים:** (1) חיתוך דו-צדדי מבוסס markers + idempotency מבוסס-מיקום + כתיבה אטומית (במקום חיתוך עד-סוף-קובץ של RTL); (2) זיהוי מצב מבוסס session-state במקום heuristics; (3) מקור rate-limit מובנה (usage-core) במקום גירוד מחרוזות.
