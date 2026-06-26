# 班級加減分系統 (Class Score Tracker)

為課堂觸控大螢幕設計的學生加減分網頁系統。

## 系統特點
1. **手機掃碼登入**：大螢幕顯示 QR Code，教師使用手機掃碼並在手機上輸入密碼，大螢幕自動完成登入，避免學生窺視密碼。
2. **無縫資料連線**：使用 Google Apps Script (GAS) 將前端與 Google 試算表（Google Sheets）連通，每個班級在試算表中有獨立分頁。
3. **空缺座號過濾**：建立新班級時，在大螢幕即可點擊設定空缺座號，建立時自動跳過，不佔用卡片空間。
4. **即時評分互動**：採用 Optimistic UI 設計，點擊加減分時大螢幕卡片立即產生流暢變色動畫，資料同步在背景進行。
5. **安全逾時機制**：45 分鐘工作期滿後自動登出，亦可手動點選登出。

## 目錄結構
- `index.html` - 大螢幕及手機登入介面 HTML5 結構。
- `style.css` - UI 毛玻璃風格、深色主題與微互動 CSS 樣式。
- `app.js` - 前端邏輯控制與 API 通訊。
- `gas/` - Google Apps Script 後端代碼 (透過 `clasp` 管理)。
  - `Code.js` - GAS API 分發器與 Session 快取管理。
  - `appsscript.json` - GAS 專案配置清單。

## 使用與部署方式
詳細部署指引、Google Apps Script 授權以及操作手冊請參閱專案內的 [walkthrough.md](./walkthrough.md)。
