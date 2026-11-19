# 交接審查文件：唇語辨識專題網站

> 給接手審查或維護的人（或另一個 AI 工作階段）。
> 最後更新：2026-11-20，後端 v5.1。對應的 commit 請看 `git log -1 -- docs/HANDOFF.md`（文件改版時一定會留下 commit）。

---

## 0. 請先讀這段

- **不要碰真實資料**：`assets/config.js` 裡的 `uploadUrl` 指向**正式運作中的後端**。測試請照第 7 節的做法，或自己另外部署一份 Apps Script。不要用真的通關碼、管理員密碼、GitHub token，也**不要對正式網址做壓力或配額測試**。
- **不要推到 `main`**：這個 repo 的 `main` 會自動部署成正式網站（GitHub Pages）。修正請開分支或 PR，由專題負責人決定是否合併。
- **回報格式**：每個發現請寫「位置（檔案:行號）→ 為什麼有問題 → 怎麼重現 → 建議修法」，並標嚴重度 🔴致命／🟠高／🟡中。不確定的標「待確認」，說明判斷條件。
- **安全問題不要寫在這個公開 repo**（包括 issue、PR 描述）。已知風險清單和審查報告放在私有的資料 repo `lipread-ssi-data` 的 `docs/SECURITY.md`，需要協作者權限才看得到。新發現的安全問題請直接告訴專題負責人，或寫進那份文件。
- 專題負責人另有一份全域資安規範（硬編碼密鑰、注入、缺認證／限流、供應鏈等，§1–§7），請一併對照。

---

## 1. 這是什麼

給失聲者用的無聲溝通系統（大學專題）：對鏡頭無聲說出常用需求詞，系統辨識嘴型、轉成文字並唸出來。目前用「有限詞彙＋範本比對（DTW 最近鄰）」，不是深度學習。

| 項目 | 位置 |
|---|---|
| 正式網站 | https://sakurasnow-0w0.github.io/lipread-ssi/ |
| 程式 repo（公開） | https://github.com/Sakurasnow-0w0/lipread-ssi |
| 資料 repo（私有） | `Sakurasnow-0w0/lipread-ssi-data`（`data/samples/`、`data/journal/`、`data/schedule.json`、`docs/SECURITY.md`） |
| 影片 | 專題負責人的 Google 雲端硬碟資料夾（ID 在 Apps Script 指令碼屬性，不在程式碼裡） |
| 後端 | Google Apps Script 網頁應用程式（`apps-script/Code.gs`，部署者身分執行、存取權「所有人」） |
| 隱私權請求 | Google 表單（`assets/config.js` 的 `contactFormUrl`，回覆通知寄給專題負責人） |

純 HTML／CSS／JavaScript，沒有框架、沒有建置步驟。後端有自動測試（`tests/backend.test.js`），前端沒有。

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
  │    開了 Turnstile 時：login（Turnstile＋通關碼）→ 發通行證（CacheService，最多 6 小時）→ 之後只帶通行證
  ├─ 限流：猜錯次數、每分鐘存檔／讀取次數、每日讀取次數、每日影片總量
  ├─ 影片 → DriveApp，依「念的內容」建子資料夾（檢查檔頭、單支 10 MB）
  └─ GitHub REST API（用存在指令碼屬性的 GITHUB_TOKEN）→ 私有資料 repo
```

**主要流程**

1. **引導錄影**（`index.html` 的 `tab-guide`）：`getUserMedia` 開前鏡頭 → 每 300ms `LR.checkFrame` 做對位檢查 → 錄影時以 `requestVideoFrameCallback`（沒有就用 `requestAnimationFrame`）逐格 `LR.analyzeFrame` 抓特徵，記下「偵測完成時」距離開始錄影的毫秒數 → `LR.fromLiveSamples` 以每 40ms 一個取樣點，取**時間 ≤ 取樣點的最後一格**（不是最接近的一格；格子不夠新時也不會算漏抓，見 SECURITY.md）→ 「只錄嘴巴」開啟時，MediaRecorder 錄的是 `#gCrop` canvas 的 `captureStream`（跟著嘴巴裁切），否則錄原始鏡頭串流。樣本的 `quality.source` 記為 `"live"`。
2. **上傳影片**（`tab-upload`）：選現成影片 → `LR.extract` 用 `<video>` 逐格 seek 到 `(i+0.5)/25` 秒抓特徵（`quality.source` 記為 `"file"`；引導錄影的影片已帶 `q.pre`，會跳過這步）→ `LR.drive.upload`（base64）→ `LR.gh.putSample`。存樣本失敗時：團隊模式由後端把剛上傳的影片丟進垃圾桶，開發者模式由前端呼叫 `trash`。
3. **後台報告**（`report.html`）：讀全部樣本 → `LR.distanceMatrix` 兩兩 DTW（O(N²)）→ 留一法／跨錄製者評估 → 圖表、嘴型重播、匯出、使用統計。
4. **日程**（`schedule.html`）：以「操作」送後端（`scheduleOp`），後端加鎖讀最新 `schedule.json` 再套用、寫回。
5. **日誌**（`log.html`）：手寫日誌一篇一檔；系統活動是解析資料 repo 的 commit 訊息（後端寫 commit 前會把使用者字串裡的 `・（）()` 拿掉，避免偽造）。

---

## 3. 檔案地圖

| 檔案 | 重點 |
|---|---|
| `assets/core.js` | 共用模組（以一般 `<script>` 載入，全域 `window.LR`）。特徵擷取 `LR.extract` / `LR.analyzeFrame` / `LR.checkFrame` / `LR.fromLiveSamples`、前處理 `preprocess`、DTW `LR.dtw`、評估 `LR.evaluate` / `LR.summarize`、樣本驗證 `LR.validateSample`、GitHub 直連 `LR.gh`、後端呼叫 `LR.drive.call`、團隊模式 `LR.team` / `LR.mode`、`LR.api`（日程、日誌）、嘴型動畫 `LR.LipPlayer`、登入視窗與畫面鎖定 `LR.mountHeader`、知情同意 `LR.policy` / `buildConsentDialog` |
| `assets/config.js` | 公開設定：資料 repo、後端網址、隱私政策版本、保存年限、隱私權請求表單網址 |
| `assets/phrases.js` | 常用句庫（草稿） |
| `assets/style.css` | 全部樣式；未登入時 `body.locked` / `html.prelock` 隱藏內容 |
| `index.html` | 前台：引導錄影、上傳影片、辨識測試 |
| `report.html` | 後台：KPI、混淆矩陣、嘴型重播、資料集、使用統計、樣本清單、匯出、刪除 |
| `schedule.html` / `log.html` / `architecture.html` | 日程、日誌、系統架構說明 |
| `privacy.html` | 隱私權與使用規範（**唯一不用登入就能看**的頁面） |
| `apps-script/Code.gs` | 後端（需整份貼到 Apps Script，設定在指令碼屬性） |
| `tests/backend.test.js` | 後端自動測試：`node tests/backend.test.js` |

---

## 4. 身分與權限

| 身分 | 怎麼取得 | 可以做 | 後端記錄的名字 |
|---|---|---|---|
| 未登入 | — | 只能看 `privacy.html`（前端畫面鎖定，**只是外觀**） | — |
| 團隊 `team` | 輸入 `TEAM_CODE`（開了 Turnstile 時先通過人機驗證，換一張通行證） | 上傳、讀全部樣本／日誌／日程、新增、勾選、**修改任何人的待辦**（標題、截止日、負責人）、寫日誌 | `訪客：<自己填的名字>` |
| 管理員 `admin` | 另輸入 `ADMIN_CODE` | 以上＋刪樣本、刪日誌、刪待辦、設定專題總截止日 | `管理員：<自己填的名字>` |
| 開發者 `member` | 自己的 Fine-grained GitHub token | 等同管理員；前端也可直接打 GitHub API | GitHub 帳號 |

**真正的保護在後端**：靜態頁面和程式碼是公開的，前端鎖定可以被繞過，但沒有通關碼呼叫不了後端。

**存在瀏覽器裡的東西**：團隊通關碼（勾「記住」才放 localStorage，否則 sessionStorage）、管理員密碼（只放 sessionStorage）、通行證 `lr-session`（跟通關碼放同一處；管理員通行證一律只放 sessionStorage；過期前 2 分鐘就當作過期）、**開發者的 GitHub token（勾「記住」時放 localStorage）**、同意紀錄（localStorage，記著是誰同意的；登出、不同意、換名字都要重新同意）。

**指令碼屬性**：`ROOT_FOLDER_ID`、`GITHUB_TOKEN`、`TEAM_CODE`、`ADMIN_CODE`（建議 16 個字元以上的隨機字串，可用編輯器的 `makeCode` 函式產生）、`PRIVACY_VERSION`（有設時，後端拒收沒有同意這個版本的樣本）、`TURNSTILE_SECRET`（有設時開啟人機驗證）、`TURNSTILE_HOSTNAMES`（允許的網域，預設 `sakurasnow-0w0.github.io`）。

**Turnstile 與通行證**：前端 `config.js` 的 `turnstileSiteKey` 有填時，`LR.drive.call` 改走 `callWithSession`：沒有通行證就用記住的通關碼＋新的 Turnstile 驗證碼呼叫 `login`（同時多個請求只登入一次）；後端回 `SESSION_EXPIRED`／`LOGIN_REQUIRED` 時自動重新登入並重試一次。後端設了 `TURNSTILE_SECRET` 後，直接帶通關碼的請求一律回 `LOGIN_REQUIRED`。快取只存通行證的 SHA-256，不存原文。通行證記著發證當下通關碼的指紋（`codeStamp_`，雜湊前 12 bytes），**換掉 `TEAM_CODE`（管理員通行證另含 `ADMIN_CODE`）後舊通行證立刻失效**，回 `SESSION_EXPIRED`。開發者 token 不受影響。

**猜密碼的處理**：依身分（team／admin／token）分開計數。通關碼夠長（≥16 字元）時，輸入正確的人永遠可以進來，猜錯的只會被計數與擋下，別人故意狂打錯的也鎖不住大家；通關碼太短時，錯太多次就整分鐘暫停。token 每次驗證失敗都要連 GitHub，所以失敗結果快取 10 分鐘，並有每日上限。

---

## 5. 資料格式

**樣本** `data/samples/<id>.json`（`id` 格式 `YYYYMMDD-HHMMSS-xxxxxx`）。後端只保留下面這些欄位，其他一律丟掉：

```json
{
  "schema": 1, "id": "...", "label": "喝水", "speaker": "A",
  "video": { "name": "...", "path": "...", "source": "google-drive", "driveId": "...", "folder": "喝水" },
  "fps": 25, "dims": 20,
  "frames": [[20 個數字], ...],          // 3–425 格，每個值是 |v| ≤ 1000 的數字
  "lips": [[80 個數字], ...] | null,     // 嘴唇內外圈各 20 點；格式不對時後端改成 null
  "quality": { "frames": 63, "missed": 0, "duration": 2.52, "source": "live" | "file" | "" },
  "createdAt": "ISO（後端時間）", "createdBy": "訪客：小明（後端決定）",
  "consent": { "version": "2026-11-19", "at": "ISO" } | null
}
```

**日程** `data/schedule.json`：`{ final: { at: "YYYY-MM-DDTHH:MM", title, setBy, setAt } | null, tasks: [{ id, title, due, owner, note, done, doneAt, doneBy, createdBy, createdAt }] }`。`at` 沒有時區，各瀏覽器當成自己的本地時間。

**日誌** `data/journal/<id>.json`：`{ id, type, date, title, body, author, createdAt }`

---

## 6. 後端 API（`doPost`，body 為 JSON 字串）

除了 `login`／`logout`，所有 action 都會先經過 `authorize_`（接受 `session`、`code`、`adminCode` 或 `token`）。錯誤回應可能帶 `code`（`SESSION_EXPIRED`、`LOGIN_REQUIRED`）。限流數字在 `Code.gs` 的 `CONFIG`。

| action | 身分 | 參數 | 限流 | 說明 |
|---|---|---|---|---|
| `login` | 不用（自己檢查通關碼） | code, adminCode?, name, turnstile | 登入桶 60 次／分、2,000 次／天 | 有 `TURNSTILE_SECRET` 時先向 Cloudflare 驗證（含網域）；回傳 session、role、name、expiresIn |
| `logout` | 不用 | session | — | 作廢通行證 |
| `ping` | 任一 | — | — | 回傳 role、name |
| `upload` | 任一 | label, speaker, mimeType, ext, data(base64) | 存檔桶 60 次／分；全站每日 500 MB | 單支 10 MB；檢查檔頭（MP4/MOV 的 box 或 WebM 的 EBML） |
| `saveSample` | 任一 | sample | 存檔桶 | 後端重組欄位、覆寫 createdBy／createdAt；檢查同意；失敗時清掉 1 小時內剛上傳的影片 |
| `list` | 任一 | kind = samples \| journal | 讀取桶 1 次 | Trees API 列清單 |
| `blobs` | 任一 | shas（≤25） | 讀取桶，按個數計 | 一次抓多個檔案內容（base64）；**只檢查 SHA 格式，已刪除的檔案也抓得到** |
| `deleteSample` | admin / member | path, sha, driveId | — | 刪 GitHub 檔案＋影片移到垃圾桶 |
| `trash` | admin / member | id | — | 影片移到垃圾桶（只限影片資料夾內，不能是資料夾） |
| `commits` | 任一 | page | 讀取桶 1 次 | 資料 repo 的 commit 紀錄 |
| `journalAdd` / `journalDelete` | 任一 / admin | entry / path, sha | 存檔桶 / — | 日誌 |
| `schedule` / `scheduleOp` | 任一 | op | 讀取桶 / 存檔桶 | 刪待辦、設定總截止日需 admin |

- **存檔桶**：`upload`、`saveSample`、`journalAdd`、`scheduleOp` 共用每分鐘 60 次，上傳尖峰時日程也可能被擋。
- **讀取桶**：每分鐘 400、每天 12,000（保留 Apps Script 每日對外連線配額給寫入）。一次報告頁載入 300 段樣本約用掉 300。

**手動維護函式**（在 Apps Script 編輯器選函式執行）：`setupCheck`（檢查設定）、`makeCode`（產生隨機通關碼）、`findOrphans`（列出沒有樣本指向的影片）、`trashOrphans`（把超過 1 天的孤兒影片移到垃圾桶）。

---

## 7. 怎麼測

### 後端自動測試

```bash
node tests/backend.test.js
```

用假的 Apps Script 環境跑 66 項檢查（含 Turnstile 登入與通行證）。Node 裡請求是一個一個跑，**沒辦法驗證加鎖在真正同時送出時的效果**，這部分要另外部署測試版實測。

### 前端（本機，不碰正式後端）

```bash
cd lipread-ssi
python -m http.server 8766 --bind 127.0.0.1
```

0. **如果 `config.js` 已填 `turnstileSiteKey`**：本機測試時暫時改成 Cloudflare 的測試金鑰 `1x00000000000000000000AA`（一律通過）或 `3x00000000000000000000FF`（一定要勾選），**不要 commit**。正式金鑰綁定網域，在 127.0.0.1 會失敗。
1. **用無痕視窗**，或先在 DevTools 清掉這個網址的 localStorage／sessionStorage。瀏覽器若記住了通關碼，頁面一載入就會連正式後端，來不及換成假後端。
2. 開 `http://127.0.0.1:8766/`（不要用 `localhost`，Windows 可能先解析成 `::1` 而連不到）。
3. **登入前**，在 DevTools Console 貼上假後端（重新整理後會消失，要再貼一次）：

```js
const realFetch = window.fetch;
const files = new Map();               // path → { sha, text }
const sha = () => [...crypto.getRandomValues(new Uint8Array(20))].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (t) => btoa(unescape(encodeURIComponent(t)));
let schedule = { final: null, tasks: [] };
window.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith("https://script.google.com/")) return realFetch(url, opts);
  const b = JSON.parse(opts.body);
  const json = (o) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });
  if (b.action === "login") {             // 開了 Turnstile 時前端會先呼叫 login
    if (b.code !== "test-code" || (b.adminCode && b.adminCode !== "test-admin")) return json({ ok: false, error: "通關碼錯誤" });
    const r = b.adminCode ? "admin" : "team";
    return json({ ok: true, session: (r === "admin" ? "a" : "b").repeat(64), role: r, name: (r === "admin" ? "管理員：" : "訪客：") + (b.name || ""), expiresIn: 21600 });
  }
  if (b.action === "logout") return json({ ok: true });
  const role = b.session ? ({ ["a".repeat(64)]: "admin", ["b".repeat(64)]: "team" })[b.session] || null
    : b.adminCode === "test-admin" ? "admin" : b.code === "test-code" ? "team" : null;
  if (!role) return json({ ok: false, error: "通關碼錯誤" });
  const who = (role === "admin" ? "管理員：" : "訪客：") + (b.name || "");
  switch (b.action) {
    case "ping": return json({ ok: true, role, name: who });
    case "upload": return json({ ok: true, id: "drvTEST" + Date.now(), name: b.label + "." + b.ext, folder: b.label });
    case "saveSample": { const p = `data/samples/${b.sample.id}.json`; const s = Object.assign(b.sample, { createdBy: who, createdAt: new Date().toISOString() }); files.set(p, { sha: sha(), text: JSON.stringify(s) }); return json({ ok: true, path: p, sha: files.get(p).sha, createdBy: who, createdAt: s.createdAt }); }
    case "list": { const re = b.kind === "journal" ? /^data\/journal\// : /^data\/samples\//; return json({ ok: true, entries: [...files].filter(([p]) => re.test(p)).map(([path, v]) => ({ path, sha: v.sha })) }); }
    case "blobs": { const out = {}; for (const v of files.values()) if (b.shas.includes(v.sha)) out[v.sha] = b64(v.text); return json({ ok: true, blobs: out }); }
    case "deleteSample": case "journalDelete": if (role !== "admin") return json({ ok: false, error: "刪除需要管理員密碼" }); files.delete(b.path); return json({ ok: true, trashed: !!b.driveId });
    case "trash": return role === "admin" ? json({ ok: true }) : json({ ok: false, error: "刪除需要管理員密碼" });
    case "journalAdd": { const id = Date.now() + "-x"; const e = Object.assign({}, b.entry, { id, author: who, createdAt: new Date().toISOString() }); files.set(`data/journal/${id}.json`, { sha: sha(), text: JSON.stringify(e) }); return json({ ok: true, entry: e }); }
    case "commits": return json({ ok: true, commits: [] });
    case "schedule": return json({ ok: true, schedule });
    case "scheduleOp": { const o = b.op; if ((o.type === "deleteTask" || o.type === "setFinal") && role !== "admin") return json({ ok: false, error: "這個動作需要管理員密碼" });
      if (o.type === "addTask") schedule.tasks.push({ id: sha().slice(0, 8), title: o.title, due: o.due || "", owner: o.owner || "", note: o.note || "", done: false, createdBy: who });
      if (o.type === "toggleTask") Object.assign(schedule.tasks.find((t) => t.id === o.id), { done: o.done, doneBy: o.done ? who : "" });
      if (o.type === "editTask") Object.assign(schedule.tasks.find((t) => t.id === o.id), { title: o.title, due: o.due, owner: o.owner, note: o.note });
      if (o.type === "deleteTask") schedule.tasks = schedule.tasks.filter((t) => t.id !== o.id);
      if (o.type === "setFinal") schedule.final = o.clear ? null : { at: o.at, title: o.title || "專題截止" };
      return json({ ok: true, schedule }); }
  }
  return json({ ok: false, error: "假後端沒實作：" + b.action });
};
```

4. 登入時通關碼填 `test-code`，管理員密碼填 `test-admin`。

**沒有相機時**：`navigator.mediaDevices.getUserMedia = async () => someCanvas.captureStream(30)`。開發時用的是 MediaPipe 官方範例人像圖（`https://storage.googleapis.com/mediapipe-assets/portrait.jpg`）畫在 canvas 上，再讓下半臉上下移動模擬嘴動。

**到目前為止的前端測試**：全部是上面這種假後端＋假鏡頭的手動測試；真實環境只確認過後端版本、未登入會被拒、CORS 正常，以及專題負責人用 iPhone 錄過一次。iPhone 實機測試清單：首次開鏡頭的位置、`MediaRecorder.isTypeSupported("video/mp4;codecs=avc1")`、`requestVideoFrameCallback` 是否存在、裁切串流的影格率、影片 `duration === Infinity` 的處理、低電量模式下的效能。

---

## 8. 已知風險

已知風險清單、審查報告與每項的處理狀態，放在私有資料 repo 的 `docs/SECURITY.md`（需要協作者權限）。這個公開 repo 不放可以直接拿來攻擊的細節。

---

## 9. 建議的審查順序

1. `apps-script/Code.gs` 全檔：身分驗證、限流、每個 action 的權限、`buildSample_` 的輸入驗證、`trash_` 範圍、鎖與重試；跑 `node tests/backend.test.js`
2. `assets/core.js`：`LR.drive.call`／`callWithSession`／`ensureSession`／`login`、`LR.session`、`LR.turnstile`、`LR.mode`、`LR.settings`（後端網址只有刻意自訂才存）、`LR.validateSample`、`LR.newSample`、`LR.mountHeader` 鎖定邏輯、`buildSettingsDialog`、`buildConsentDialog`、`LR.policy`
3. 所有把外部資料放進畫面的地方（搜尋 `el(`、`textContent`、`innerHTML`、`setAttribute("href"`）
4. `index.html` 引導錄影：鏡頭生命週期（`startCam` / `stopCam` / `visibilitychange` / `pagehide`）、錄影中切換分頁、連續錄影中按停止、上傳中再錄
5. `report.html` 的刪除流程（單筆、整批）與重新載入
6. 私有 repo `docs/SECURITY.md` 裡「尚未處理」的項目

## 10. 目前狀態

- 後端 v5.1（`doGet` 回傳 `version: 5.1` 與 `turnstile: true/false`）；修正內容見 SECURITY.md
- 資料 repo 已有 `data/schedule.json`（交接文件匯入的 9 項待辦）
- 隱私權請求表單：`assets/config.js` 的 `contactFormUrl`；刻意不放信箱，避免公開 repo 被掃信箱
- 隱私權政策版本 `2026-11-20`（加入 Cloudflare Turnstile 說明）；改內容時請同時改 `config.js` 的 `privacyVersion` 和指令碼屬性 `PRIVACY_VERSION`，所有人會被要求重新同意
