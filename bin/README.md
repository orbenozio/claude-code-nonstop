# bin/ — usage-core binaries

מודול ה-rate-limit המובנה (`src/ratelimit/structured.js`) מריץ binary בשם
`usage-core-<platform>-<arch>[.exe]` מהתיקייה הזו.

הבינאריים **אינם נשמרים ב-git** (ראו `.gitignore`) — הם נוספים בזמן אריזת ה-VSIX.

קבצים צפויים (אותם בינאריים כמו ב-`claude-code-usage-indicator`, בבעלות המחבר):

```
usage-core-win32-x64.exe
usage-core-win32-arm64.exe
usage-core-darwin-x64
usage-core-darwin-arm64
usage-core-linux-x64
usage-core-linux-arm64
```

לפיתוח מקומי על Windows מספיק להעתיק את `usage-core-win32-x64.exe` לכאן.

> הערה ארכיטקטונית: מודול זה רץ ב-Extension Host (Node). הזרמת התוצאה ללולאת
> ה-webview דורשת ערוץ host↔webview שנדחה אחרי ה-MVP (SPEC §2.2). ב-MVP זיהוי
> ה-rate-limit בפועל נעשה ב-DOM בתוך הסקריפט המוזרק.
