/* 預設連線設定（都不是密碼，可以公開）。每個人仍可在頁面右上角修改。
 * 絕對不要把 GitHub token 寫在這裡。 */
window.LR_CONFIG = {
  owner: "Sakurasnow-0w0",
  repo: "lipread-ssi-data", // 存口型數據的私有 repo
  branch: "main",
  // 影片上傳服務（apps-script/Code.gs 部署後的網址）。公開沒關係：沒有資料 repo 寫入權限的 GitHub token 會被拒絕
  uploadUrl: "https://script.google.com/macros/s/AKfycbx1BaHDXw8TOnZJr1OSrMFkMBcOr6qrCspMv9Qw5GAwHBDJO5npExrMmFMb05OqI7E15g/exec",

  // ───── 隱私權政策 ─────
  // 改了政策內容就把版本日期往後改，大家下次使用時會被要求重新同意
  privacyVersion: "2026-11-20",
  // 資料保存到「專題總截止日」後幾年（總截止日在「日程」頁設定）
  retentionYears: 1,
  // 隱私權請求表單（Google 表單的分享連結，https://forms.gle/… 或 https://docs.google.com/forms/d/e/…/viewform）
  // 不在這裡放信箱：這個檔案是公開的，信箱會被掃去寄垃圾信，而且會永遠留在 git 紀錄裡
  contactFormUrl: "https://forms.gle/eyEPJ6uAq2FcJoge6",

  // ───── 人機驗證（Cloudflare Turnstile）─────
  // 填 Cloudflare 給的「網站金鑰」（site key，0x 開頭，公開沒關係）。留空＝不使用人機驗證。
  // 「秘密金鑰」（secret key）只能放在 Apps Script 的指令碼屬性 TURNSTILE_SECRET，絕對不要寫在這裡
  turnstileSiteKey: "",
};
