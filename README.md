# 無聲溝通・唇語辨識專題

給失聲者用的無聲溝通系統：對鏡頭無聲說出常用需求，系統辨識嘴型、轉成文字並唸出來。

| 頁面 | 用途 |
|---|---|
| `index.html`（前台輸入） | 上傳口型影片、標註念的內容 → 自動抓嘴唇節點 → 口型數據存進這個 repo；也可以做辨識測試 |
| `report.html`（後台報告） | 讀取全部樣本，算出留一法／跨錄製者準確率、混淆矩陣、資料集覆蓋情況，可一鍵複製成 Markdown 報告 |

## 資料放哪裡

```
影片（含人臉）  →  Google 雲端硬碟共用資料夾（不進 git）
口型數據 JSON   →  這個 repo 的 data/samples/，一段影片一個檔
```

- 每個樣本 JSON 只有每格 20 個數字（嘴部表情係數＋嘴型幾何量），**沒有影像**。
- 一段一個檔，多人同時上傳不會互相衝突；每次上傳就是一個 commit，誰傳了什麼都看得到。
- `.gitignore` 已排除影片檔，避免不小心把人臉影片 commit 進來。

## 第一次使用（每位開發者各做一次）

### 1. 取得 repo 權限
repo 擁有者到 **Settings → Collaborators** 把你加進來，你接受邀請。

### 2. 建立自己的 GitHub token
到 <https://github.com/settings/personal-access-tokens/new> 建立 **Fine-grained token**：

- **Resource owner**：repo 擁有者（目前是 `Sakurasnow-0w0`）
- **Repository access**：Only select repositories → 只勾 `lipread-ssi`
- **Permissions → Contents**：Read and write
- **Expiration**：設到期日（例如專題結束）

> ⚠️ 待確認：如果 Resource owner 選不到別人的帳號（Fine-grained token 對「個人帳號底下、你只是協作者」的 repo 可能有限制），有兩個做法：
> (a) 把 repo 轉移到一個 GitHub Organization（免費），大家把 Resource owner 選成那個組織；
> (b) 改用 Classic token 勾 `repo`。但 classic token 能存取你所有的 repo，權限太大，**不建議**。

**token 絕對不要寫進程式碼、不要 commit、不要貼到群組。** 外洩了就到上面的網址把它刪掉重建。

### 3. 裝 Google 雲端硬碟（電腦版）
裝好後共用資料夾會出現在檔案總管（例如 `G:\共用雲端硬碟\唇語影片`），網頁直接讀這個資料夾，不需要另外設定 Google API。

### 4. 開啟網頁
```bash
git clone https://github.com/Sakurasnow-0w0/lipread-ssi.git
```
用 Chrome 或 Edge 直接雙擊 `index.html`。按右上角「未連線 GitHub」，貼上 token 連線。第一次要連網下載臉部模型（約 18 MB）。

> 私有 repo 要開 GitHub Pages 需要 GitHub Pro（學生可用 [Student Developer Pack](https://education.github.com/pack) 免費取得）。沒有的話就照上面在本機開，功能完全一樣。

## 錄影規格

- 一段只念一句，1–3 秒；正面、距離固定、光線均勻、至少 30 fps；開頭先閉嘴約半秒
- 檔名：`念的內容_錄製者_編號.mp4`，例如 `我要喝水_A_01.mp4`（批次匯入會用檔名自動標註）
- iPhone 預設的 HEVC / MOV 瀏覽器可能讀不了，請改成「最相容」格式或轉成 H.264 MP4
- 建議第一批：2 人 × 6 句 × 每句 10 次，先跑通流程再大量錄

## 方法

1. MediaPipe Face Landmarker 取得每格臉部 478 個節點與表情係數（blendshapes）
2. 每格取 20 維嘴部特徵：16 個嘴部表情係數（左右成對平均）＋ 4 個以兩眼距離正規化的嘴型幾何量
3. 減去開頭靜止嘴型以降低個人差異，裁掉前後沒動作的影格
4. 用 DTW 計算與每段範本的距離，取最接近的（1-NN）
5. 評估：**留一法**（同一批人，對應「先錄自己的範本」）與**跨錄製者**（只用別人的範本，對應「沒錄範本就直接用」）

限制：只能認出資料庫裡已有的內容；範本比對換人後準確率會明顯下降。

## 檔案結構

```
index.html          前台輸入
report.html         後台報告
assets/core.js      共用：特徵擷取、DTW、GitHub 存取
assets/style.css    共用樣式
assets/config.js    預設連線的 repo（不是密碼）
data/samples/       口型數據（由網頁自動寫入）
```
