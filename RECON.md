# Phase 0 — ממצאי Recon (מול הקוד החי)

תאריך: 2026-06-03 · נבדק מול `anthropic.claude-code-2.1.161-win32-x64` ו-`orbenozio.claude-code-usage-indicator-0.1.6`.

## 1. מודל המצב (session state)

ב-`webview/index.js` (שורות ~1489, ~2044) קיים מודל מצב מבוסס signals:

```js
busy.value        = state !== "idle"        // running/streaming
pendingInput.value = state === "waiting_input" // ממתין לקלט/אישור
// state ∈ { "running", "waiting_input", "idle" }
// waiting_input נקבע כש- permissionRequests.length > 0
```

המצב נשלח בין ה-host ל-webview דרך הודעת `update_session_state` (`{type, sessionId, state, title}`).

> **מסקנה קריטית שמשנה את האיפיון:** ה-signals (`session.busy`, `session.pendingInput`) חיים בתוך closure של המודול הממוזער — **אין להם handle גלובלי** (`globalThis`/`window`). קוד מוזרק שמצורף לסוף הקובץ חולק את ה-global scope אבל **לא** את ה-lexical closure, ולכן **אינו יכול לקרוא ישירות `session.busy.value`**.
>
> לכן זיהוי המצב ב-webview יתבסס על **detector שכבתי** (לפי סדר עדיפות, עם נפילה חיננית):
> 1. **ניטור postMessage** — ליירט `window.addEventListener('message')` ולחפש הודעות `update_session_state` (אם הן מגיעות גם ל-window של ה-webview). *לאימות חי.*
> 2. **שיקוף DOM** — נוכחות כפתור Stop/Interrupt או אינדיקציית streaming = WORKING; נוכחות UI אישור (Yes/No) = WAITING_QUESTION/permission; אחרת idle. *לאימות חי — הסלקטורים טרם נלכדו.*
> 3. **Heuristic** — תיבת קלט ריקה + לא streaming + עבר אינטרוול = מועמד לפינג. (גס; ברירת מחדל אם 1–2 נכשלים.)

## 2. סלקטורים יציבים (אומתו מול תוסף RTL)

* footer: `[class*="inputFooter_"]`
* תיבת קלט: `div[contenteditable="plaintext-only"][role="textbox"]`
* כפתור ראשי ב-footer: `[class*="footerButtonPrimary_"]`
* כללי: לעולם לא class מלא — תמיד `[class*="prefix_"]` (סיומות hash משתנות בין גרסאות).
* הבחנת הקשר: ה-bundle מכיר `IS_SIDEBAR` / `IS_FULL_EDITOR` / `IS_SESSION_LIST_ONLY` (ריבוי instances → צריך כלל בעלות, §4.7 באיפיון).

## 3. usage-core (מקור rate-limit מובנה)

מתוך `out/extension.js` של ה-indicator:

* הרצה: `execFile(corePath, { timeout: 12000 }, cb)` — **ללא ארגומנטים**. ה-binary פותר בעצמו את ה-token מ-credentials של Claude Code.
* פלט: JSON ב-stdout: `{ five_hour: { utilization, resets_at }, seven_day, retry_after, error }`.
* פתרון נתיב: `bin/usage-core-<platform>-<arch>[.exe]` (override דרך config `corePath`).
* ב-mac/linux צריך להחזיר execute-bit אחרי פריקה מ-VSIX (`chmod 0o755`).
* יש cache משותף בין חלונות: `usage-cache.json` ב-globalStorage + fetch-lock 25s.
* ה-binaries בבעלות `orbenozio` (המשתמש) → אריזת עותק ב-Nonstop לגיטימית ואינה יוצרת תלות בתוסף ה-indicator.

> **השלכה לאריזה:** לארוז עותק של `bin/usage-core-*` ב-Nonstop (≈6MB/פלטפורמה). לוקאלית נעתיק כרגע את `win32-x64` בלבד כדי להריץ; שאר הפלטפורמות יתווספו בזמן אריזת VSIX. ה-bin/ ב-gitignore (לא מכניסים בינאריים ל-git).

## 4. מה עדיין דורש אימות חי (לא ניתן סטטית)

1. האם ניטור postMessage ב-window של ה-webview תופס `update_session_state`.
2. הסלקטורים בפועל ל-WORKING (Stop button/streaming) ול-WAITING_QUESTION.
3. איזו שיטת הזרקת-טקסט ל-contenteditable שולחת בפועל (execCommand vs InputEvent + Enter vs כפתור שליחה).
4. ניסוחי הודעת ה-rate-limit ב-DOM (ל-fallback) + תקפות token של usage-core בריצה לילית ארוכה.

→ לכל אלה נבנה **debug/recon mode** בסקריפט המוזרק (לוג מצב + dump DOM) כדי לכוון מול הפאנל החי.
