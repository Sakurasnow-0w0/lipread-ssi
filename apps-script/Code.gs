/**
 * 唇語專題：後端服務（Google Apps Script）
 *
 * 功能
 *  1. 影片存進雲端硬碟，依「念的內容」自動建子資料夾
 *  2. 代替使用者把口型數據寫進 GitHub 私有 repo（GitHub token 只存在這裡，網頁看不到）
 *  3. 讓後台報告讀取全部口型數據
 *
 * 誰能用
 *  - 輸入「團隊通關碼」的人：可上傳、讀取
 *  - 輸入「管理員密碼」的人：另外可刪除
 *  - 用自己 GitHub token 連線、且是資料 repo 協作者的人：可上傳、讀取、刪除
 *
 * 設定都放在「專案設定 → 指令碼屬性」，這個檔案不用改，更新時整份貼上即可：
 *  ROOT_FOLDER_ID 雲端硬碟影片資料夾網址最後那串 ID
 *  GITHUB_TOKEN   這支服務寫入資料 repo 用的 Fine-grained token（只勾資料 repo、Contents 讀寫）
 *  TEAM_CODE      團隊通關碼（給同學、志願者）
 *  ADMIN_CODE     管理員密碼（刪除資料用，只有你知道）
 *
 * 設定步驟請看 README 的「後端服務設定」一節。
 */

var CONFIG = {
  ROOT_FOLDER_ID: "",              // 留空即可，會讀指令碼屬性 ROOT_FOLDER_ID
  GITHUB_OWNER: "Sakurasnow-0w0",
  GITHUB_REPO: "lipread-ssi-data",
  GITHUB_BRANCH: "main",
  MAX_VIDEO_BYTES: 30 * 1024 * 1024,
  MAX_SAMPLE_BYTES: 2 * 1024 * 1024,
  RATE_PER_MINUTE: 60,             // 全站每分鐘最多上傳／存檔次數
  MAX_FAILS_PER_MINUTE: 15,        // 密碼錯太多次就暫停一分鐘，防止猜密碼
};

var SAMPLE_PATH_RE = /^data\/samples\/[A-Za-z0-9_-]{1,80}\.json$/;

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) throw new Error("沒有收到資料");
    if (e.postData.contents.length > CONFIG.MAX_VIDEO_BYTES * 1.4 + 20000) throw new Error("資料太大");
    var req = JSON.parse(e.postData.contents);
    var who = authorize_(req);
    switch (req.action) {
      case "ping": return json_({ ok: true, role: who.role, name: who.name, folder: who.role === "member" || who.role === "admin" ? root_().getName() : "" });
      case "upload": rate_("upload"); return json_(upload_(req, who));
      case "saveSample": rate_("save"); return json_(saveSample_(req, who));
      case "list": return json_(list_(req.kind));
      case "blobs": return json_(blobs_(req));
      case "deleteSample": requireDelete_(who); return json_(deleteSample_(req, who));
      case "trash": requireDelete_(who); return json_(trash_(req));
      case "commits": return json_(commits_(req));
      case "journalAdd": rate_("save"); return json_(journalAdd_(req, who));
      case "journalDelete": requireDelete_(who); return json_(journalDelete_(req, who));
      case "schedule": return json_(scheduleGet_());
      case "scheduleOp": rate_("save"); return json_(scheduleOp_(req, who));
      default: throw new Error("不支援的動作");
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function doGet() {
  return json_({ ok: true, service: "lipread-upload", version: 3 });
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || "";
}

function rootId_() {
  return prop_("ROOT_FOLDER_ID") || CONFIG.ROOT_FOLDER_ID;
}
function root_() {
  if (!rootId_()) throw new Error("後端還沒設定 ROOT_FOLDER_ID");
  return DriveApp.getFolderById(rootId_());
}

function clean_(s, max) {
  return String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}
function safeName_(s) {
  return s.replace(/[\\\/:*?"<>|#%]/g, "_").replace(/^\.+/, "_");
}

// ───────── 身分驗證 ─────────
function sameText_(a, b) {
  // 長度不同直接不相等；相同長度逐字比對，避免提早結束洩漏資訊
  if (typeof a !== "string" || typeof b !== "string" || !a || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function failGate_() {
  var cache = CacheService.getScriptCache();
  var key = "fail_" + Math.floor(Date.now() / 60000);
  var n = Number(cache.get(key) || 0);
  if (n >= CONFIG.MAX_FAILS_PER_MINUTE) throw new Error("嘗試太多次，請一分鐘後再試");
  return function () { cache.put(key, String(n + 1), 120); };
}

function authorize_(req) {
  var name = clean_(req.name, 30) || "訪客";
  if (req.adminCode) {
    var bumpA = failGate_();
    if (sameText_(String(req.adminCode), prop_("ADMIN_CODE"))) return { role: "admin", name: name };
    bumpA();
    throw new Error("管理員密碼錯誤");
  }
  if (req.code) {
    var bump = failGate_();
    if (sameText_(String(req.code), prop_("TEAM_CODE"))) return { role: "team", name: name };
    bump();
    throw new Error("通關碼錯誤");
  }
  if (req.token) return { role: "member", name: verifyGitHub_(req.token) };
  throw new Error("請先在網頁右上角輸入通關碼");
}

function requireDelete_(who) {
  if (who.role !== "admin" && who.role !== "member") throw new Error("刪除需要管理員密碼");
}

function rate_(kind) {
  var cache = CacheService.getScriptCache();
  var key = "rate_" + kind + "_" + Math.floor(Date.now() / 60000);
  var n = Number(cache.get(key) || 0);
  if (n >= CONFIG.RATE_PER_MINUTE) throw new Error("現在上傳的人太多，請稍後再試");
  cache.put(key, String(n + 1), 120);
}

/** 用上傳者自己的 GitHub token 確認他能寫入資料 repo；快取 10 分鐘。 */
function verifyGitHub_(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 400) throw new Error("GitHub token 格式不正確");
  var key = "gh_" + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
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

// ───────── GitHub（用服務自己的 token） ─────────
function gh_(method, path, body) {
  var token = prop_("GITHUB_TOKEN");
  if (!token) throw new Error("後端還沒設定 GITHUB_TOKEN");
  var opts = {
    method: method,
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    muteHttpExceptions: true,
  };
  if (body) { opts.contentType = "application/json"; opts.payload = JSON.stringify(body); }
  var res = UrlFetchApp.fetch("https://api.github.com/repos/" + CONFIG.GITHUB_OWNER + "/" + CONFIG.GITHUB_REPO + (path ? "/" + path : ""), opts);
  var code = res.getResponseCode();
  var data = null;
  try { data = JSON.parse(res.getContentText()); } catch (x) { data = null; }
  return { code: code, data: data };
}

function list_(kind) {
  var re = kind === "journal" ? JOURNAL_PATH_RE : SAMPLE_PATH_RE;
  var r = gh_("get", "git/trees/" + encodeURIComponent(CONFIG.GITHUB_BRANCH) + "?recursive=1");
  if (r.code === 409) return { ok: true, entries: [], truncated: false };
  if (r.code !== 200) throw new Error("讀取 GitHub 失敗（" + r.code + "），請確認 GITHUB_TOKEN 權限");
  var entries = [];
  (r.data.tree || []).forEach(function (t) {
    if (t.type === "blob" && re.test(t.path) && (t.size || 0) <= CONFIG.MAX_SAMPLE_BYTES) entries.push({ path: t.path, sha: t.sha, size: t.size });
  });
  return { ok: true, entries: entries, truncated: !!r.data.truncated };
}

// ───────── 活動紀錄（資料 repo 的 commit） ─────────
function commits_(req) {
  var page = Math.max(1, Math.min(20, Number(req.page) || 1));
  var r = gh_("get", "commits?per_page=100&page=" + page + "&sha=" + encodeURIComponent(CONFIG.GITHUB_BRANCH));
  if (r.code === 409) return { ok: true, commits: [] };
  if (r.code !== 200) throw new Error("讀取活動紀錄失敗（" + r.code + "）");
  var out = (r.data || []).map(function (c) {
    return {
      sha: String(c.sha || "").slice(0, 40),
      message: String((c.commit && c.commit.message) || "").split("\n")[0].slice(0, 200),
      date: (c.commit && c.commit.author && c.commit.author.date) || "",
      login: (c.author && c.author.login) || ((c.commit && c.commit.author && c.commit.author.name) || ""),
    };
  });
  return { ok: true, commits: out };
}

// ───────── 共用：寫一個 JSON 檔 ─────────
function putJson_(path, obj, message, sha) {
  var body = { message: message, content: Utilities.base64Encode(JSON.stringify(obj, null, 1), Utilities.Charset.UTF_8), branch: CONFIG.GITHUB_BRANCH };
  if (sha) body.sha = sha;
  var r = gh_("put", "contents/" + path, body);
  if (r.code === 200 || r.code === 201) return r.data.content.sha;
  var err = new Error("寫入 GitHub 失敗（" + r.code + "）");
  err.code = r.code;
  throw err;
}
function getJson_(path) {
  var r = gh_("get", "contents/" + path + "?ref=" + encodeURIComponent(CONFIG.GITHUB_BRANCH));
  if (r.code === 404) return { data: null, sha: "" };
  if (r.code !== 200) throw new Error("讀取 GitHub 失敗（" + r.code + "）");
  var text = Utilities.newBlob(Utilities.base64Decode(String(r.data.content || "").replace(/\s/g, ""))).getDataAsString("UTF-8");
  return { data: JSON.parse(text), sha: r.data.sha };
}

// ───────── 工作日誌（一篇一個檔，多人同時寫不衝突） ─────────
var JOURNAL_PATH_RE = /^data\/journal\/[A-Za-z0-9_-]{1,80}\.json$/;
var JOURNAL_TYPES = ["進度", "會議", "老師意見", "問題", "想法"];

function journalAdd_(req, who) {
  var e = req.entry || {};
  var title = clean_(e.title, 80);
  var body = String(e.body == null ? "" : e.body).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, 5000);
  var type = JOURNAL_TYPES.indexOf(e.type) >= 0 ? e.type : "進度";
  var date = /^\d{4}-\d{2}-\d{2}$/.test(e.date || "") ? e.date : Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd");
  if (!title) throw new Error("請填標題");
  var id = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyyMMdd-HHmmss") + "-" + Utilities.getUuid().slice(0, 6);
  var entry = { id: id, type: type, date: date, title: title, body: body, author: who.name, createdAt: new Date().toISOString() };
  var path = "data/journal/" + id + ".json";
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sha = putJson_(path, entry, "新增日誌：" + title + "・" + who.name);
  } finally { lock.releaseLock(); }
  return { ok: true, entry: entry, path: path, sha: sha };
}

function journalDelete_(req, who) {
  var path = String(req.path || ""), sha = String(req.sha || "");
  if (!JOURNAL_PATH_RE.test(path) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("日誌路徑不正確");
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var r = gh_("delete", "contents/" + path, { message: "刪除日誌（" + who.name + "）", sha: sha, branch: CONFIG.GITHUB_BRANCH });
    if (r.code !== 200) throw new Error("刪除失敗（" + r.code + "）");
  } finally { lock.releaseLock(); }
  return { ok: true };
}

// ───────── 日程（data/schedule.json，以「操作」方式修改，避免互相覆蓋） ─────────
var SCHEDULE_PATH = "data/schedule.json";
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function scheduleGet_() {
  var g = getJson_(SCHEDULE_PATH);
  return { ok: true, schedule: g.data || { final: null, tasks: [] }, sha: g.sha };
}

function scheduleOp_(req, who) {
  var op = req.op || {};
  var adminOnly = op.type === "deleteTask" || op.type === "setFinal";
  if (adminOnly && who.role === "team") throw new Error("這個動作需要管理員密碼");
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    for (var attempt = 0; attempt < 3; attempt++) {
      var g = getJson_(SCHEDULE_PATH);
      var s = g.data || { final: null, tasks: [] };
      if (!Array.isArray(s.tasks)) s.tasks = [];
      var msg = applyScheduleOp_(s, op, who);
      try {
        var sha = putJson_(SCHEDULE_PATH, s, msg + "・" + who.name, g.sha);
        return { ok: true, schedule: s, sha: sha };
      } catch (err) {
        if (err.code === 409 && attempt < 2) { Utilities.sleep(600); continue; }
        throw err;
      }
    }
  } finally { lock.releaseLock(); }
}

function applyScheduleOp_(s, op, who) {
  var now = new Date().toISOString();
  var find = function (id) {
    for (var i = 0; i < s.tasks.length; i++) if (s.tasks[i].id === id) return i;
    throw new Error("找不到這個待辦，可能已被別人刪除，請重新整理");
  };
  switch (op.type) {
    case "addTask": {
      var title = clean_(op.title, 80);
      if (!title) throw new Error("請填待辦內容");
      if (s.tasks.length >= 500) throw new Error("待辦太多了");
      var t = {
        id: Utilities.getUuid().slice(0, 8), title: title,
        due: DATE_RE.test(op.due || "") ? op.due : "", owner: clean_(op.owner, 20),
        note: clean_(op.note, 300), done: false, createdBy: who.name, createdAt: now,
      };
      s.tasks.push(t);
      return "新增待辦：" + title;
    }
    case "toggleTask": {
      var i = find(op.id);
      s.tasks[i].done = !!op.done;
      s.tasks[i].doneAt = op.done ? now : "";
      s.tasks[i].doneBy = op.done ? who.name : "";
      return (op.done ? "完成待辦：" : "取消完成：") + s.tasks[i].title;
    }
    case "editTask": {
      var j = find(op.id);
      if (op.title != null) { var nt = clean_(op.title, 80); if (nt) s.tasks[j].title = nt; }
      if (op.due != null) s.tasks[j].due = DATE_RE.test(op.due) ? op.due : "";
      if (op.owner != null) s.tasks[j].owner = clean_(op.owner, 20);
      if (op.note != null) s.tasks[j].note = clean_(op.note, 300);
      return "修改待辦：" + s.tasks[j].title;
    }
    case "deleteTask": {
      var k = find(op.id);
      var removed = s.tasks.splice(k, 1)[0];
      return "刪除待辦：" + removed.title;
    }
    case "setFinal": {
      if (op.clear) { s.final = null; return "清除專題截止日"; }
      var at = String(op.at || "");
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at)) throw new Error("截止時間格式不正確");
      s.final = { at: at, title: clean_(op.title, 60) || "專題截止", setBy: who.name, setAt: now };
      return "設定專題截止日：" + at.replace("T", " ");
    }
    default: throw new Error("不支援的日程操作");
  }
}

/** 一次取最多 25 個樣本內容（base64），平行抓取。 */
function blobs_(req) {
  var shas = (req.shas || []).filter(function (s) { return /^[0-9a-f]{40}$/.test(s); }).slice(0, 25);
  var token = prop_("GITHUB_TOKEN");
  if (!token) throw new Error("後端還沒設定 GITHUB_TOKEN");
  var base = "https://api.github.com/repos/" + CONFIG.GITHUB_OWNER + "/" + CONFIG.GITHUB_REPO + "/git/blobs/";
  var reqs = shas.map(function (s) {
    return { url: base + s, headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" }, muteHttpExceptions: true };
  });
  var out = {};
  UrlFetchApp.fetchAll(reqs).forEach(function (res, i) {
    if (res.getResponseCode() === 200) out[shas[i]] = JSON.parse(res.getContentText()).content || "";
  });
  return { ok: true, blobs: out };
}

function checkSample_(s) {
  if (!s || typeof s !== "object") throw new Error("樣本格式錯誤");
  if (typeof s.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(s.id)) throw new Error("樣本編號格式錯誤");
  if (!clean_(s.label, 40)) throw new Error("缺少念的內容");
  if (!Array.isArray(s.frames) || s.frames.length < 3 || s.frames.length > 2000) throw new Error("口型數據格式錯誤");
  for (var i = 0; i < s.frames.length; i++) {
    var f = s.frames[i];
    if (!Array.isArray(f) || f.length !== 20) throw new Error("口型數據格式錯誤");
  }
}

function saveSample_(req, who) {
  var s = req.sample;
  checkSample_(s);
  s.label = clean_(s.label, 40);
  s.speaker = clean_(s.speaker, 20);
  s.createdBy = who.role === "member" ? who.name : (who.name === "訪客" ? "訪客" : "訪客：" + who.name);
  s.createdAt = new Date().toISOString();
  var text = JSON.stringify(s);
  if (text.length > CONFIG.MAX_SAMPLE_BYTES) throw new Error("樣本太大");
  var path = "data/samples/" + s.id + ".json";
  var body = {
    message: "新增樣本：" + s.label + "（" + (s.speaker || "未填錄製者") + "）・" + s.createdBy,
    content: Utilities.base64Encode(text, Utilities.Charset.UTF_8),
    branch: CONFIG.GITHUB_BRANCH,
  };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // 同一時間只寫一筆，避免 GitHub 衝突
  try {
    for (var attempt = 0; attempt < 4; attempt++) {
      var r = gh_("put", "contents/" + path, body);
      if (r.code === 201 || r.code === 200) return { ok: true, path: path, sha: r.data.content.sha, createdBy: s.createdBy, createdAt: s.createdAt };
      if (r.code === 409 && attempt < 3) { Utilities.sleep(700 * (attempt + 1)); continue; }
      throw new Error("寫入 GitHub 失敗（" + r.code + "）" + (r.data && r.data.message ? "：" + r.data.message : ""));
    }
  } finally {
    lock.releaseLock();
  }
}

function deleteSample_(req, who) {
  var path = String(req.path || ""), sha = String(req.sha || "");
  if (!SAMPLE_PATH_RE.test(path) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("樣本路徑不正確");
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var r = gh_("delete", "contents/" + path, { message: "刪除樣本（" + who.name + "）", sha: sha, branch: CONFIG.GITHUB_BRANCH });
    if (r.code !== 200) throw new Error("刪除失敗（" + r.code + "）");
  } finally {
    lock.releaseLock();
  }
  var trashed = false;
  if (req.driveId) { try { trash_({ id: req.driveId }); trashed = true; } catch (x) { trashed = false; } }
  return { ok: true, trashed: trashed };
}

// ───────── 雲端硬碟 ─────────
function upload_(req, who) {
  var label = safeName_(clean_(req.label, 40));
  var speaker = safeName_(clean_(req.speaker, 20)) || "未填";
  if (!label) throw new Error("缺少念的內容");
  if (typeof req.data !== "string" || !req.data) throw new Error("缺少影片資料");
  var mime = /^video\/[a-z0-9.+-]{1,40}$/i.test(req.mimeType || "") ? req.mimeType : "video/mp4";
  var ext = /^(mp4|mov|m4v|webm|qt|3gp)$/i.test(req.ext || "") ? String(req.ext).toLowerCase() : "mp4";
  var bytes = Utilities.base64Decode(req.data);
  if (bytes.length > CONFIG.MAX_VIDEO_BYTES) throw new Error("影片太大");

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
  file.setDescription("上傳者：" + who.name + "（" + who.role + "）");
  return { ok: true, id: file.getId(), name: name, folder: label };
}

/** 把影片移到垃圾桶（30 天內可還原）。只處理影片資料夾底下的檔案。 */
function trash_(req) {
  var id = String(req.id || "");
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(id)) throw new Error("檔案編號不正確");
  var file = DriveApp.getFileById(id);
  if (!isInsideRoot_(file)) throw new Error("只能刪除影片資料夾裡的檔案");
  file.setTrashed(true);
  return { ok: true, id: id };
}

function isInsideRoot_(file) {
  var rootId = rootId_();
  var parents = file.getParents();
  while (parents.hasNext()) {
    var p = parents.next();
    if (p.getId() === rootId) return true;
    var gp = p.getParents();
    while (gp.hasNext()) if (gp.next().getId() === rootId) return true;
  }
  return false;
}

/** 在編輯器手動執行，檢查設定是否齊全。 */
function setupCheck() {
  Logger.log("ROOT_FOLDER_ID：" + (prop_("ROOT_FOLDER_ID") ? "已設定" : (CONFIG.ROOT_FOLDER_ID ? "寫在程式裡（建議改放指令碼屬性）" : "❌ 未設定")));
  var f = root_();
  Logger.log("資料夾：" + f.getName() + "（" + f.getUrl() + "）");
  Logger.log("GITHUB_TOKEN：" + (prop_("GITHUB_TOKEN") ? "已設定" : "❌ 未設定"));
  Logger.log("TEAM_CODE：" + (prop_("TEAM_CODE") ? "已設定" : "❌ 未設定"));
  Logger.log("ADMIN_CODE：" + (prop_("ADMIN_CODE") ? "已設定" : "❌ 未設定"));
  if (prop_("TEAM_CODE") && prop_("TEAM_CODE") === prop_("ADMIN_CODE")) Logger.log("⚠️ 通關碼和管理員密碼不要設成一樣");
  if (prop_("GITHUB_TOKEN")) {
    var r = gh_("get", "");
    Logger.log("資料 repo 連線：" + (r.code === 200 ? "成功" : "❌ 失敗（" + r.code + "），請確認 token 有勾 " + CONFIG.GITHUB_REPO));
  }
}
