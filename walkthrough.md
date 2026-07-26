# 部署與操作手冊

本文說明如何從零部署「課堂表現登記系統」，以及日常維護與疑難排解。

---

## 一、系統架構

```
教室大螢幕 (瀏覽器)                     教師手機
       │                                    │
       │  index.html / app.js / style.css   │
       │  ← 由 GitHub Pages 提供 →          │
       │                                    │
       └────────── POST (text/plain) ───────┘
                        │
                        ▼
            Google Apps Script Web App
                   (gas/Code.js)
                        │
                        ▼
            Google 試算表「ClassScoreDB」
              ├─ _Settings（密碼、時長）
              ├─ 3年2班
              └─ 英語A班 ...
```

前端是純靜態檔案，沒有建置流程；後端是單一 GAS Web App，資料存在 Google 試算表，每個班級一個分頁。

---

## 二、前置需求

| 項目 | 說明 |
|------|------|
| Google 帳號 | 用來執行 GAS 並存放試算表 |
| Node.js | 執行 `clasp` 用 |
| clasp | `npm install -g @google/clasp` |
| GitHub 帳號 | 託管前端（GitHub Pages） |

---

## 三、後端部署（Google Apps Script）

### 1. 登入 clasp

```bash
clasp login
```

> 認證檔會寫入 `~/.clasprc.json`。**絕對不要**把它複製到專案目錄，否則會被 git 追蹤而外洩。

### 2. 推送程式碼

專案根目錄已有 `.clasp.json`（`rootDir` 指向 `gas/`）。若要沿用現有的 Apps Script 專案：

```bash
clasp push
```

若要建立全新的 Apps Script 專案：

```bash
clasp create --title "Class Score Backend" --type webapp --rootDir gas
clasp push
```

建立後請把新產生的 `scriptId` 更新到專案根目錄的 `.clasp.json`。

### 3. 部署為網路應用程式

```bash
clasp deploy --description "初次部署"
```

或在 Apps Script 編輯器（`clasp open`）中操作：**部署 → 新增部署作業 → 類型選「網頁應用程式」**，設定為：

- **執行身分**：我（指令碼擁有者）
- **具有存取權的使用者**：所有人

這兩項對應 `gas/appsscript.json` 中的 `executeAs: USER_DEPLOYING` 與 `access: ANYONE_ANONYMOUS`，兩者都是必要的——前端是匿名瀏覽器，但後端需要以你的身分存取試算表。

### 4. 首次授權

第一次部署時 Google 會要求授權下列權限：

- 試算表（讀寫評分資料）
- 雲端硬碟（尋找或建立 `ClassScoreDB`）

畫面出現「Google 尚未驗證這個應用程式」時，點「進階 → 前往（不安全）」即可——這是自己寫的私人指令碼，屬正常現象。

### 5. 取得 Web App 網址

部署完成後複製網址（形如 `https://script.google.com/macros/s/AKfyc.../exec`），填入 [app.js](app.js) 第 6 行：

```js
const GAS_API_URL = "https://script.google.com/macros/s/你的部署ID/exec";
```

---

## 四、初始化資料庫

用瀏覽器打開一次 Web App 網址，看到「Class Score Backend API is active」即代表後端運作正常。

首次有 API 請求進來時，後端會自動在你的雲端硬碟建立名為 **ClassScoreDB** 的試算表，並產生 `_Settings` 分頁：

| Key | Value | 說明 |
|-----|-------|------|
| `Password` | `1234` | 登入密碼 |
| `SessionDurationMinutes` | `45` | 工作階段時長（分鐘） |

### ⚠️ 請立刻修改密碼

預設密碼 `1234` 只是佔位值。到 `ClassScoreDB` 的 `_Settings` 分頁把 `Password` 改成 **6 位以上的英數混合**字串。

系統雖已內建防暴力破解（單一登入通道錯 5 次即作廢；全域 10 分鐘內失敗超過 15 次會啟動節流），但 API 端點對整個網際網路公開，密碼強度仍是最後一道防線。

改完立即生效，不需重新部署。

---

## 五、前端部署（GitHub Pages）

```bash
git push origin main
```

在 GitHub 儲存庫的 **Settings → Pages**，Source 選 `main` 分支的根目錄，儲存後即可取得網址（形如 `https://<帳號>.github.io/class-score/`）。

在教室大螢幕的瀏覽器打開該網址並加入書籤，建議用全螢幕模式（F11）。

---

## 六、日常操作

### 登入

大螢幕提供兩種登入方式：

1. **手機掃碼授權（建議）**：大螢幕顯示 QR Code，用手機掃描後在**手機上**輸入密碼。密碼不會出現在大螢幕上，學生無從窺看。授權成功後大螢幕自動解鎖。
2. **大螢幕直接輸入**：適合沒有學生在場的時候。

登入後右上角會顯示剩餘時間，時間到自動登出，也可手動點「登出」。

### 建立班級

點分頁列的「＋ 新班級」：

- **班級名稱**：15 字以內，不可以 `_` 或 `'` 開頭，不可含 `: \ / ? * [ ]`（Google 試算表分頁名稱限制）
- **預估學生人數**：5～50，指的是**最大座號**
- **空缺座號**：點選要跳過的座號，建立時不會產生這些卡片

建立後會在 `ClassScoreDB` 新增一個同名分頁。

### 加減分

點學生卡片上的 `＋` / `－`。畫面立即變色更新（樂觀更新），資料在背景寫入試算表；若寫入失敗會自動復原並跳出提示。班級標題旁會即時顯示前三名。

### 匯入真實姓名

到 `ClassScoreDB` 對應的班級分頁，直接編輯 **B 欄（姓名）**。

- 保持 A 欄（座號）與 C 欄（分數）不動
- 姓名維持預設的「學生N」時，卡片只顯示座號；改成真實姓名後才會顯示

改完在大螢幕切換一次班級分頁即可看到。

---

## 七、更新程式碼

> ⚠️ **前端與後端的登入協定是綁在一起的。只更新單邊會導致完全無法登入。**

```bash
clasp push          # 後端
git push origin main   # 前端（GitHub Pages 自動發布）
```

`clasp push` 只是上傳原始碼，**必須再建立新版本才會生效**：

```bash
clasp deploy --deploymentId <既有的部署ID> --description "更新說明"
```

或在編輯器中「部署 → 管理部署作業 → 編輯（鉛筆圖示）→ 版本選『新版本』→ 部署」。

**請務必沿用同一個部署 ID**，網址才不會改變；若建立了全新部署，記得同步更新 `app.js` 的 `GAS_API_URL`。

前端更新後，大螢幕請強制重新整理（`Ctrl + Shift + R`）以避免載入舊快取。

---

## 八、疑難排解

| 症狀 | 可能原因與處理 |
|------|---------------|
| 大螢幕顯示「無法連線至伺服器，5 秒後重試」 | `GAS_API_URL` 填錯，或部署未設為「所有人」皆可存取。畫面會自動重試，修正後即恢復 |
| 掃碼後手機顯示「登入通道已失效」 | QR Code 超過 10 分鐘未使用，或密碼已連錯 5 次。重新整理大螢幕取得新的 QR Code |
| 手機輸入密碼成功，但大螢幕沒反應 | 大螢幕最多 3 秒輪詢一次，稍候即可。若仍無反應請重新整理大螢幕再掃一次 |
| 加減分後跳出「寫入失敗，數值已復原」 | 網路不穩或 GAS 額度用盡。分數已自動復原，稍後重試 |
| 建立班級時顯示「班級已存在」但分頁列看不到 | 該分頁名稱以 `_` 開頭而被視為系統分頁。到試算表直接改名或刪除 |
| 只有文字沒有圖示 | FontAwesome CDN 被教室網路阻擋，不影響功能 |
| 想重設整學期分數 | 到 `ClassScoreDB` 對應分頁，把 C 欄整欄改回 0 |
| 想刪除班級 | 到 `ClassScoreDB` 刪除該分頁 |

### 查看後端錯誤紀錄

Apps Script 編輯器左側的「執行項目」可看到每次 API 呼叫的結果與 `Logger.log` 輸出。

---

## 九、安全性說明

- **session token 一律由後端產生**，前端無法自行偽造。
- **QR Code 只包含公開的 `pairId`**；領取 token 所需的 `pollKey` 只存在大螢幕的記憶體中，不會進入 QR Code。因此學生即使抄下 QR Code 內容也拿不到憑證。
- **手機授權後不持有任何憑證**：手機只負責送出密碼，token 由後端直接交付給大螢幕，且只交付一次。
- **密碼永遠不會出現在大螢幕上**（掃碼登入時）。
- 密碼以明文存放於 `_Settings` 分頁，僅你的 Google 帳號可存取。**請勿將此試算表分享給他人**。
