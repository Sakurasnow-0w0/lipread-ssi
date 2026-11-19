// 後端（apps-script/Code.gs）自動測試：用假的 Apps Script 環境（快取、鎖、GitHub、雲端硬碟）跑一遍。
// 執行：node tests/backend.test.js
// 涵蓋：猜密碼計數、token 與讀取限流、影片大小與檔頭、樣本驗證、同意檢查、孤兒影片清理、commit 訊息清理、Turnstile 登入與通行證。
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
    __tsHost: "sakurasnow-0w0.github.io",
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
        if (/challenges\.cloudflare\.com\/turnstile\/v0\/siteverify$/.test(url)) {
          const ok = opts.payload.secret === props.TURNSTILE_SECRET && opts.payload.response === "PASS";
          return resp(200, ok ? { success: true, hostname: env.__tsHost } : { success: false, "error-codes": ["invalid-input-response"] });
        }
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

console.log("T Turnstile 登入與通行證");
{
  // 沒設 TURNSTILE_SECRET：舊的登入方式照常可用，也可以拿通行證
  const env0 = makeEnv({ TEAM_CODE: "lip2026", ADMIN_CODE: STRONG + "X", GITHUB_TOKEN: "x" });
  check("沒開 Turnstile：直接帶通關碼照常可用", post(env0, { action: "ping", code: "lip2026" }).ok === true);
  const l0 = post(env0, { action: "login", code: "lip2026", name: "小明" });
  check("沒開 Turnstile：login 也能拿到通行證", l0.ok === true && /^[0-9a-f]{64}$/.test(l0.session), l0);
  check("doGet 回報 version 5.1、turnstile=false", env0.doGet().version === 5.1 && env0.doGet().turnstile === false);

  const env = makeEnv({ TEAM_CODE: "lip2026", ADMIN_CODE: STRONG + "X", GITHUB_TOKEN: "x", TURNSTILE_SECRET: "SECRET", ROOT_FOLDER_ID: "ROOTFOLDERID" });
  check("doGet 回報 turnstile=true", env.doGet().turnstile === true);
  const direct = post(env, { action: "ping", code: "lip2026" });
  check("開了 Turnstile：直接帶通關碼 → LOGIN_REQUIRED", direct.ok === false && direct.code === "LOGIN_REQUIRED", direct);
  check("開了 Turnstile：直接帶管理員密碼也擋", post(env, { action: "ping", adminCode: STRONG + "X" }).code === "LOGIN_REQUIRED");
  check("沒做人機驗證就登入被拒", /人機驗證/.test(post(env, { action: "login", code: "lip2026" }).error));
  check("人機驗證沒通過被拒", /沒有通過/.test(post(env, { action: "login", code: "lip2026", turnstile: "FAIL" }).error));
  check("通過驗證但通關碼錯被拒", /通關碼錯誤/.test(post(env, { action: "login", code: "nope", turnstile: "PASS" }).error));
  env.__tsHost = "evil.example.com";
  check("驗證來自別的網域被拒", /來源不正確/.test(post(env, { action: "login", code: "lip2026", turnstile: "PASS" }).error));
  env.__tsHost = "sakurasnow-0w0.github.io";
  const login = post(env, { action: "login", code: "lip2026", name: "小明", turnstile: "PASS" });
  check("通過驗證＋通關碼正確 → 拿到通行證", login.ok === true && /^[0-9a-f]{64}$/.test(login.session) && login.role === "team" && login.expiresIn === 21600, login);
  check("快取只存通行證的雜湊，不存原文", ![...env.__cache.keys()].some((k) => k.includes(login.session)));
  check("用通行證可以操作", post(env, { action: "ping", session: login.session }).ok === true);
  let written = null;
  const orig = env.UrlFetchApp.fetch;
  env.UrlFetchApp.fetch = (url, opts) => { if (opts && opts.method === "put") written = JSON.parse(Buffer.from(JSON.parse(opts.payload).content, "base64").toString("utf8")); return orig(url, opts); };
  post(env, { action: "saveSample", session: login.session, name: "冒名的人", sample: sample() });
  check("通行證決定名字（請求裡的 name 改不了）", written && written.createdBy === "訪客：小明", written && written.createdBy);
  check("團隊通行證不能刪除", /管理員/.test(post(env, { action: "trash", session: login.session, id: "FILEabcdef123456" }).error));
  const bogus = post(env, { action: "ping", session: "f".repeat(64) });
  check("不存在的通行證 → SESSION_EXPIRED", bogus.code === "SESSION_EXPIRED", bogus);
  check("格式不對的通行證 → SESSION_EXPIRED", post(env, { action: "ping", session: "../x" }).code === "SESSION_EXPIRED");
  check("錯的管理員密碼登入被拒", /管理員密碼錯誤/.test(post(env, { action: "login", code: "lip2026", adminCode: "nope", turnstile: "PASS" }).error));
  const adm = post(env, { action: "login", code: "lip2026", adminCode: STRONG + "X", name: "雪", turnstile: "PASS" });
  check("管理員登入 → role=admin", adm.ok === true && adm.role === "admin" && adm.name === "管理員：雪", adm);
  check("管理員通行證可以通過刪除權限檢查", !/管理員/.test(String(post(env, { action: "trash", session: adm.session, id: "FILEabcdef123456" }).error || "")));
  check("登出成功", post(env, { action: "logout", session: login.session }).ok === true);
  check("登出後通行證失效", post(env, { action: "ping", session: login.session }).code === "SESSION_EXPIRED");
  { const r = post(env, { action: "ping", session: adm.session }); check("管理員通行證不受別人登出影響", r.ok === true, r); }
  check("登出亂傳東西不會出錯", post(env, { action: "logout", session: { x: 1 } }).ok === true);
  const env2 = makeEnv({ TEAM_CODE: "lip2026", ADMIN_CODE: STRONG + "X", GITHUB_TOKEN: "x", TURNSTILE_SECRET: "SECRET", TURNSTILE_HOSTNAMES: "a.test, b.test" });
  env2.__tsHost = "b.test";
  check("TURNSTILE_HOSTNAMES 可設多個網域", post(env2, { action: "login", code: "lip2026", turnstile: "PASS" }).ok === true);
  { const r = post(env, { action: "ping", token: "GOODTOKEN_xxxxxxxxxxxxxxxx" }); check("開發者 token 不受 Turnstile 影響", r.ok === true, r); }
  // S1：換通關碼後，舊通行證立刻失效
  {
    const props = { TEAM_CODE: "lip2026", ADMIN_CODE: STRONG + "X", GITHUB_TOKEN: "x", TURNSTILE_SECRET: "SECRET", ROOT_FOLDER_ID: "ROOTFOLDERID" };
    const e = makeEnv(props);
    const t1 = post(e, { action: "login", code: "lip2026", name: "甲", turnstile: "PASS" }).session;
    const a1 = post(e, { action: "login", code: "lip2026", adminCode: STRONG + "X", name: "雪", turnstile: "PASS" }).session;
    check("S1：快取裡沒有通關碼原文", ![...e.__cache.values()].some((v) => String(v).includes("lip2026") || String(v).includes(STRONG)));
    props.ADMIN_CODE = STRONG + "Y";
    check("S1：換管理員密碼 → 管理員通行證失效", post(e, { action: "ping", session: a1 }).code === "SESSION_EXPIRED");
    check("S1：換管理員密碼不影響團隊通行證", post(e, { action: "ping", session: t1 }).ok === true);
    props.TEAM_CODE = "new2026";
    const r = post(e, { action: "ping", session: t1 });
    check("S1：換團隊通關碼 → 團隊通行證失效", r.code === "SESSION_EXPIRED" && /通關碼已更換/.test(r.error), r);
    check("S1：失效的通行證從快取移除", post(e, { action: "ping", session: t1 }).error === "登入已過期，請重新登入");
    check("S1：舊通關碼無法重新登入", /通關碼錯誤/.test(post(e, { action: "login", code: "lip2026", turnstile: "PASS" }).error));
    const t2 = post(e, { action: "login", code: "new2026", turnstile: "PASS" }).session;
    check("S1：新通關碼登入後可用", post(e, { action: "ping", session: t2 }).ok === true);
    e.__cache.set([...e.__cache.keys()].find((k) => k.startsWith("sess_")), JSON.stringify({ role: "team", name: "舊版" }));
    check("S1：沒有指紋的舊版通行證視為過期", [...e.__cache.keys()].some((k) => k.startsWith("sess_")) && post(e, { action: "ping", session: t2 }).code === "SESSION_EXPIRED");
  }
  let n = 0;
  for (let i = 0; i < 70; i++) if (/太頻繁|太多/.test(String(post(env2, { action: "login", code: "x", turnstile: "FAIL" }).error))) n++;
  check("登入每分鐘有上限", n > 0, n);
  const env3 = makeEnv({ TEAM_CODE: "lip2026", ADMIN_CODE: STRONG + "X", GITHUB_TOKEN: "x", TURNSTILE_SECRET: "SECRET" });
  env3.__cache.set("rated_login_20261119-120000", "2000");
  const before = env3.__fetchLog.length;
  check("登入每日上限用完後被拒，而且不再連 Cloudflare", /今天/.test(String(post(env3, { action: "login", code: "lip2026", turnstile: "PASS" }).error)) && env3.__fetchLog.length === before);
}

console.log(`\n結果：${pass} 通過，${fail} 失敗`);
process.exit(fail ? 1 : 0);
