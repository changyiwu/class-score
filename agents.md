# 課堂表現登記系統 (class-score)（專案藍圖）

> 本檔為跨 Agent 通用的專案藍圖（AGENTS.md 開放標準）。任何 Agent 的每個 session 都應先讀本檔＋`handoff.md`。

## 專案簡介
提供課堂大螢幕觸控加減分介面，並支援手機安全掃碼登入（防學生偷看密碼）及密碼直接登入。後端採用 Google Apps Script API 搭配 Google 試算表作為資料庫，前端部署於 GitHub Pages。

## 關鍵時程
- 專案開發與部署：已完成並發布上線

## 目標與路線圖
- [x] 後端 Google Apps Script API 設計與 clasp 部署
- [x] 後端 Google 試算表自動化建立與 `_Settings` 設計
- [x] 前端 SPA 介面 (HTML5 / CSS 毛玻璃設計 / JS 邏輯) 編寫
- [x] 本地 Git 庫初始化，GitHub 儲存庫建立與程式碼推播
- [x] GitHub Pages 自動化託管與部署啟用
- [x] 學生卡片外觀精簡化與適配 1080p 大螢幕
- [x] 新增即時前三名排行榜
- [x] 整合大螢幕密碼登入與手機掃碼登入雙渠道

## 資料夾結構
```
class-score/
├── .clasp.json
├── .git/
├── .gitignore
├── agents.md
├── handoff.md
├── ANTIGRAVITY.md
├── README.md
├── app.js
├── index.html
├── style.css
└── gas/
```

## 同步層級（本專案初始化至第 3 層級）

| 層級 | 平台 | 位置 | 讀取時機 |
|------|------|------|---------|
| L1 | 本地（GDrive） | `agents.md`＋`handoff.md` | 每個 session |
| L2 | GitHub | [changyiwu/class-score](https://github.com/changyiwu/class-score) | 指定時 |
| L3 | Obsidian | `class-score/專案工作流程.md` | 有需要時 |

## 工作約定
- 任何 Agent、任何電腦：**開工先讀 `handoff.md`，收工必更新 `handoff.md`**
- 修改共用檔案前先讀最新內容，避免覆蓋其他 Agent 的變更
- 所有回應與文件使用繁體中文
- 修改前先確認計畫，優先保留原有資料結構
