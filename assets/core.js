/* 共用模組：口型特徵擷取、DTW 比對、GitHub 存取、介面小工具。
 * 以一般 <script> 載入（不是 ES module），所以直接雙擊 HTML 開啟也能用。
 * 安全：所有外部字串一律用 textContent 放進畫面；token 只存在使用者自己的瀏覽器。 */
(function () {
  "use strict";

  const CFG = Object.assign({ owner: "", repo: "", branch: "main" }, window.LR_CONFIG || {});
  const MP_VERSION = "0.10.14";
  const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
  const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
  const MODEL_URL =
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

  const FPS = 25;
  const MAX_SECONDS = 15;
  const MAX_LABEL = 40;
  const MAX_SPEAKER = 20;
  const MAX_FRAMES = 2000;
  const MAX_SAMPLE_BYTES = 2 * 1024 * 1024;

  // 16 個嘴部表情係數（左右成對取平均，影片左右翻轉不影響）＋ 4 個嘴型幾何量
  const BS_GROUPS = [
    ["jawOpen"], ["mouthClose"], ["mouthFunnel"], ["mouthPucker"],
    ["mouthLeft", "mouthRight"], ["mouthSmileLeft", "mouthSmileRight"],
    ["mouthFrownLeft", "mouthFrownRight"], ["mouthDimpleLeft", "mouthDimpleRight"],
    ["mouthStretchLeft", "mouthStretchRight"], ["mouthRollLower"], ["mouthRollUpper"],
    ["mouthShrugLower"], ["mouthShrugUpper"], ["mouthPressLeft", "mouthPressRight"],
    ["mouthLowerDownLeft", "mouthLowerDownRight"], ["mouthUpperUpLeft", "mouthUpperUpRight"],
  ];
  const DIM = BS_GROUPS.length + 4;
  // 嘴唇外圈、內圈各 20 點（依輪廓順序），用來存座標做嘴型重播
  const LIP_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
  const LIP_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
  const LIP_LEN = (LIP_OUTER.length + LIP_INNER.length) * 2;
  const MAX_VIDEO_BYTES = 30 * 1024 * 1024; // Apps Script 單次請求上限約 50 MB（base64 會變大 1/3）
  const UPLOAD_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,200}\/exec$/;

  const LR = (window.LR = { FPS, MAX_SECONDS, MAX_LABEL, MAX_SPEAKER, DIM, MAX_VIDEO_BYTES, events: new EventTarget() });

  // ───────────────────────── 小工具 ─────────────────────────
  LR.el = function (tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === "class") e.className = v;
        else if (k === "text") e.textContent = v;
        else if (k === "style") e.style.cssText = v;
        else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
    return e;
  };
  LR.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  LR.pct = (x, d = 0) => (Number.isFinite(x) ? (x * 100).toFixed(d) + "%" : "—");
  LR.fmtDate = (iso) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "—";
    return new Date(t).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  };
  LR.cleanText = (s, max) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
  LR.isVideoFile = (f) => !!f && (/^video\//.test(f.type) || /\.(mp4|m4v|mov|qt|webm|mkv|avi|3gp)$/i.test(f.name));
  LR.isTouch = () => window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  LR.reducedMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  LR.fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
  // CSV：加 BOM 讓 Excel 正確顯示中文；開頭是 = + - @ 的儲存格加 ' 防止公式注入
  LR.toCsv = (rows) => "﻿" + rows.map((r) => r.map((v) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\r\n");
  LR.downloadText = (name, text, type) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: type || "text/plain;charset=utf-8" }));
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  };
  // 檔名：念的內容_錄製者_編號.mp4
  // 手機／相機自動取的檔名（IMG_0001.MOV、VID_2026…、PXL_…）不是標註，不要拿來當內容
  const CAMERA_NAME_RE = /^(img|vid|mov|mvi|pxl|dsc|dscn|dcim|gopr|gh\d+|screen|rpreplay|capturedvideo|trim|video|錄影)[-_. ]?\d/i;
  LR.parseVideoName = (name) => {
    const base = String(name).replace(/\.[^.]+$/, "");
    const parts = base.split("_");
    if (parts.length < 2 || CAMERA_NAME_RE.test(base) || /^\d+$/.test(parts[0])) return { label: "", speaker: "" };
    return { label: LR.cleanText(parts[0], MAX_LABEL), speaker: LR.cleanText(parts[1], MAX_SPEAKER) };
  };
  LR.download = (name, text) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  };
  const store = {
    get(area, k) { try { return window[area].getItem(k); } catch { return null; } },
    set(area, k, v) { try { window[area].setItem(k, v); return true; } catch { return false; } },
    del(area, k) { try { window[area].removeItem(k); } catch { /* 封鎖儲存時忽略 */ } },
  };
  LR.store = store;

  LR.toast = function (msg, kind = "info", ms = 4500) {
    let box = document.getElementById("toasts");
    if (!box) {
      box = LR.el("div", { id: "toasts", class: "toasts", "aria-live": "polite" });
      document.body.append(box);
    }
    const icon = { good: "✓", bad: "!", warn: "▲", info: "i" }[kind] || "i";
    const t = LR.el("div", { class: `toast ${kind}` }, LR.el("span", { class: "toast-icon", "aria-hidden": "true", text: icon }), LR.el("span", { text: msg }));
    box.append(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 250); }, ms);
  };

  LR.initTooltip = function () {
    const tip = LR.el("div", { class: "tooltip", role: "tooltip" });
    document.body.append(tip);
    const place = (x, y) => {
      const r = tip.getBoundingClientRect();
      let left = x + 14, top = y + 14;
      if (left + r.width > innerWidth - 8) left = x - r.width - 14;
      if (top + r.height > innerHeight - 8) top = y - r.height - 14;
      tip.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
    };
    document.addEventListener("pointermove", (e) => {
      const t = e.target.closest && e.target.closest("[data-tip]");
      if (!t) { tip.classList.remove("show"); return; }
      if (tip.textContent !== t.dataset.tip) tip.textContent = t.dataset.tip;
      tip.classList.add("show");
      place(e.clientX, e.clientY);
    });
    document.addEventListener("focusin", (e) => {
      const t = e.target.closest && e.target.closest("[data-tip]");
      if (!t) return;
      tip.textContent = t.dataset.tip;
      tip.classList.add("show");
      const r = t.getBoundingClientRect();
      place(r.left, r.bottom);
    });
    document.addEventListener("focusout", () => tip.classList.remove("show"));
    window.addEventListener("scroll", () => tip.classList.remove("show"), { passive: true });
  };

  // ───────────────────────── 口型特徵擷取 ─────────────────────────
  let mp = null, landmarker = null, modelPromise = null;

  LR.loadModel = function () {
    if (!modelPromise) {
      modelPromise = (async () => {
        mp = await import(MP_URL);
        const fileset = await mp.FilesetResolver.forVisionTasks(WASM_URL);
        const opts = (delegate) => ({
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          outputFaceBlendshapes: true,
          // 逐格獨立偵測：不沿用上一格／上一支影片的追蹤狀態，同一支影片每次結果都一樣
          runningMode: "IMAGE",
          numFaces: 1,
        });
        try {
          landmarker = await mp.FaceLandmarker.createFromOptions(fileset, opts("GPU"));
        } catch (e) {
          console.warn("GPU 初始化失敗，改用 CPU：", e);
          landmarker = await mp.FaceLandmarker.createFromOptions(fileset, opts("CPU"));
        }
        return landmarker;
      })();
      modelPromise.catch(() => { modelPromise = null; });
    }
    return modelPromise;
  };

  function waitEvent(el, ok, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { cleanup(); reject(new Error("讀取影片逾時")); }, timeoutMs);
      const onOk = () => { cleanup(); resolve(); };
      const onErr = () => {
        cleanup();
        reject(new Error("這台電腦的瀏覽器解不開這個影片格式（常見於 iPhone 的 HEVC）。請直接用手機開網頁處理，或把 iPhone 相機格式改成「最相容」"));
      };
      const cleanup = () => { clearTimeout(t); el.removeEventListener(ok, onOk); el.removeEventListener("error", onErr); };
      el.addEventListener(ok, onOk);
      el.addEventListener("error", onErr);
    });
  }

  function frameFeature(res, W, H) {
    if (!res?.faceLandmarks?.length || !res?.faceBlendshapes?.length) return null;
    const lm = res.faceLandmarks[0];
    const bs = {};
    for (const c of res.faceBlendshapes[0].categories) bs[c.categoryName] = c.score;
    const f = BS_GROUPS.map((g) => g.reduce((s, k) => s + (bs[k] ?? 0), 0) / g.length);
    const d = (a, b) => Math.hypot((lm[a].x - lm[b].x) * W, (lm[a].y - lm[b].y) * H);
    const eye = d(33, 263) || 1e-6; // 兩眼外角距離，用來正規化臉的大小
    const outerW = d(61, 291) / eye, innerW = d(78, 308) / eye;
    const innerH = d(13, 14) / eye, outerH = d(0, 17) / eye;
    f.push(outerW, innerH, outerH, innerH / (innerW + 1e-6));
    return f;
  }

  // 嘴唇輪廓座標：以嘴角中點為原點、兩眼距離為單位，並轉正頭部傾斜
  function lipShape(res, W, H) {
    const lm = res.faceLandmarks[0];
    const P = (i) => [lm[i].x * W, lm[i].y * H];
    const [ax, ay] = P(33), [bx, by] = P(263);
    const eye = Math.hypot(bx - ax, by - ay) || 1e-6;
    const ang = Math.atan2(by - ay, bx - ax);
    const [lx, ly] = P(61), [rx, ry] = P(291);
    const cx = (lx + rx) / 2, cy = (ly + ry) / 2;
    const cos = Math.cos(-ang), sin = Math.sin(-ang);
    const out = [];
    for (const i of LIP_OUTER.concat(LIP_INNER)) {
      const [x, y] = P(i);
      const dx = (x - cx) / eye, dy = (y - cy) / eye;
      out.push(Math.round((dx * cos - dy * sin) * 1000) / 1000, Math.round((dx * sin + dy * cos) * 1000) / 1000);
    }
    return out;
  }

  let lipIdx = null;
  function drawLips(ctx, drawer, res) {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (!res?.faceLandmarks?.length) return;
    const lm = res.faceLandmarks[0];
    const conn = mp.FaceLandmarker.FACE_LANDMARKS_LIPS;
    const lw = Math.max(2, ctx.canvas.width / 320);
    drawer.drawConnectors(lm, conn, { color: "#ff4d6d", lineWidth: lw });
    if (!lipIdx) {
      const s = new Set();
      for (const c of conn) { s.add(c.start); s.add(c.end); }
      lipIdx = [...s];
    }
    drawer.drawLandmarks(lipIdx.map((i) => lm[i]), { color: "#ffd166", radius: lw * 0.8, lineWidth: 0 });
  }

  // 減去開頭靜止嘴型（降低個人差異），並裁掉前後沒動作的影格
  function preprocess(raw) {
    const k = Math.min(5, raw.length);
    const base = new Array(DIM).fill(0);
    for (let i = 0; i < k; i++) for (let j = 0; j < DIM; j++) base[j] += raw[i][j] / k;
    const rel = raw.map((f) => f.map((v, j) => v - base[j]));
    const energy = rel.map((f) => Math.hypot(...f));
    const thr = Math.max(...energy) * 0.15;
    let s = energy.findIndex((v) => v > thr);
    let e = energy.length - 1 - [...energy].reverse().findIndex((v) => v > thr);
    let out = rel;
    if (s >= 0) {
      s = Math.max(0, s - 2);
      e = Math.min(rel.length - 1, e + 2);
      if (e - s + 1 >= 3) out = rel.slice(s, e + 1);
    }
    return out.map((f) => f.map((v) => Math.round(v * 1e4) / 1e4));
  }

  /** 讀一段影片，逐格抓嘴唇節點，回傳 { frames, lips, quality }。 */
  LR.extract = async function (file, { video, canvas, onProgress, shouldStop } = {}) {
    await LR.loadModel();
    video = video || document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.preload = "auto";
    const ctx = canvas ? canvas.getContext("2d") : null;
    const drawer = ctx ? new mp.DrawingUtils(ctx) : null;
    const url = URL.createObjectURL(file);
    try {
      const loaded = waitEvent(video, "loadeddata", 15000);
      video.src = url;
      video.load();
      // iPhone Safari 要先 play 一下才會真的載入影格（靜音行內播放不需要使用者手勢）
      const p = video.play();
      if (p && p.then) p.then(() => video.pause()).catch(() => {});
      if (video.readyState < 2) await loaded; else loaded.catch(() => {});
      video.pause();
      const W = video.videoWidth, H = video.videoHeight;
      if (!W || !H) throw new Error("讀不到影像尺寸");
      if (video.duration === Infinity) {
        // 瀏覽器錄的 webm 常缺長度資訊：跳到極遠處逼它算出長度
        video.currentTime = 1e7;
        await waitEvent(video, "seeked").catch(() => {});
      }
      const dur = video.duration;
      if (!Number.isFinite(dur) || dur <= 0) throw new Error("讀不到影片長度");
      if (dur > MAX_SECONDS) throw new Error(`影片太長（${dur.toFixed(1)} 秒），請剪成一段一句、${MAX_SECONDS} 秒以內`);
      if (canvas) { canvas.width = W; canvas.height = H; }

      const n = Math.max(1, Math.floor(dur * FPS));
      const raw = [], lips = [];
      let miss = 0;
      for (let i = 0; i < n; i++) {
        if (shouldStop && shouldStop()) throw new Error("已停止");
        video.currentTime = Math.min((i + 0.5) / FPS, dur - 0.001);
        await waitEvent(video, "seeked");
        const res = landmarker.detect(video);
        if (drawer) drawLips(ctx, drawer, res);
        const f = frameFeature(res, W, H);
        if (f) { raw.push(f); lips.push(lipShape(res, W, H)); } else miss++;
        if (onProgress) onProgress({ i: i + 1, n, found: raw.length, dur });
      }
      const quality = { frames: n, missed: miss, duration: Math.round(dur * 100) / 100, width: W, height: H };
      if (raw.length < 5 || miss > n * 0.5) {
        throw new Error(`有 ${miss}/${n} 格抓不到臉：請正面拍、光線充足、臉不要出鏡`);
      }
      return { frames: preprocess(raw), lips, quality };
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  // ───────────────────────── 比對（DTW 最近鄰） ─────────────────────────
  LR.weights = function (samples) {
    const sum = new Array(DIM).fill(0), sq = new Array(DIM).fill(0);
    let n = 0;
    for (const s of samples) for (const f of s.frames) {
      n++;
      for (let j = 0; j < DIM; j++) { sum[j] += f[j]; sq[j] += f[j] * f[j]; }
    }
    if (n < 2) return new Array(DIM).fill(1);
    return sum.map((s, j) => {
      const m = s / n;
      return 1 / (Math.sqrt(Math.max(sq[j] / n - m * m, 0)) + 1e-3);
    });
  };

  LR.dtw = function (a, b, w) {
    const m = b.length;
    let prev = new Float64Array(m + 1).fill(Infinity);
    prev[0] = 0;
    for (let i = 1; i <= a.length; i++) {
      const cur = new Float64Array(m + 1).fill(Infinity);
      const ai = a[i - 1];
      for (let j = 1; j <= m; j++) {
        const bj = b[j - 1];
        let c = 0;
        for (let k = 0; k < DIM; k++) { const d = (ai[k] - bj[k]) * w[k]; c += d * d; }
        cur[j] = Math.sqrt(c) + Math.min(prev[j], cur[j - 1], prev[j - 1]);
      }
      prev = cur;
    }
    return prev[m] / (a.length + m);
  };

  /** 回傳每個內容的最近距離，由近到遠。 */
  LR.classify = function (query, samples, w = LR.weights(samples)) {
    const best = new Map();
    for (const s of samples) {
      const d = LR.dtw(query, s.frames, w);
      const b = best.get(s.label);
      if (!b || d < b.dist) best.set(s.label, { label: s.label, dist: d, sample: s });
    }
    return [...best.values()].sort((x, y) => x.dist - y.dist);
  };

  LR.distanceMatrix = async function (samples, w, onProgress) {
    const n = samples.length;
    const D = new Float32Array(n * n);
    const total = (n * (n - 1)) / 2 || 1;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = LR.dtw(samples[i].frames, samples[j].frames, w);
        D[i * n + j] = d;
        D[j * n + i] = d;
      }
      if (i % 3 === 0 || i === n - 1) {
        if (onProgress) onProgress(((i + 1) * (n - 1) - (i * (i + 1)) / 2) / total);
        await LR.sleep(0);
      }
    }
    return D;
  };

  /** mode = "loo"（留一法）或 "cross"（跨錄製者：只用其他人的範本）。 */
  LR.evaluate = function (samples, D, mode) {
    const n = samples.length, out = [];
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      if (mode === "cross" && !s.speaker) continue;
      let best = -1, bd = Infinity, hasTruth = false;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const o = samples[j];
        if (mode === "cross" && (!o.speaker || o.speaker === s.speaker)) continue;
        if (o.label === s.label) hasTruth = true;
        const d = D[i * n + j];
        if (d < bd) { bd = d; best = j; }
      }
      if (best < 0 || !hasTruth) continue;
      out.push({ sample: s, truth: s.label, pred: samples[best].label, nearest: samples[best], correct: samples[best].label === s.label });
    }
    return out;
  };

  LR.summarize = function (results, labels) {
    const idx = new Map(labels.map((l, i) => [l, i]));
    const M = labels.map(() => labels.map(() => 0));
    const perSpeaker = new Map();
    let hit = 0;
    for (const r of results) {
      M[idx.get(r.truth)][idx.get(r.pred)]++;
      if (r.correct) hit++;
      const sp = r.sample.speaker || "（未填）";
      const p = perSpeaker.get(sp) || { key: sp, n: 0, hit: 0 };
      p.n++; if (r.correct) p.hit++;
      perSpeaker.set(sp, p);
    }
    const perLabel = labels.map((l, i) => {
      const n = M[i].reduce((a, b) => a + b, 0);
      return { key: l, n, hit: M[i][i] };
    }).filter((x) => x.n > 0);
    const confusions = [];
    labels.forEach((a, i) => labels.forEach((b, j) => {
      if (i !== j && M[i][j] > 0) {
        const rowN = M[i].reduce((x, y) => x + y, 0);
        confusions.push({ truth: a, pred: b, count: M[i][j], share: M[i][j] / rowN });
      }
    }));
    confusions.sort((x, y) => y.count - x.count || y.share - x.share);
    return { n: results.length, hit, acc: results.length ? hit / results.length : NaN, matrix: M, perLabel, perSpeaker: [...perSpeaker.values()], confusions };
  };

  // ───────────────────────── 樣本格式 ─────────────────────────
  const num = (v) => (Number.isFinite(v) ? v : null);
  LR.validateSample = function (o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    if (typeof o.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(o.id)) return null;
    const label = LR.cleanText(o.label, MAX_LABEL);
    if (!label) return null;
    const f = o.frames;
    if (!Array.isArray(f) || f.length < 3 || f.length > MAX_FRAMES) return null;
    for (const r of f) if (!Array.isArray(r) || r.length !== DIM || !r.every(Number.isFinite)) return null;
    const v = o.video && typeof o.video === "object" ? o.video : {};
    const q = o.quality && typeof o.quality === "object" ? o.quality : {};
    let lips = null;
    if (Array.isArray(o.lips) && o.lips.length >= 3 && o.lips.length <= MAX_FRAMES &&
        o.lips.every((r) => Array.isArray(r) && r.length === LIP_LEN && r.every(Number.isFinite))) lips = o.lips;
    const driveId = typeof v.driveId === "string" && /^[A-Za-z0-9_-]{10,100}$/.test(v.driveId) ? v.driveId : "";
    return {
      schema: 1,
      id: o.id,
      label,
      speaker: LR.cleanText(o.speaker, MAX_SPEAKER),
      video: {
        name: LR.cleanText(v.name, 200), path: LR.cleanText(v.path, 400), source: LR.cleanText(v.source, 40),
        driveId, folder: LR.cleanText(v.folder, 100),
      },
      fps: FPS,
      dims: DIM,
      frames: f,
      lips,
      quality: { frames: num(q.frames), missed: num(q.missed), duration: num(q.duration) },
      createdAt: typeof o.createdAt === "string" && Number.isFinite(Date.parse(o.createdAt)) ? o.createdAt : "",
      createdBy: LR.cleanText(o.createdBy, 60),
    };
  };

  LR.newId = function () {
    const d = new Date(), p = (x) => String(x).padStart(2, "0");
    const rnd = [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rnd}`;
  };

  LR.newSample = function ({ label, speaker, frames, lips, quality, file, author, drive }) {
    return {
      schema: 1,
      id: LR.newId(),
      label,
      speaker,
      video: drive
        ? { name: drive.name || file.name, path: file.name, source: "google-drive", driveId: drive.id, folder: drive.folder || "" }
        : { name: file.name, path: file.webkitRelativePath || file.name, source: file.webkitRelativePath ? "google-drive-sync" : "local" },
      fps: FPS,
      dims: DIM,
      frames,
      lips: lips && lips.length ? lips : null,
      quality: { frames: quality.frames, missed: quality.missed, duration: quality.duration },
      createdAt: new Date().toISOString(),
      createdBy: author || "",
    };
  };

  /** 讀本機的樣本 JSON（單筆或陣列）。 */
  LR.readSampleFiles = async function (files) {
    const out = [];
    let bad = 0;
    for (const f of files) {
      if (!/\.json$/i.test(f.name)) continue;
      if (f.size > MAX_SAMPLE_BYTES * 50) { bad++; continue; }
      try {
        const data = JSON.parse(await f.text());
        for (const o of Array.isArray(data) ? data : [data]) {
          const s = LR.validateSample(o);
          if (s) out.push(s); else bad++;
        }
      } catch { bad++; }
    }
    const seen = new Set();
    return { samples: out.filter((s) => !seen.has(s.id) && seen.add(s.id)), bad };
  };

  // ───────────────────────── GitHub 存取 ─────────────────────────
  const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
  const BRANCH_RE = /^[A-Za-z0-9._-]{1,100}$/;
  const SAMPLE_PATH_RE = /^data\/samples\/[A-Za-z0-9_-]{1,80}\.json$/;
  const SKEY = "lr-settings", TKEY = "lr-token";

  function b64encodeUtf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64decodeUtf8(b64) {
    const bin = atob(String(b64).replace(/\s/g, ""));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  function ghError(status, msg) {
    switch (status) {
      case 401: return "GitHub token 無效或已過期，請重新設定";
      case 403: return /rate limit/i.test(msg) ? "GitHub API 次數用完，請稍後再試" : "權限不足：token 需要這個 repo 的 Contents 讀寫權限";
      case 404: return "找不到 repo 或分支（確認名稱，以及 token 有授權這個 repo）";
      case 409: return "GitHub 正在處理其他寫入，請再試一次";
      case 422: return "GitHub 拒絕這筆資料（可能檔案已存在）";
      default: return `GitHub 錯誤 ${status}${msg ? "：" + msg : ""}`;
    }
  }

  LR.settings = {
    get() {
      let s = {};
      try { s = JSON.parse(store.get("localStorage", SKEY) || "{}") || {}; } catch { s = {}; }
      return {
        owner: s.owner || CFG.owner,
        repo: s.repo || CFG.repo,
        branch: s.branch || CFG.branch || "main",
        login: s.login || "",
        uploadUrl: s.uploadUrl != null ? s.uploadUrl : (CFG.uploadUrl || ""),
      };
    },
    token() { return store.get("sessionStorage", TKEY) || store.get("localStorage", TKEY) || ""; },
    remembered() { return !!store.get("localStorage", TKEY); },
    save(s, token, remember) {
      store.set("localStorage", SKEY, JSON.stringify({ owner: s.owner, repo: s.repo, branch: s.branch, login: s.login || "", uploadUrl: s.uploadUrl || "" }));
      store.del("sessionStorage", TKEY);
      store.del("localStorage", TKEY);
      if (token) store.set(remember ? "localStorage" : "sessionStorage", TKEY, token);
    },
    disconnect() {
      store.del("sessionStorage", TKEY);
      store.del("localStorage", TKEY);
    },
    valid(s) { return NAME_RE.test(s.owner || "") && NAME_RE.test(s.repo || "") && BRANCH_RE.test(s.branch || ""); },
    validUploadUrl(u) { return !u || UPLOAD_URL_RE.test(u); },
  };

  // ───────────────────────── Google 雲端上傳（經 Apps Script 中繼） ─────────────────────────
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(new Error("讀取影片檔失敗"));
      r.readAsDataURL(file);
    });
  }
  LR.drive = {
    url() { const u = LR.settings.get().uploadUrl; return UPLOAD_URL_RE.test(u || "") ? u : ""; },
    enabled() { return !!this.url() && LR.gh.connected(); },
    async call(payload) {
      const url = this.url();
      if (!url) throw new Error("尚未設定影片上傳網址");
      let res;
      try {
        // 不加自訂 header（text/plain），避免 CORS 預檢；host 固定為 script.google.com
        res = await fetch(url, { method: "POST", body: JSON.stringify(Object.assign({ token: LR.settings.token() }, payload)), redirect: "follow" });
      } catch {
        throw new Error("連不到 Google 上傳服務，請檢查網路");
      }
      let j;
      try { j = await res.json(); } catch { throw new Error("上傳服務回應格式錯誤（確認 Apps Script 有部署成「網頁應用程式」、存取權為「所有人」）"); }
      if (!j || !j.ok) throw new Error("雲端上傳失敗：" + LR.cleanText(j && j.error, 200));
      return j;
    },
    async ping() { return this.call({ action: "ping" }); },
    async upload(file, label, speaker) {
      if (file.size > MAX_VIDEO_BYTES) throw new Error(`影片太大（${LR.fmtSize(file.size)}），上限 ${LR.fmtSize(MAX_VIDEO_BYTES)}；請錄短一點或降低畫質`);
      const ext = ((file.name.match(/\.([A-Za-z0-9]{2,4})$/) || [])[1] || "mp4").toLowerCase();
      const data = await fileToBase64(file);
      const j = await this.call({ action: "upload", label, speaker, mimeType: file.type || "video/mp4", ext, data });
      if (!/^[A-Za-z0-9_-]{10,100}$/.test(j.id || "")) throw new Error("雲端回傳的檔案編號不正確");
      return { id: j.id, name: LR.cleanText(j.name, 200), folder: LR.cleanText(j.folder, 100) };
    },
    async trash(id) {
      if (!/^[A-Za-z0-9_-]{10,100}$/.test(id || "")) return;
      await this.call({ action: "trash", id });
    },
    viewUrl: (id) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`,
    previewUrl: (id) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/preview`,
  };

  // ───────────────────────── 嘴型重播動畫 ─────────────────────────
  const NPT = LIP_OUTER.length;
  LR.LipPlayer = class {
    constructor(canvas) {
      this.c = canvas;
      this.ctx = canvas.getContext("2d");
      this.frames = null;
      this.i = 0;
      this.speed = 1;
      this.playing = false;
      this.onTick = null;
      this._raf = 0;
      this._acc = 0;
      this._last = 0;
      this.message = "";
      new ResizeObserver(() => this.draw()).observe(canvas);
    }
    load(lips, message) {
      this.pause();
      this.frames = lips && lips.length ? lips : null;
      this.message = message || "這段是舊資料，沒有存嘴型座標";
      this.i = 0;
      this.draw();
    }
    play() {
      if (!this.frames || this.playing) return;
      this.playing = true;
      this._last = performance.now();
      this._acc = 0;
      const tick = (now) => {
        if (!this.playing) return;
        this._acc += (now - this._last) * this.speed;
        this._last = now;
        const step = 1000 / FPS;
        while (this._acc >= step) { this._acc -= step; this.i = (this.i + 1) % this.frames.length; }
        this.draw();
        this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    }
    pause() { this.playing = false; cancelAnimationFrame(this._raf); }
    toggle() { this.playing ? this.pause() : this.play(); }
    restart() { this.i = 0; this._acc = 0; this.draw(); }
    draw() {
      const c = this.c, ctx = this.ctx, dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth, h = c.clientHeight;
      if (!w || !h) return;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const css = getComputedStyle(c);
      const v = (name, fb) => (css.getPropertyValue(name).trim() || fb);
      if (!this.frames) {
        ctx.fillStyle = v("--muted", "#898781");
        ctx.font = "13px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(this.message, w / 2, h / 2);
        if (this.onTick) this.onTick(0, 0);
        return;
      }
      const s = Math.min(w / 0.95, h / 0.8);
      const ox = w / 2, oy = h / 2;
      const path = (f, start) => {
        ctx.beginPath();
        for (let k = 0; k < NPT; k++) {
          const x = ox + f[(start + k) * 2] * s, y = oy + f[(start + k) * 2 + 1] * s;
          k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.closePath();
      };
      // 參考：第一格（閉嘴）的外輪廓，虛線
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = v("--line-strong", "#c3c2b7");
      path(this.frames[0], 0);
      ctx.stroke();
      ctx.setLineDash([]);
      const f = this.frames[this.i];
      path(f, 0);
      ctx.fillStyle = v("--lip-fill", "#f2a7b5");
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = v("--lip-stroke", "#c2405c");
      ctx.stroke();
      path(f, NPT);
      ctx.fillStyle = v("--mouth", "#3a1d24");
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (this.onTick) this.onTick(this.i, this.frames.length);
    }
  };

  const blobCache = new Map();

  LR.gh = {
    connected() { return !!LR.settings.token() && LR.settings.valid(LR.settings.get()); },

    async request(path, { method = "GET", body, settings, token } = {}) {
      const s = settings || LR.settings.get();
      const tk = token != null ? token : LR.settings.token();
      if (!LR.settings.valid(s)) throw new Error("repo 或分支名稱格式不正確");
      // host 固定為 api.github.com；owner/repo 已用白名單格式檢查
      const url = path.startsWith("/")
        ? "https://api.github.com" + path
        : `https://api.github.com/repos/${s.owner}/${s.repo}` + (path ? "/" + path : "");
      const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
      if (tk) headers.Authorization = `Bearer ${tk}`;
      if (body) headers["Content-Type"] = "application/json";
      let res;
      try {
        res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
      } catch {
        throw new Error("連不到 GitHub，請檢查網路");
      }
      if (!res.ok) {
        let msg = "";
        try { msg = (await res.json()).message || ""; } catch { /* 非 JSON 錯誤 */ }
        const err = new Error(ghError(res.status, msg));
        err.status = res.status;
        throw err;
      }
      return res.status === 204 ? null : res.json();
    },

    async connect(settings, token) {
      const user = await this.request("/user", { settings, token });
      let repo;
      try {
        repo = await this.request("", { settings, token });
      } catch (e) {
        // 私有 repo 沒權限時 GitHub 一律回 404
        if (e.status === 404) {
          const err = new Error(`token 有效（${LR.cleanText(user.login, 60)}），但沒有授權 ${settings.repo}：請到 GitHub 的 token 設定，在 Repository access 勾選這個 repo，並把 Contents 設為 Read and write`);
          err.status = 404;
          throw err;
        }
        throw e;
      }
      return { login: LR.cleanText(user.login, 60), isPrivate: !!repo.private };
    },

    async listEntries() {
      const s = LR.settings.get();
      let tree;
      try {
        tree = await this.request(`git/trees/${encodeURIComponent(s.branch)}?recursive=1`);
      } catch (e) {
        if (e.status === 409) return { entries: [], truncated: false }; // 空的 repo
        throw e;
      }
      const entries = (tree.tree || []).filter(
        (t) => t.type === "blob" && SAMPLE_PATH_RE.test(t.path) && /^[0-9a-f]{40}$/.test(t.sha) && (t.size || 0) <= MAX_SAMPLE_BYTES
      );
      return { entries, truncated: !!tree.truncated };
    },

    async readBlob(sha) {
      if (blobCache.has(sha)) return blobCache.get(sha);
      const key = "lr-blob:" + sha;
      const cached = store.get("sessionStorage", key);
      if (cached) {
        try { const o = JSON.parse(cached); blobCache.set(sha, o); return o; } catch { /* 快取壞掉就重抓 */ }
      }
      const b = await this.request(`git/blobs/${sha}`);
      const text = b64decodeUtf8(b.content || "");
      if (text.length > MAX_SAMPLE_BYTES) throw new Error("樣本檔太大");
      const o = JSON.parse(text);
      blobCache.set(sha, o);
      store.set("sessionStorage", key, text);
      return o;
    },

    /** 讀出 repo 裡全部樣本。 */
    async loadSamples(onProgress) {
      const { entries, truncated } = await this.listEntries();
      const out = [];
      let done = 0, bad = 0;
      const queue = entries.slice();
      const worker = async () => {
        while (queue.length) {
          const e = queue.shift();
          try {
            const s = LR.validateSample(await this.readBlob(e.sha));
            if (s) out.push(Object.assign(s, { _path: e.path, _sha: e.sha }));
            else bad++;
          } catch (err) {
            if (err.status === 401 || err.status === 403) throw err;
            bad++;
          }
          done++;
          if (onProgress) onProgress(done, entries.length);
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, entries.length) }, worker));
      out.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
      return { samples: out, bad, truncated };
    },

    async putSample(sample) {
      const s = LR.settings.get();
      const path = `data/samples/${sample.id}.json`;
      if (!SAMPLE_PATH_RE.test(path)) throw new Error("樣本編號格式不正確");
      const body = {
        message: `新增樣本：${sample.label}（${sample.speaker || "未填錄製者"}）`,
        content: b64encodeUtf8(JSON.stringify(sample)),
        branch: s.branch,
      };
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await this.request(`contents/${path}`, { method: "PUT", body });
          return Object.assign(sample, { _path: path, _sha: r && r.content ? r.content.sha : "" });
        } catch (e) {
          if (e.status === 409 && attempt < 3) { await LR.sleep(700 * (attempt + 1)); continue; }
          throw e;
        }
      }
    },

    async deleteSample(sample) {
      const s = LR.settings.get();
      if (!SAMPLE_PATH_RE.test(sample._path || "") || !/^[0-9a-f]{40}$/.test(sample._sha || "")) throw new Error("這筆樣本不在 GitHub 上");
      await this.request(`contents/${sample._path}`, {
        method: "DELETE",
        body: { message: `刪除樣本：${sample.label}（${sample.speaker || "未填錄製者"}）`, sha: sample._sha, branch: s.branch },
      });
    },
  };

  // ───────────────────────── 頂部導覽列與連線設定 ─────────────────────────
  LR.mountHeader = function (active) {
    const bar = document.getElementById("appbar");
    const chip = LR.el("button", { class: "conn", type: "button" });
    const renderChip = () => {
      const s = LR.settings.get(), on = LR.gh.connected();
      chip.classList.toggle("on", on);
      chip.replaceChildren(
        LR.el("span", { class: "conn-dot", "aria-hidden": "true" }),
        LR.el("span", { class: "conn-text", text: on ? `${s.owner}/${s.repo}` : "未連線 GitHub" })
      );
      chip.title = on ? `已連線（${s.login || "?"}），點擊修改設定` : "點擊設定 GitHub 連線";
    };
    const link = (href, key, text) => LR.el("a", { href, class: active === key ? "active" : null, "aria-current": active === key ? "page" : null, text });
    bar.append(
      LR.el("div", { class: "appbar-inner" },
        LR.el("a", { class: "brand", href: "index.html" },
          LR.el("span", { class: "brand-mark", "aria-hidden": "true" }, mouthIcon()),
          LR.el("span", { class: "brand-text" }, LR.el("strong", { text: "無聲溝通" }), LR.el("small", { text: "唇語辨識專題" }))
        ),
        LR.el("nav", { class: "nav", "aria-label": "頁面" }, link("index.html", "input", "前台輸入"), link("report.html", "report", "後台報告")),
        chip
      )
    );
    renderChip();
    LR.events.addEventListener("connection", renderChip);

    const dlg = buildSettingsDialog();
    document.body.append(dlg);
    chip.addEventListener("click", () => LR.openSettings());
  };

  function mouthIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", "M3 12c2.5-3.2 5.2-4.5 7-3.6.8.4 1.2.4 2 0 1.8-.9 4.5.4 7 3.6-2.6 3.6-5.6 5.2-9 5.2S5.6 15.6 3 12Zm2.6 0c2 1.1 4.2 1.6 6.4 1.6s4.4-.5 6.4-1.6");
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.7");
    p.setAttribute("stroke-linejoin", "round");
    p.setAttribute("stroke-linecap", "round");
    svg.append(p);
    return svg;
  }

  function buildSettingsDialog() {
    const f = (id, label, attrs, help) =>
      LR.el("div", { class: "field" }, LR.el("label", { for: id, text: label }), LR.el("input", Object.assign({ id, class: "input" }, attrs)), help ? LR.el("p", { class: "help", text: help }) : null);
    const status = LR.el("p", { class: "dialog-status", role: "status" });
    const remember = LR.el("input", { type: "checkbox", id: "setRemember" });
    const tokenLink = LR.el("a", { href: "https://github.com/settings/personal-access-tokens/new", target: "_blank", rel: "noopener noreferrer", text: "建立 token" });
    const btnSave = LR.el("button", { class: "btn primary", type: "submit", text: "連線並儲存" });
    const btnOff = LR.el("button", { class: "btn ghost danger", type: "button", text: "中斷連線" });
    const btnCancel = LR.el("button", { class: "btn ghost", type: "button", text: "取消" });
    const form = LR.el("form", { class: "dialog-body", method: "dialog" },
      LR.el("div", { class: "dialog-h" }, LR.el("h2", { id: "setTitle", text: "GitHub 連線設定" }), LR.el("p", { class: "help", text: "每位開發者用自己的 token。token 只存在這個瀏覽器，不會寫進程式碼或 repo。" })),
      LR.el("div", { class: "field-row" },
        f("setOwner", "帳號／組織", { autocomplete: "off", spellcheck: "false", maxlength: "100" }),
        f("setRepo", "Repo 名稱", { autocomplete: "off", spellcheck: "false", maxlength: "100" })
      ),
      f("setBranch", "分支", { autocomplete: "off", spellcheck: "false", maxlength: "100" }),
      LR.el("div", { class: "field" },
        LR.el("label", { for: "setToken" }, "Personal access token　", tokenLink),
        LR.el("input", { id: "setToken", class: "input mono", type: "password", autocomplete: "off", spellcheck: "false", placeholder: "github_pat_…" }),
        LR.el("p", { class: "help", text: "建議用 Fine-grained token：只勾這個 repo，權限 Contents 設為 Read and write，設定到期日。已連線時留空表示沿用原本的 token。" })
      ),
      LR.el("label", { class: "check" }, remember, LR.el("span", { text: "在這台電腦記住 token（公用電腦請勿勾選）" })),
      LR.el("div", { class: "field", style: "margin-top:16px" },
        LR.el("label", { for: "setUpload", text: "影片上傳網址（Google Apps Script，選填）" }),
        LR.el("input", { id: "setUpload", class: "input mono", autocomplete: "off", spellcheck: "false", placeholder: "https://script.google.com/macros/s/…/exec" }),
        LR.el("p", { class: "help", text: "設定後，前台可以把影片直接存到 Google 雲端硬碟，並依念的內容自動分資料夾。" })
      ),
      status,
      LR.el("div", { class: "dialog-actions" }, btnOff, LR.el("span", { class: "spacer" }), btnCancel, btnSave)
    );
    const dlg = LR.el("dialog", { class: "dialog", "aria-labelledby": "setTitle" }, form);

    LR.openSettings = () => {
      const s = LR.settings.get();
      form.querySelector("#setOwner").value = s.owner;
      form.querySelector("#setRepo").value = s.repo;
      form.querySelector("#setBranch").value = s.branch;
      form.querySelector("#setToken").value = "";
      form.querySelector("#setUpload").value = s.uploadUrl || "";
      remember.checked = LR.settings.remembered();
      btnOff.hidden = !LR.gh.connected();
      status.textContent = "";
      status.className = "dialog-status";
      dlg.showModal();
    };
    btnCancel.addEventListener("click", () => dlg.close());
    btnOff.addEventListener("click", () => {
      LR.settings.disconnect();
      dlg.close();
      LR.events.dispatchEvent(new Event("connection"));
      LR.toast("已中斷 GitHub 連線，token 已從這個瀏覽器移除", "info");
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const s = {
        owner: form.querySelector("#setOwner").value.trim(),
        repo: form.querySelector("#setRepo").value.trim(),
        branch: form.querySelector("#setBranch").value.trim() || "main",
        uploadUrl: form.querySelector("#setUpload").value.trim(),
      };
      const token = form.querySelector("#setToken").value.trim() || LR.settings.token();
      if (!LR.settings.valid(s)) { status.textContent = "帳號、repo 或分支名稱只能用英數字和 . _ -"; status.className = "dialog-status bad"; return; }
      if (!LR.settings.validUploadUrl(s.uploadUrl)) { status.textContent = "上傳網址格式不對，應該是 https://script.google.com/macros/s/…/exec"; status.className = "dialog-status bad"; return; }
      if (!token) { status.textContent = "請貼上 token"; status.className = "dialog-status bad"; return; }
      btnSave.disabled = true;
      status.textContent = "連線測試中…";
      status.className = "dialog-status";
      try {
        const info = await LR.gh.connect(s, token);
        LR.settings.save(Object.assign(s, { login: info.login }), token, remember.checked);
        dlg.close();
        LR.events.dispatchEvent(new Event("connection"));
        LR.toast(`已連線 ${s.owner}/${s.repo}（${info.login}）${info.isPrivate ? "" : "。注意：這是公開 repo"}`, info.isPrivate ? "good" : "warn");
        if (s.uploadUrl) {
          LR.drive.ping()
            .then(() => LR.toast("Google 雲端上傳服務連線成功", "good"))
            .catch((err) => LR.toast(err.message, "warn", 8000));
        }
      } catch (err) {
        status.textContent = err.message;
        status.className = "dialog-status bad";
      } finally {
        btnSave.disabled = false;
      }
    });
    return dlg;
  }
})();
