/**
 * 唇語專題：影片上傳中繼站（Google Apps Script）
 *
 * 前台網頁把影片送到這裡，這支程式用「部署者的 Google 帳號」把影片存進指定的雲端硬碟資料夾，
 * 並依「念的內容」自動建立子資料夾：
 *
 *   唇語影片/
 *     我要喝水/  我要喝水_A_20261119-153012.mp4
 *     會痛/      會痛_B_20261119-153140.mov
 *
 * 安全：每次請求都要帶上傳者自己的 GitHub token，這裡會向 GitHub 確認他對「資料 repo」有寫入權限，
 * 沒有權限就拒絕。所以網址外流也無法亂傳檔案。程式只會動 ROOT_FOLDER_ID 底下的檔案。
 *
 * 設定步驟請看 README 的「Google 雲端上傳」一節。
 */

// ───── 只需要改這裡 ─────
var CONFIG = {
  ROOT_FOLDER_ID: "",            // 雲端硬碟「唇語影片」資料夾網址最後那串 ID
  GITHUB_OWNER: "Sakurasnow-0w0",
  GITHUB_REPO: "lipread-ssi-data", // 能寫入這個 repo 的人才能上傳
  MAX_BYTES: 30 * 1024 * 1024,
};
// ────────────────────────

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) throw new Error("沒有收到資料");
    if (e.postData.contents.length > CONFIG.MAX_BYTES * 1.4 + 10000) throw new Error("檔案太大");
    var req = JSON.parse(e.postData.contents);
    var login = verifyGitHub_(req.token);
    switch (req.action) {
      case "ping": return json_({ ok: true, login: login, folder: root_().getName() });
      case "upload": return json_(upload_(req, login));
      case "trash": return json_(trash_(req, login));
      default: throw new Error("不支援的動作");
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function doGet() {
  return json_({ ok: true, service: "lipread-upload" });
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function root_() {
  if (!CONFIG.ROOT_FOLDER_ID) throw new Error("Apps Script 還沒設定 ROOT_FOLDER_ID");
  return DriveApp.getFolderById(CONFIG.ROOT_FOLDER_ID);
}

/** 向 GitHub 確認 token 擁有者能寫入資料 repo；結果快取 10 分鐘。回傳 GitHub 帳號。 */
function verifyGitHub_(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 400) throw new Error("缺少 GitHub token，請先在網頁右上角連線 GitHub");
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token);
  var key = "gh_" + Utilities.base64EncodeWebSafe(digest);
  var cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  if (hit) return hit;

  var headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  var repoRes = UrlFetchApp.fetch("https://api.github.com/repos/" + CONFIG.GITHUB_OWNER + "/" + CONFIG.GITHUB_REPO, { headers: headers, muteHttpExceptions: true });
  if (repoRes.getResponseCode() !== 200) throw new Error("GitHub 驗證失敗：這個 token 沒有資料 repo 的權限");
  var repo = JSON.parse(repoRes.getContentText());
  if (!repo.permissions || !repo.permissions.push) throw new Error("需要資料 repo 的寫入權限");

  var userRes = UrlFetchApp.fetch("https://api.github.com/user", { headers: headers, muteHttpExceptions: true });
  if (userRes.getResponseCode() !== 200) throw new Error("GitHub 驗證失敗");
  var login = String(JSON.parse(userRes.getContentText()).login || "").slice(0, 60);
  cache.put(key, login, 600);
  return login;
}

function clean_(s, max) {
  return String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}
// 資料夾／檔名不能有的字元
function safeName_(s) {
  return s.replace(/[\\\/:*?"<>|#%]/g, "_").replace(/^\.+/, "_");
}

function upload_(req, login) {
  var label = safeName_(clean_(req.label, 40));
  var speaker = safeName_(clean_(req.speaker, 20)) || "未填";
  if (!label) throw new Error("缺少念的內容");
  if (typeof req.data !== "string" || !req.data) throw new Error("缺少影片資料");
  var mime = /^video\/[a-z0-9.+-]{1,40}$/i.test(req.mimeType || "") ? req.mimeType : "video/mp4";
  var ext = /^(mp4|mov|m4v|webm|qt|3gp)$/i.test(req.ext || "") ? String(req.ext).toLowerCase() : "mp4";
  var bytes = Utilities.base64Decode(req.data);
  if (bytes.length > CONFIG.MAX_BYTES) throw new Error("影片太大");

  var lock = LockService.getScriptLock();
  lock.waitLock(20000); // 避免兩個人同時建立同名資料夾
  var folder;
  try {
    var root = root_();
    var it = root.getFoldersByName(label);
    folder = it.hasNext() ? it.next() : root.createFolder(label);
  } finally {
    lock.releaseLock();
  }

  var stamp = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyyMMdd-HHmmss");
  var name = label + "_" + speaker + "_" + stamp + "." + ext;
  var file = folder.createFile(Utilities.newBlob(bytes, mime, name));
  file.setDescription("上傳者 GitHub：" + login);
  return { ok: true, id: file.getId(), name: name, folder: label, url: file.getUrl() };
}

/** 把影片移到垃圾桶（30 天內可還原）。只允許處理 ROOT_FOLDER_ID 底下的檔案。 */
function trash_(req, login) {
  var id = String(req.id || "");
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(id)) throw new Error("檔案編號不正確");
  var file = DriveApp.getFileById(id);
  if (!isInsideRoot_(file)) throw new Error("只能刪除唇語影片資料夾裡的檔案");
  file.setTrashed(true);
  return { ok: true, id: id, by: login };
}

function isInsideRoot_(file) {
  var rootId = CONFIG.ROOT_FOLDER_ID;
  var parents = file.getParents();
  while (parents.hasNext()) {
    var p = parents.next();
    if (p.getId() === rootId) return true;
    var gp = p.getParents();
    while (gp.hasNext()) if (gp.next().getId() === rootId) return true;
  }
  return false;
}

/** 在編輯器裡手動執行一次，用來授權雲端硬碟與外部連線權限、確認資料夾設定正確。 */
function setupCheck() {
  var f = root_();
  Logger.log("資料夾：" + f.getName() + "（" + f.getUrl() + "）");
  var r = UrlFetchApp.fetch("https://api.github.com/zen", { muteHttpExceptions: true });
  Logger.log("GitHub 連線：" + r.getResponseCode());
}
