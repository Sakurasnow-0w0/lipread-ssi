// 後端（apps-script/Code.gs）自動測試：用假的 Apps Script 環境（快取、鎖、GitHub、雲端硬碟）跑一遍。
// 執行：node tests/backend.test.js
// 涵蓋：猜密碼計數、token 與讀取限流、影片大小與檔頭、樣本驗證、同意檢查、孤兒影片清理、commit 訊息清理。
// 限制：Node 裡請求是一個一個跑，沒辦法模擬「真正同時送出」，加鎖的效果要部署後實測。
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const code = fs.readFileSync(process.argv[2] || path.join(__dirname, "..", "apps-script", "Code.gs"), "utf8");

function makeEnv(props) {
  const cache = new Map();
  const fetchLog = [];
  const trashed = [];
  const files = new Map();
  let ghPutStatus = 201;
  const toSigned = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
  const env = {
    console,
    Logger: { log: (s) => env.__logs.push(String(s)) },
    __logs: [],
    CacheService: { getScriptCache: () => ({ get: (k) => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, String(v)), remove: (k) => cache.delete(k) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props[k] == null ? null : props[k]) }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: "sha256" },
      Charset: { UTF_8: "utf8" },
      computeDigest: (alg, s) => toSigned(crypto.createHash("sha256").update(String(s)).digest()),
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map((b) => b & 0xff)).toString("base64url"),
      base64Encode: (s) => Buffer.from(String(s), "utf8").toString("base64"),
      base64Decode: (s) => toSigned(Buffer.from(String(s), "base64")),
      formatDate: () => "20261119-120000",
      getUuid: () => crypto.randomUUID(),
      newBlob: (data, mime, name) => ({ data, mime, name, getDataAsString: () => Buffer.from(data.map((b) => b & 0xff)).toString("utf8") }),
      sleep: () => {},
    },
    UrlFetchApp: {
      fetch: (url, opts) => {
        fetchLog.push({ url, method: (opts && opts.method) || "get" });
        if (/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(url) && opts.headers.Authorization !== "Bearer GOODTOKEN_xxxxxxxxxxxxxxxx") return resp(401, { message: "Bad credentials" });
        if (/contents\/data\/samples\//.test(url) && opts.method === "put") return resp(ghPutStatus, { content: { sha: "a".repeat(40) } });
        if (/\/user$/.test(url)) return resp(200, { login: "dev" });
        if (/repos\/[^/]+\/[^/]+$/.test(url)) return resp(200, { permissions: { push: true } });
        return resp(200, {});
      },
      fetchAll: (reqs) => reqs.map((r) => { fetchLog.push({ url: r.url, method: "get" }); return resp(200, { content: "" }); }),
    },
    MimeType: { FOLDER: "application/vnd.google-apps.folder" },
    DriveApp: {
      getFolderById: () => rootFolder,
      getFileById: (id) => {
        const f = files.get(id);
        if (!f) throw new Error("no file");
        return f;
      },
    },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (s) => ({ s, setMimeType() { return JSON.parse(s); } }) },
    Date, JSON, Math, String, Number, Array, Object, isFinite, isNaN, Error,
  };
  function resp(code, body) { return { getResponseCode: () => code, getContentText: () => JSON.stringify(body) }; }
  const rootFolder = {
    getId: () => "ROOTFOLDERID",
    getName: () => "專題",
    getFoldersByName: () => ({ hasNext: () => false }),
    createFolder: (name) => ({
      getId: () => "SUB" + name,
      createFile: (blob) => {
        const id = "FILE" + crypto.randomBytes(6).toString("hex");
        const f = {
          getId: () => id, getMimeType: () => "video/mp4", setDescription() {},
          getParents: () => { let done = false; return { hasNext: () => !done, next: () => { done = true; return { getId: () => "SUB" + name, getParents: () => { let d2 = false; return { hasNext: () => !d2, next: () => { d2 = true; return rootFolder; } }; } }; } }; },
          setTrashed: (v) => trashed.push(id),
        };
        files.set(id, f);
        return f;
      },
    }),
  };
  vm.createContext(env);
  vm.runInContext(code, env);
  env.__fetchLog = fetchLog; env.__trashed = trashed; env.__cache = cache;
  env.__setPut = (s) => (ghPutStatus = s);
  return env;
}

const post = (env, body) => env.doPost({ postData: { contents: JSON.stringify(body) } });
let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (extra ? "  → " + JSON.stringify(extra) : "")); } }

const STRONG = "Ab3dEf6hJk9mNp2qRs5tUv8w";
const frames = (n) => Array.from({ length: n }, () => Array.from({ length: 20 }, () => 0.1));
const sample = (extra) => Object.assign({ id: "20261119-120000-abc123", label: "喝水", speaker: "A", frames: frames(30), video: { name: "x.mp4" }, quality: { frames: 30, missed: 0, duration: 1.2 }, consent: { version: "2026-11-19", at: new Date().toISOString() } }, extra || {});
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(100)]).toString("base64");
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(100)]).toString("base64");
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]).toString("base64");

console.log("H1 猜密碼計數");
{
  const env = makeEnv({ TEAM_CODE: "lip2026", ADMIN_CODE: "admin-short", GITHUB_TOKEN: "x" });
  for (let i = 0; i < 15; i++) post(env, { action: "ping", code: "wrong" + i });
  check("短通關碼：錯 15 次後被暫停", /嘗試太多次/.test(post(env, { action: "ping", code: "wrong" }).error));
  check("短通關碼：暫停時連正確的也擋（防止猜中）", /嘗試太多次/.test(post(env, { action: "ping", code: "lip2026" }).error));
  const env2 = makeEnv({ TEAM_CODE: STRONG, ADMIN_CODE: STRONG + "X", GITHUB_TOKEN: "x" });
  for (let i = 0; i < 15; i++) post(env2, { action: "ping", adminCode: "wrong" + i });
  check("猜錯管理員密碼 15 次，團隊通關碼仍可登入", post(env2, { action: "ping", code: STRONG }).ok === true);
  for (let i = 0; i < 40; i++) post(env2, { action: "ping", code: "wrong" + i });
  check("長通關碼：有人狂猜 40 次，正確的人照常可用", post(env2, { action: "ping", code: STRONG }).ok === true);
  check("長通關碼：狂猜的人收到「嘗試太多次」", /嘗試太多次/.test(post(env2, { action: "ping", code: "wrong" }).error));
  check("錯誤計數有累加（≥ 40）", Number(env2.__cache.get([...env2.__cache.keys()].find((k) => k.startsWith("fail_team_")))) >= 40);
}

console.log("H2 token 與讀取限流");
{
  const env = makeEnv({ TEAM_CODE: STRONG, ADMIN_CODE: STRONG + "X", GITHUB_TOKEN: "x" });
  for (let i = 0; i < 10; i++) post(env, { action: "ping", token: "x".repeat(40) });
  check("同一個假 token 連送 10 次，只連 GitHub 1 次", env.__fetchLog.length === 1, env.__fetchLog.length);
  const env2 = makeEnv({ TEAM_CODE: STRONG, ADMIN_CODE: STRONG + "X", GITHUB_TOKEN: "x" });
  for (let i = 0; i < 50; i++) post(env2, { action: "ping", token: "tok" + i + "x".repeat(40) });
  check("50 個不同的假 token，連 GitHub 不超過 15 次", env2.__fetchLog.length <= 15, env2.__fetchLog.length);
  check("真 token 仍能用（token 計數不影響團隊）", post(env2, { action: "ping", code: STRONG }).ok === true);
  const env3 = makeEnv({ TEAM_CODE: STRONG, ADMIN_CODE: STRONG + "X", GITHUB_TOKEN: "x" });
  const shas = Array.from({ length: 25 }, (_, i) => (i.toString(16) + "a".repeat(40)).slice(0, 40));
  let blocked = -1;
  for (let i = 0; i < 30; i++) { const r = post(env3, { action: "blobs", code: STRONG, shas }); if (!r.ok) { blocked = i; break; } }
  check("短時間大量 blobs 會被擋（每分鐘 400 個）", blocked === 16, blocked);
}

console.log("H3 影片上限與檔頭");
{
  const env = makeEnv({ TEAM_CODE: STRONG, ADMIN_CODE: STRONG + "X", GITHUB_TOKEN: "x", ROOT_FOLDER_ID: "ROOTFOLDERID" });
  const big = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(11 * 1024 * 1024)]).toString("base64");
  check("11 MB 影片被拒", /太大/.test(post(env, { action: "upload", code: STRONG, label: "喝水", data: big }).error));
  check("改副檔名的 PNG 被拒", /不是影片/.test(post(env, { action: "upload", code: STRONG, label: "喝水", data: png, ext: "mp4" }).error));
  check("MP4／MOV（ftyp）通過", post(env, { action: "upload", code: STRONG, label: "喝水", data: mp4, ext: "mov" }).ok === true);
  check("WebM（EBML）通過", post(env, { action: "upload", code: STRONG, label: "喝水", data: webm, ext: "webm" }).ok === true);
  env.__cache.set("bytes_20261119-120000", String(500 * 1024 * 1024 - 50));
  check("每日總量用完後被拒", /上限/.test(post(env, { action: "upload", code: STRONG, label: "喝水", data: mp4 }).error));
}

console.log("M5 樣本驗證");
{
  const env = makeEnv({ TEAM_CODE: STRONG, ADMIN_CODE: STRONG + "X", GITHUB_TOKEN: "x" });
  check("2000 格的樣本被拒", /格數/.test(post(env, { action: "saveSample", code: STRONG, sample: sample({ frames: frames(2000) }) }).error));
  const bad = frames(30); bad[3][5] = "x";
  check("frames 裡有字串被拒", /不是數字/.test(post(env, { action: "saveSample", code: STRONG, sample: sample({ frames: bad }) }).error));
  let written = null;
  const orig = env.UrlFetchApp.fetch;
  env.UrlFetchApp.fetch = (url, opts) => { if (opts && opts.method === "put") written = JSON.parse(Buffer.from(JSON.parse(opts.payload).content, "base64").toString("utf8")); return orig(url, opts); };
  const ok = post(env, { action: "saveSample", code: STRONG, name: "老師", sample: sample({ foo: "bar", lips: [[1, 2]], video: { name: "x.mp4", driveId: "FILEabcdef123456", folder: "喝水" } }) });
  check("正常樣本照常寫入", ok.ok === true, ok);
  check("多帶的 foo 欄位被丟掉", written && !("foo" in written));
  check("格式不對的 lips 改成 null", written && written.lips === null);
  check("保留 consent、driveId、quality", written && written.consent && written.video.driveId === "FILEabcdef123456" && written.quality.frames === 30);
  check("M1：團隊名字加上「訪客：」前綴", written && written.createdBy === "訪客：老師");
}

console.log("H5 後端檢查同意");
{
  const env = makeEnv({ TEAM_CODE: STRONG, ADMIN_CODE: STRONG + "X", GITHUB_TOKEN: "x", PRIVACY_VERSION: "2026-11-19" });
  check("沒有同意紀錄被拒", /隱私權政策/.test(post(env, { action: "saveSample", code: STRONG, sample: sample({ consent: null }) }).error));
  check("同意舊版本被拒", /隱私權政策/.test(post(env, { action: "saveSample", code: STRONG, sample: sample({ consent: { version: "2026-01-01", at: new Date().toISOString() } }) }).error));
  check("同意目前版本可寫入", post(env, { action: "saveSample", code: STRONG, sample: sample() }).ok === true);
}

console.log("H4 存樣本失敗時清掉剛上傳的影片");
{
  const env = makeEnv({ TEAM_CODE: STRONG, ADMIN_CODE: STRONG + "X", GITHUB_TOKEN: "x", ROOT_FOLDER_ID: "ROOTFOLDERID", PRIVACY_VERSION: "2026-11-19" });
  const up = post(env, { action: "upload", code: STRONG, label: "喝水", data: mp4 });
  env.__setPut(500);
  const r = post(env, { action: "saveSample", code: STRONG, sample: sample({ video: { name: "x", driveId: up.id } }) });
  check("GitHub 寫入失敗 → 回報錯誤", r.ok === false);
  check("剛上傳的影片被丟進垃圾桶", env.__trashed.includes(up.id));
  const up2 = post(env, { action: "upload", code: STRONG, label: "喝水", data: mp4 });
  post(env, { action: "saveSample", code: STRONG, sample: sample({ consent: null, video: { name: "x", driveId: up2.id } }) });
  check("沒同意被拒時，影片也被清掉", env.__trashed.includes(up2.id));
  env.__setPut(201);
  const up3 = post(env, { action: "upload", code: STRONG, label: "喝水", data: mp4 });
  post(env, { action: "saveSample", code: STRONG, sample: sample({ video: { name: "x", driveId: "OTHERFILE123456" } }) });
  check("不是剛上傳的影片 ID 不會被亂刪", !env.__trashed.includes("OTHERFILE123456"));
  void up3;
}

console.log("M2 commit 訊息清理");
{
  const env = makeEnv({ TEAM_CODE: STRONG, ADMIN_CODE: STRONG + "X", GITHUB_TOKEN: "x" });
  let msg = "";
  const orig = env.UrlFetchApp.fetch;
  env.UrlFetchApp.fetch = (url, opts) => { if (opts && opts.method === "put") msg = JSON.parse(opts.payload).message; return orig(url, opts); };
  post(env, { action: "saveSample", code: STRONG, name: "小明", sample: sample({ label: "喝水（A）・老師" }) });
  check("樣本 commit 訊息拿掉偽造用的分隔符號", !/（A）・老師/.test(msg) && /・訪客：小明$/.test(msg), msg);
}

console.log(`\n結果：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
