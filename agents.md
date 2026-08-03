# 課堂表現登記系統 (class-score)（專案藍圖）

> 本檔為跨 Agent 通用的專案藍圖（AGENTS.md 開放標準）。任何 Agent 的每個 session 都應先讀本檔＋`handoff.md`。

## 專案簡介
提供課堂大螢幕觸控加減分介面，並支援手機安全掃碼登入（防學生偷看密碼）及密碼直接登入。後端採用 Google Apps Script API 搭配 Google 試算表作為資料庫，前端部署於 GitHub Pages。

## 關鍵時程
- 專案開發與部署：已完成並發布上線
- 2026-07-26：安全性與健壯性大修（GAS `@5`）→ 新增操作紀錄（`@6`）→ 功能面縮減，只保留操作紀錄（**目前部署版本 `@7`**）→ 加分鼓勵動畫＋加分音效（純前端，GAS 維持 `@7`）

## 目標與路線圖
- [x] 後端 Google Apps Script API 設計與 clasp 部署
- [x] 後端 Google 試算表自動化建立與 `_Settings` 設計
- [x] 前端 SPA 介面 (HTML5 / CSS 毛玻璃設計 / JS 邏輯) 編寫
- [x] 本地 Git 庫初始化，GitHub 儲存庫建立與程式碼推播
- [x] GitHub Pages 自動化託管與部署啟用
- [x] 學生卡片外觀精簡化與適配 1080p 大螢幕
- [x] 新增即時前三名排行榜
- [x] 整合大螢幕密碼登入與手機掃碼登入雙渠道
- [x] 登入協定改為配對通道（pairing），session token 由後端產生
- [x] 登入防暴力破解（單通道 5 次上限＋全域節流）
- [x] 分數寫入加 `LockService`，修正連點漏算分數
- [x] 班級名稱驗證、加減分範圍限制、HTML 注入防護
- [x] 補上 `walkthrough.md` 部署與操作手冊
- [x] QR Code 函式庫本地化、FontAwesome 加 SRI
- [x] 操作紀錄 `_Log` 分頁與查詢介面
- [x] 將 `_Settings` 的 `Password` 從預設 `1234` 改掉（2026-07-26 完成）
- [x] `get_logs` 真人實測通過（2026-07-26，使用者登入後確認）
- [x] 加分鼓勵動畫（星星迸發／震波環／卡片彈跳／飄升鼓勵詞）
- [x] 加分音效（Web Audio API 即時合成的上行琶音，無音檔）
- [ ] 加分鼓勵動畫**真人視覺確認**（節奏感與吵雜度只能親眼看，Agent 環境測不到）
- [ ] 加分音效**真人試聽**（音色與音量好不好聽只能親耳判斷）
- [ ] 功能面待辦：PWA manifest、分數匯出 CSV

> 註：曾實作過「編輯學生姓名」「重設分數／刪除班級」「編輯座號」，經評估後**刻意全部移除**，介面只保留操作紀錄。這些維護動作一律回到 Google 試算表手動處理。若日後要重做，可翻 commit `337d759`、`659c00b` 取回實作。

## 資料夾結構
```
class-score/
├── .clasp.json
├── .git/
├── .gitignore
├── agents.md
├── handoff.md
├── README.md
├── walkthrough.md
├── app.js
├── index.html
├── style.css
├── vendor/
└── gas/
```

## 同步層級（本專案初始化至第 3 層級）

| 層級 | 平台 | 位置 | 讀取時機 |
|------|------|------|---------|
| L1 | 本地（GDrive） | `agents.md`＋`handoff.md` | 每個 session |
| L2 | GitHub | [changyiwu/class-score](https://github.com/changyiwu/class-score) | 指定時 |
| L3 | Obsidian | `class-score/專案工作流程.md` | 有需要時 |

## 三個檔案的職責（依「時效性」分家，不是依「詳細程度」）

| 檔案 | 時效 | 寫入方式 | 放什麼 |
|------|------|---------|--------|
| `handoff.md` | **只對下一個 session 有效**，過期即丟 | 每次收工整份重寫 | 做到哪、下一步、**這次**的暫時 workaround |
| `agents.md`（本檔） | **長期有效**，每個 session 都適用 | 只有規則本身變了才改 | 目標、路線圖、常設規則、結構 |
| Obsidian／`git log` | **歷史**：發生過什麼、為什麼 | 只增不刪 | 決策紀錄、踩坑完整版、逐次進度 |

驗收標準：**`handoff.md` 整份刪掉，不應損失任何長期資訊**——會的話代表該升級進本檔卻沒升級。

**本檔不要出現的東西**：❌ `## 最近進度`／逐次工作紀錄、❌ 決策理由與踩坑完整版。歷史寫 L3 筆記的〈🗓️ 最近更動紀錄〉〈🧠 決策紀錄〉〈🕳️ 踩坑筆記〉；踩過的坑只把**結論**收斂成一條祈使句寫進〈工作約定〉，原因留 L3。

## 工作約定
- 任何 Agent、任何電腦：**開工先讀 `handoff.md`，收工必更新 `handoff.md`**
- 修改共用檔案前先讀最新內容，避免覆蓋其他 Agent 的變更
- 所有回應與文件使用繁體中文
- 修改前先確認計畫，優先保留原有資料結構

## 技術規範

### 安全保護
- 密碼存放於 Google 試算表 `_Settings` 分頁；後端以 `CacheService` 管理 session，時長由 `_Settings` 的 `SessionDurationMinutes` 決定（預設 45 分鐘，前端由登入回應取得，勿再硬編碼）
- **登入採配對通道（pairing）機制**：大螢幕先向後端申請 `pairId`（放進 QR Code，視為公開）與 `pollKey`（僅留在大螢幕）。手機掃碼後只送出密碼，**手機端不會取得任何 session token**；token 由後端產生後存入配對通道，僅交付給握有 `pollKey` 的大螢幕，且只交付一次
- **session token 一律由後端產生**（`Utilities.getUuid()`），前端不得自行產生
- **登入具備防暴力破解**：單一配對通道密碼錯誤 5 次即作廢；全域 10 分鐘內失敗超過 15 次啟動 2 秒節流
- 後端不提供任意查詢 session 是否有效的端點，避免被用於探測
- 前端發送 API 請求時，**必須使用 `text/plain` 格式的 POST**，以避免引發 CORS preflight OPTIONS 預檢錯誤

### 資料結構
- 班級分頁欄位固定為 `座號 / 姓名 / 分數`（A/B/C 欄），新增欄位前須確認 `handleGetClassData` 與 `handleUpdateScore` 的欄位索引
- 以 `_` 開頭的分頁為系統保留：`_Settings`（密碼與時長）、`_Log`（操作紀錄），皆不會出現在班級清單
- `_Log` 欄位：`時間 / 班級 / 座號 / 姓名 / 動作 / 變動 / 變動後分數 / 操作裝置`；動作目前只有「加減分」與「建立班級」
- 紀錄的裁切邏輯寫在 `appendLog` 內（超過 5000 筆即刪最舊的 500 筆）。**新增其他寫紀錄的路徑時不必另外處理裁切，但若改為批次寫入就要自行補上**
- 「操作裝置」只存 session token 前 8 碼，用於區分登入裝置。系統為單一共用密碼，**無法識別個別教師身分**
- 班級的建立、改名、刪除、分數重設、學生姓名編輯一律在 Google 試算表手動操作，介面不提供（刻意保持精簡）

### 資料寫入
- 所有「先讀後寫」的試算表操作（`handleUpdateScore`、`handleCreateClass`）**必須以 `LockService` 加鎖**，否則大螢幕連續點擊時併發請求會互相覆蓋而漏算分數
- `update_score` 的單次變動量限制在 ±10 分以內
- 班級名稱不可以 `_` 或 `'` 開頭，且不可含 `: \ / ? * [ ]`（試算表分頁名稱限制）；前後端皆須驗證

### UI/UX 設計
- 保持現代暗色系設計（Glassmorphism 毛玻璃視覺效果）
- 學生卡片調整分數時採**樂觀更新**（Optimistic Update），加入放大／縮小與綠／紅變色動畫
- **加減分的回饋刻意不對稱**：加分播完整鼓勵動畫（`playPraiseAnimation`：12 顆星迸發＋雙層震波環＋卡片彈跳＋飄升鼓勵詞，分數用 `score-pulse-up`），扣分只留原本低調的 `score-pulse`，不慶祝
- 鼓勵動畫的圖層 `z-index` 必須高於 `.updating` 的載入遮罩（2）與轉圈（3），否則送出請求那 1 秒動畫會被遮住
- `.student-card` 為了讓特效衝出卡片外而使用 `overflow: visible`，因此**載入遮罩 `.updating::after` 必須自帶 `border-radius: inherit`** 才不會露出直角
- 每次加分建立獨立的 `.praise-layer` 並於 1.4 秒後自行移除，連點時互不打斷；`.card-praise` 於 `animationend` 移除，避免 `z-index: 10` 永久殘留（監聽器須過濾 `animationName`，子元素動畫會冒泡）
- 動畫一律尊重 `prefers-reduced-motion: reduce`

### 音效
- 加分音效以 **Web Audio API 即時合成**（`playPraiseSound`），**不放音檔、不引外部資源**——延續「關鍵資源不依賴外部請求」的約定，也避免在 repo 塞二進位檔
- 音符定義在 `PRAISE_CHIME_NOTES`（頻率／延遲／衰減／相對音量各自獨立），總長約 1.5 秒，與鼓勵動畫等長；扣分不出聲
- **包封必須是兩段式**（快速落到延音位準 → 長尾音）。單段指數衰減會在前 0.3 秒掉到幾乎聽不見，把衰減時長調大也不會讓聲音變長
- 音效長度改動後**必須重測連點疊音的峰值振幅**，確認不削波；`PRAISE_SOUND_MIN_GAP_MS` 要隨音效變長而拉寬
- `AudioContext` 延遲建立、只在點擊（使用者手勢）中 `resume()`；沒有 Web Audio 的瀏覽器靜靜不播，不影響加分本身
- 介面刻意不放靜音開關，要關就改 `PRAISE_SOUND_ENABLED`

### 前端相依
- QR Code 函式庫位於登入關鍵路徑，**必須本地載入**（`vendor/qrcode.min.js`），不可改回 CDN；教室網路阻擋 CDN 時仍須能掃碼登入
- FontAwesome 維持 CDN 但**必須帶 `integrity` 與 `crossorigin`**；升級版本時要同步更新 SRI hash（可由 `https://api.cdnjs.com/libraries/font-awesome/<版本>?fields=sri` 取得）
- Google Fonts 的 CSS 會依瀏覽器動態產生，無法使用 SRI

### 版本控制
- 不要將敏感的 OAuth token 或認證金鑰提交至 Git
- `gas/.clasp.json` 含腳本 ID，可提交；但個人認證檔 `~/.clasprc.json` 必須留在使用者主目錄，**絕不能進入專案目錄**
