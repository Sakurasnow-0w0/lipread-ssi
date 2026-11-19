# 無聲溝通・唇語辨識專題

給失聲者用的無聲溝通系統：對鏡頭無聲說出常用需求，系統辨識嘴型、轉成文字並唸出來。

**網址（電腦、手機都能開）：<https://sakurasnow-0w0.github.io/lipread-ssi/>**

| 頁面 | 用途 |
|---|---|
| 前台輸入 `index.html` | 一次上傳多段影片（手機可直接錄），勾選後批次標註「念的內容」→ 自動抓嘴唇節點 → 口型數據存 GitHub、影片存 Google 雲端並自動分資料夾；也能做辨識測試 |
| 後台報告 `report.html` | 準確率、混淆矩陣、嘴型重播比較、資料集覆蓋；可匯出 CSV／Markdown／PDF／原始 JSON |

## 資料放哪裡

| 內容 | 位置 | 誰看得到 |
|---|---|---|
| 網頁程式 | 這個公開 repo `lipread-ssi` | 所有人（裡面沒有密碼、沒有個資） |
| 口型數據（每段一個 JSON） | 私有 repo `lipread-ssi-data` 的 `data/samples/` | 只有協作者 |
| 影片（含人臉） | Google 雲端硬碟「唇語影片」資料夾，依內容自動分子資料夾 | 只有被分享的人 |

```
唇語影片/
  我要喝水/  我要喝水_A_20261119-153012.mov
  會痛/      會痛_B_20261119-153140.mp4
```

## 每位開發者第一次使用

### 1. 取得資料 repo 權限
擁有者到 `lipread-ssi-data` 的 **Settings → Collaborators** 把你加進來，你到信箱接受邀請。

### 2. 建立自己的 GitHub token
token 就像「只給這個網頁用的備用鑰匙」。網頁靠它代替你把口型數據寫進 GitHub。

到 <https://github.com/settings/personal-access-tokens/new> 建立 **Fine-grained token**，各欄位的意思：

| 欄位 | 要選 | 意思 |
|---|---|---|
| Token name | 例如 `唇語網頁` | 只是名字，方便你之後認得 |
| Expiration | 設到專題結束 | 時間到 token 自動失效，忘記刪也不會一直有效 |
| Resource owner | `Sakurasnow-0w0` | 這把鑰匙要開「誰的」repo |
| Repository access | **Only select repositories** → 只勾 `lipread-ssi-data` | 只能碰這一個 repo，你其他的 repo 都碰不到 |
| Permissions → Repository permissions → **Contents** | **Read and write** | 可以讀、新增、刪除 repo 裡的檔案（網頁存樣本要用） |
| 其他權限 | 全部不動 | Metadata 會自動變成 Read-only，這是必要的，其他都不需要 |

按 Generate token，複製 `github_pat_` 開頭那串（只會顯示一次），貼到網頁右上角「未連線 GitHub」。

> ⚠️ 待確認：如果 Resource owner 選不到 `Sakurasnow-0w0`（Fine-grained token 對「別人個人帳號底下、你只是協作者」的 repo 可能有限制），請擁有者把 `lipread-ssi-data` 轉移到一個免費的 GitHub Organization，大家的 Resource owner 改選那個組織。不建議改用 Classic token：它會拿到你所有 repo 的權限。

**token 絕對不要寫進程式碼、不要 commit、不要貼到群組。** 外洩或手機遺失時，到上面網址把它刪掉重建即可。

### 3. 打開網頁
電腦或手機打開 <https://sakurasnow-0w0.github.io/lipread-ssi/>，連線 GitHub。第一次要下載臉部模型（約 18 MB）。

## Google 雲端上傳（擁有者設定一次）

影片透過一支 Google Apps Script 存進你的雲端硬碟。它會先用上傳者的 GitHub token 確認「他是資料 repo 的協作者」才收檔案，所以不用另外設密碼，網址外流也不能亂傳。

1. 在 Google 雲端硬碟建一個資料夾，例如「唇語影片」。打開它，網址最後那串就是資料夾 ID：`https://drive.google.com/drive/folders/這一串`
2. 資料夾按「共用」，把隊友的 Google 帳號加成「檢視者」或「編輯者」（**不要**設成「知道連結的任何人」，影片有人臉）
3. 到 <https://script.google.com> → 新專案，把 [`apps-script/Code.gs`](apps-script/Code.gs) 整個貼上，把 `ROOT_FOLDER_ID` 改成上一步的 ID，存檔
4. 上方函式選 `setupCheck` → 執行 → 依指示授權（會出現「Google 尚未驗證這個應用程式」，因為是你自己寫的，按「進階 → 前往」）
5. 右上「部署 → 新增部署作業」→ 類型選 **網頁應用程式**：
   - 執行身分：**我**
   - 誰可以存取：**所有人**（實際權限由 GitHub token 把關）
6. 複製「網頁應用程式網址」（`https://script.google.com/macros/s/…/exec`），貼到網頁右上角連線設定的「影片上傳網址」；或改 `assets/config.js` 的 `uploadUrl` 讓大家預設就有
7. 之後修改 Code.gs，要用「管理部署作業 → 編輯 → 新版本」，網址才不會變

上傳後每段樣本會記下雲端檔案編號，後台報告可直接播放（觀看者要有那個資料夾的權限）。後台刪除樣本時，雲端影片會移到垃圾桶，30 天內可還原。

## 手機與 iPhone

- 手機開網頁會多一個「錄一段」按鈕，直接開前鏡頭錄影；也可以從相簿一次選多段
- iPhone 的 MOV／HEVC：**在 iPhone 上直接處理沒問題**（Safari 本來就能解 HEVC）。如果要在 Windows 電腦處理 iPhone 傳來的檔案，可能會解不開，這時請在手機上處理，或把 iPhone「設定 → 相機 → 格式」改成「最相容」（改錄 H.264）
- 單段影片上限 30 MB（1–3 秒的影片通常只有幾 MB）

## 錄影規格

- 一段只念一句，1–3 秒；正面、距離固定、光線均勻；開頭先閉嘴約半秒
- 用電腦資料夾批次匯入時，檔名用 `念的內容_錄製者_編號.mp4`（例如 `我要喝水_A_01.mp4`），會自動標註
- 建議第一批：2 人 × 6 句 × 每句 10 次，先跑通流程再大量錄

## 方法

1. MediaPipe Face Landmarker 逐格取得臉部 478 個節點與表情係數（每格獨立偵測，同一支影片結果可重現）
2. 每格取 20 維嘴部特徵：16 個嘴部表情係數（左右成對平均）＋ 4 個以兩眼距離正規化的嘴型幾何量；另存嘴唇內外輪廓 40 點座標供重播
3. 減去開頭靜止嘴型以降低個人差異，裁掉前後沒動作的影格
4. 用 DTW 計算與每段範本的距離，取最接近的（1-NN）
5. 評估：**留一法**（同一批人，對應「先錄自己的範本」）與**跨錄製者**（只用別人的範本，對應「沒錄範本就直接用」）

限制：只能認出資料庫裡已有的內容；範本比對換人後準確率會明顯下降。

## 之後改用 GitHub Pro（選用）

目前「程式公開、資料私有」已經夠用。若想把程式也設成私有，需要 GitHub Pro 才能開 Pages：學生可申請免費的 [GitHub Student Developer Pack](https://education.github.com/pack)（用學校信箱、上傳學生證，審核約幾天）。通過後到 repo Settings 改成 Private，Pages 會繼續運作。

## 檔案結構

```
index.html            前台輸入
report.html           後台報告
assets/core.js        共用：特徵擷取、DTW、GitHub 存取、雲端上傳、嘴型重播
assets/style.css      共用樣式
assets/config.js      預設連線設定（不是密碼）
apps-script/Code.gs   Google 雲端上傳中繼站
```
