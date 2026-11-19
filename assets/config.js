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
  privacyVersion: "2026-11-19",
  // 資料保存到「專題總截止日」後幾年（總截止日在「日程」頁設定）
  retentionYears: 1,
  // 隱私權頁面的聯絡信箱（會公開，請用學校信箱；留空則顯示「請聯絡專題負責人」）
  contactEmail: "",
};
