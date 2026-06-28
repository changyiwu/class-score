# AntiGravity 專案規則 - 課堂表現登記系統

本檔案定義本專案的開發規則與架構規範。

## 專案概述
- **專案名稱**：課堂表現登記系統 (class-score)
- **用途**：提供課堂大螢幕觸控加減分介面，並以手機進行安全掃碼登入（避免學生看到密碼）。
- **架構**：
  - **前端**：GitHub Pages 託管單頁應用 (HTML5 / Vanilla CSS / Vanilla JS)。
  - **後端**：Google Apps Script Web App (API 伺服器)，使用 `clasp` 開發。
  - **資料庫**：Google 試算表 (每個班級為一個工作表，另有 `_Settings` 存放密碼與設定)。

## 技術規範與規則
1. **安全保護**：
   - 密碼存放於 Google 試算表 `_Settings` 分頁中，後端以 `CacheService` 管理 session，時間上限為 45 分鐘。
   - 前端發送 API 請求時，必須使用 `text/plain` 格式的 POST 請求，以避免引發 CORS preflight OPTIONS 預檢錯誤。
2. **UI/UX 設計**：
   - 保持現代暗色系設計（Glassmorphism，毛玻璃視覺效果）。
   - 學生卡片進行分數調整時，採用樂觀更新（Optimistic Update）並加入放大/縮小與綠色/紅色變色動畫。
3. **版本控制**：
   - 不要將敏感的 OAuth token 或認證金鑰提交至 Git 儲存庫。
   - `gas/.clasp.json` 包含腳本 ID，可提交，但個人認證檔案 `~/.clasprc.json` 必須保持在使用者主目錄中，絕不能進入專案目錄。
