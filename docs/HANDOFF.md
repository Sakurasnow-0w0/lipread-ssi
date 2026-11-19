# 交接審查文件：唇語辨識專題網站

> 給接手審查的人（或另一個 AI 工作階段）。目的是**找出 bug、安全與隱私問題**，不是重寫。
> 最後更新：2026-11-19。對應 commit：本檔案加入時的 `main`。

---

## 0. 請先讀這段

- **不要碰真實資料**：`assets/config.js` 裡的 `uploadUrl` 指向**正式運作中的後端**。測試請用第 7 節的假後端，或自己另外部署一份 Apps Script。不要用真的通關碼、管理員密碼、GitHub token。
- **不要推到 `main`**：這個 repo 的 `main` 會自動部署成正式網站（GitHub Pages）。修正請開分支或 PR，由專題負責人決定是否合併。
- **回報格式**：每個發現請寫「位置（檔案:行號）→ 為什麼有問題 → 怎麼重現 → 建議修法」，並標嚴重度 🔴致命／🟠高／🟡中。不確定的標「待確認」，說明判斷條件。
- 專題負責人另有一份全域資安規範（硬編碼密鑰、注入、缺認證／限流、供應鏈等，§1–§7），請一併對照。

---

## 1. 這是什麼

給失聲者用的無聲溝通系統（大學專題）：對鏡頭無聲說出常用需求詞，系統辨識嘴型、轉成文字並唸出來。目前用「有限詞彙＋範本比對（DTW 最近鄰）」，不是深度學習。

| 項目 | 位置 |
|---|---|
| 正式網站 | https://sakurasnow-0w0.github.io/lipread-ssi/ |
| 程式 repo（公開） | https://github.com/Sakurasnow-0w0/lipread-ssi |
| 資料 repo（私有） | `Sakurasnow-0w0/lipread-ssi-data`（`data/samples/`、`data/journal/`、`data/schedule.json`） |
| 影片 | 專題負責人的 Google 雲端硬碟資料夾（ID 在 Apps Script 指令碼屬性，不在程式碼裡） |
| 後端 | Google Apps Script 網頁應用程式（`apps-script/Code.gs`，部署者身分執行、存取權「所有人」） |

純 HTML／CSS／JavaScript，沒有框架、沒有建置步驟、沒有自動化測試。

---

## 2. 架構與資料流程

```
瀏覽器（GitHub Pages 靜態頁）
  ├─ MediaPipe Face Landmarker（CDN，tasks-vision 0.10.14）在瀏覽器內抓臉部節點
  ├─ 特徵：每格 20 維（16 個嘴部 blendshape 左右平均 + 4 個嘴型幾何量）＋嘴唇 40 點座標
  └─ fetch POST（text/plain，避免 CORS 預檢）
        ↓
Google Apps Script（Code.gs）
  ├─ 驗證：通關碼 / 管理員密碼 / 使用者自己的 GitHub token
  ├─ 影片 → DriveApp，依「念的內容」建子資料夾
  └─ GitHub REST API（用存在指令碼屬性的 GITHUB_TOKEN）→ 私有資料 repo
```

**主要流程**

1. **引導錄影**（`index.html` 的 `tab-guide`）：`getUserMedia` 開前鏡頭 → 每 300ms `LR.checkFrame` 做對位檢查 → 錄影時以 `requestVideoFrameCallback` 逐格 `LR.analyzeFrame` 抓特徵 → `LR.fromLiveSamples` 重新取樣成 25fps → 「只錄嘴巴」開啟時，MediaRecorder 錄的是 `#gCrop` canvas 的 `captureStream`（跟著嘴巴裁切），否則錄原始鏡頭串流。
2. **上傳影片**（`tab-upload`）：選現成影片 → `LR.extract` 用 `<video>` 逐格 seek 抓特徵（引導錄影的影片已帶 `q.pre`，會跳過這步）→ `LR.drive.upload`（base64）→ `LR.gh.putSample`。
3. **後台報告**（`report.html`）：讀全部樣本 → `LR.distanceMatrix` 兩兩 DTW（O(N²)）→ 留一法／跨錄製者評估 → 圖表、嘴型重播、匯出、使用統計。
4. **日程**（`schedule.html`）：以「操作」送後端（`scheduleOp`），後端加鎖讀最新 `schedule.json` 再套用、寫回。
5. **日誌**（`log.html`）：手寫日誌一篇一檔；系統活動是解析資料 repo 的 commit 訊息。

---

## 3. 檔案地圖

| 檔案 | 重點 |
|---|---|
| `assets/core.js` | 共用模組（以一般 `<script>` 載入，全域 `window.LR`）。特徵擷取 `LR.extract` / `LR.analyzeFrame` / `LR.checkFrame`、前處理 `preprocess`、DTW `LR.dtw`、評估 `LR.evaluate` / `LR.summarize`、樣本驗證 `LR.validateSample`、GitHub 直連 `LR.gh`、後端呼叫 `LR.drive.call`、團隊模式 `LR.team` / `LR.mode`、`LR.api`（日程、日誌）、嘴型動畫 `LR.LipPlayer`、登入視窗與畫面鎖定 `LR.mountHeader`、知情同意 `LR.policy` / `buildConsentDialog` |
| `assets/config.js` | 公開設定：資料 repo、後端網址、隱私政策版本、保存年限、聯絡信箱 |
| `assets/phrases.js` | 常用句庫（草稿） |
| `assets/style.css` | 全部樣式；未登入時 `body.locked` / `html.prelock` 隱藏內容 |
| `index.html` | 前台：引導錄影、上傳影片、辨識測試 |
| `report.html` | 後台：KPI、混淆矩陣、嘴型重播、資料集、使用統計、樣本清單、匯出、刪除 |
| `schedule.html` / `log.html` / `architecture.html` | 日程、日誌、系統架構說明 |
| `privacy.html` | 隱私權與使用規範（**唯一不用登入就能看**的頁面） |
| `apps-script/Code.gs` | 後端（需整份貼到 Apps Script，設定在指令碼屬性） |

---

## 4. 身分與權限

| 身分 | 怎麼取得 | 可以做 | 檢查在哪 |
|---|---|---|---|
| 未登入 | — | 只能看 `privacy.html` | 前端畫面鎖定（**只是外觀**） |
| 團隊 `team` | 輸入 `TEAM_CODE` | 上傳、讀全部樣本／日誌／日程、新增與勾選待辦、寫日誌 | 後端 `authorize_` |
| 管理員 `admin` | 另輸入 `ADMIN_CODE` | 以上＋刪樣本、刪日誌、刪待辦、設定專題總截止日 | 後端 `requireDelete_`、`scheduleOp_` |
| 開發者 `member` | 自己的 Fine-grained GitHub token | 等同管理員；前端也可直接打 GitHub API | 後端 `verifyGitHub_`（確認 push 權限）；GitHub 本身 |

**真正的保護在後端**：靜態頁面和程式碼是公開的，前端鎖定可以被繞過，但沒有通關碼呼叫不了後端。

密碼與 token 都在 Apps Script「指令碼屬性」：`ROOT_FOLDER_ID`、`GITHUB_TOKEN`、`TEAM_CODE`、`ADMIN_CODE`。

---

## 5. 資料格式

**樣本** `data/samples/<id>.json`（`id` 格式 `YYYYMMDD-HHMMSS-xxxxxx`）：

```json
{
  "schema": 1, "id": "...", "label": "喝水", "speaker": "A",
  "video": { "name": "...", "path": "...", "source": "google-drive", "driveId": "...", "folder": "喝水" },
  "fps": 25, "dims": 20,
  "frames": [[20 個數字], ...],          // 前處理後（扣靜止嘴型、裁掉沒動的格）
  "lips": [[80 個數字], ...] | null,     // 嘴唇內外圈各 20 點，以兩眼距離為單位
  "quality": { "frames": 63, "missed": 0, "duration": 2.52 },
  "createdAt": "ISO", "createdBy": "訪客：小明",
  "consent": { "version": "2026-11-19", "at": "ISO" } | null
}
```

**日程** `data/schedule.json`：`{ final: { at: "YYYY-MM-DDTHH:MM", title } | null, tasks: [{ id, title, due, owner, note, done, doneAt, doneBy, createdBy, createdAt }] }`

**日誌** `data/journal/<id>.json`：`{ id, type, date, title, body, author, createdAt }`

---

## 6. 後端 API（`doPost`，body 為 JSON 字串）

| action | 身分 | 參數 | 說明 |
|---|---|---|---|
| `ping` | 任一 | — | 回傳 role |
| `upload` | 任一 | label, speaker, mimeType, ext, data(base64) | 存影片；每分鐘全站上限 60 |
| `saveSample` | 任一 | sample | 寫入 GitHub；後端會覆寫 createdBy / createdAt |
| `list` | 任一 | kind = samples \| journal | Trees API 列清單 |
| `blobs` | 任一 | shas（≤25） | 一次抓多個檔案內容（base64） |
| `deleteSample` | admin / member | path, sha, driveId | 刪 GitHub 檔案＋影片移到垃圾桶 |
| `trash` | admin / member | id | 影片移到垃圾桶（只限影片資料夾內） |
| `commits` | 任一 | page | 資料 repo 的 commit 紀錄 |
| `journalAdd` / `journalDelete` | 任一 / admin | entry / path, sha | 日誌 |
| `schedule` / `scheduleOp` | 任一 | op | 刪待辦、設定總截止日需 admin |

---

## 7. 怎麼在本機測（不碰正式後端）

```bash
cd lipread-ssi
python -m http.server 8766 --bind 127.0.0.1
```

開 `http://localhost:8766/`，**先在 DevTools Console 貼上假後端，再登入**（不然頁面會拿你輸入的東西去打正式後端）：

```js
const realFetch = window.fetch;
window.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith("https://script.google.com/")) return realFetch(url, opts);
  const b = JSON.parse(opts.body);
  const json = (o) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });
  const role = b.adminCode === "test-admin" ? "admin" : b.code === "test-code" ? "team" : null;
  if (!role) return json({ ok: false, error: "通關碼錯誤" });
  if (b.action === "ping") return json({ ok: true, role, name: b.name });
  if (b.action === "list") return json({ ok: true, entries: [] });
  if (b.action === "schedule") return json({ ok: true, schedule: { final: null, tasks: [] } });
  if (b.action === "upload") return json({ ok: true, id: "drvTEST" + Date.now(), name: "x", folder: b.label });
  if (b.action === "saveSample") return json({ ok: true, path: `data/samples/${b.sample.id}.json`, sha: "a".repeat(40) });
  return json({ ok: false, error: "假後端沒實作：" + b.action });
};
```

沒有相機時，可以用 canvas 假裝鏡頭：`navigator.mediaDevices.getUserMedia = async () => someCanvas.captureStream(30)`。開發過程都是用 MediaPipe 官方範例人像圖（`https://storage.googleapis.com/mediapipe-assets/portrait.jpg`）畫在 canvas 上，再讓下半臉上下移動來模擬嘴動。

**到目前為止的測試方式**：全部是上面這種假後端＋假鏡頭的手動測試；真實環境只確認過後端版本、未登入會被拒、CORS 正常，以及專題負責人用 iPhone 錄過一次。**沒有自動化測試。**

---

## 8. 已知風險與可疑點（請優先查）

### 安全

1. 🟠 **猜密碼鎖定是全站共用的**（`Code.gs` `failGate_`）：任何人每分鐘送 15 次錯的密碼，就能讓**所有人**這一分鐘都無法登入或使用（等於阻斷服務）。Apps Script 拿不到使用者 IP，要改善可能需要別的設計。
2. 🟠 **上傳次數上限也是全站共用**（`rate_`）：拿到通關碼的人可以佔滿每分鐘 60 次；計數用 CacheService 讀寫不是原子操作，上限只是大概。
3. 🟠 **通關碼是共用秘密**：無法針對單一個人撤銷，外洩只能整個換掉。持有者可以讀全部樣本（含別人的嘴唇座標）與日誌。
4. 🟡 **`createdBy` 可冒用**：團隊模式的名字是使用者自己填的，後端只加上「訪客：」前綴。
5. 🟡 **管理員密碼存在 sessionStorage、通關碼可選存在 localStorage**：前端全程用 `textContent`，沒有 `innerHTML`，請確認沒有任何 XSS 入口（特別是 `LR.el`、日誌內容、句庫、commit 訊息解析 `log.html` `parseCommit`）。
6. 🟡 **同意只在前端檢查**：後端 `saveSample_` 不檢查 `sample.consent`，直接打 API 可以繞過同意流程。
7. 🟡 **Apps Script 存取權「所有人」**：任何人都能呼叫，靠的是 `authorize_`。請檢查每個 action 都有走到 `authorize_`，以及 `checkSample_` 的輸入驗證是否足夠（例如 `lips` 沒有在後端驗證長度與型別）。
8. 🟡 `deleteSample_` 傳入的 `driveId` 會被 `trash_` 處理，`isInsideRoot_` 只往上查兩層，請確認沒辦法刪到影片資料夾以外的檔案。

### 隱私

9. 🟠 **刪除不徹底**：從 GitHub 刪掉的樣本仍在 git 歷史裡（隱私政策已據實寫明，承諾保存期限到時刪除整個 repo）。若要真的即時刪除，需要改寫歷史或換儲存方式。
10. 🟡 **到期刪除是人工**：沒有排程自動刪除，靠專題負責人記得做。
11. 🟡 「只錄嘴巴」的裁切框是嘴寬的 1.8 倍，可能還會拍到鼻翼與下巴；「上傳影片」分頁上傳的現成影片是完整畫面。

### 正確性

12. 🟠 **兩種特徵擷取路徑的取樣方式不同**：`LR.extract`（檔案，逐格 seek 到 `(i+0.5)/25` 秒）與 `LR.fromLiveSamples`（即時，用實際影格時間取最接近的一格）。資料庫混用兩種來源時，DTW 距離可能有系統性偏差，請評估。
13. 🟡 特徵標準化係數 `LR.weights` 用全部樣本計算，評估時包含測試樣本（輕微資訊洩漏，已在報告註明）。
14. 🟡 `preprocess` 用前 5 格當靜止嘴型；如果錄影一開始就在動，基準會錯。
15. 🟡 `LR.distanceMatrix` 是 O(N²)，樣本超過幾百段時報告頁會很慢（主執行緒，有 `await sleep(0)` 讓畫面不卡死）。
16. 🟡 `schedule.html` 的 `datetime-local` 沒有時區，`new Date("YYYY-MM-DDTHH:MM")` 當成本地時間；不同時區的人看到的倒數不一樣。
17. 🟡 `log.html` 解析 commit 訊息靠正規表達式，待辦標題裡有「・」時會切錯。

### 平台相容性（iOS 特別重要）

18. 🟠 **iPhone 只實測過一次**：專題負責人回報第一次開鏡頭時畫面偏左，重新整理後正常；已改成影片絕對定位填滿框，**修正後尚未在 iPhone 上確認**。
19. 🟡 iOS Safari：`MediaRecorder` 產生 mp4、`requestVideoFrameCallback`、`canvas.captureStream` 的相容性與效能（臉部偵測每格約 20–40ms）都還沒在舊款 iPhone 上驗證。
20. 🟡 MediaRecorder 產生的 webm／mp4 可能沒有長度資訊（`duration === Infinity`），`LR.extract` 用「跳到極遠處」的方式處理，請確認 Safari 也正常。
21. 🟡 Windows 上的 Chrome 可能解不開 iPhone 的 HEVC，已有提示文字，但沒有自動轉檔。

### 可用性

22. 🟡 Chrome 會在沒有使用者互動時強制讓 Esc 關閉 `<dialog>`，已改成關閉後立即重開；請確認不會造成無限迴圈或焦點問題。
23. 🟡 後台在讀取時再按「讀取本機資料夾」只會跳提示，不會排隊。

---

## 9. 建議的審查順序

1. `apps-script/Code.gs` 全檔：身分驗證、每個 action 的權限、輸入驗證、`trash_` 範圍、鎖與重試
2. `assets/core.js`：`LR.drive.call`、`LR.mode`、`LR.validateSample`、`LR.newSample`、`LR.mountHeader` 鎖定邏輯、`buildSettingsDialog`、`buildConsentDialog`
3. 所有把外部資料放進畫面的地方（搜尋 `el(`、`textContent`、`innerHTML`、`setAttribute("href"`）
4. `index.html` 引導錄影：鏡頭生命週期（`startCam` / `stopCam` / `visibilitychange`）、錄影中切換分頁、連續錄影中按停止、上傳中再錄
5. `report.html` 的刪除流程（單筆、整批）與重新載入
6. 第 8 節列出的每一項：確認是否真的是問題、影響多大、怎麼修

## 10. 交接時的狀態

- 後端已部署 v3（`doGet` 回傳 `version: 3`）
- 資料 repo 已有 `data/schedule.json`（交接文件匯入的 9 項待辦）
- `assets/config.js` 的 `contactEmail` 還沒填
- 隱私權政策版本 `2026-11-19`；改內容時請一併改 `privacyVersion`，所有人會被要求重新同意
