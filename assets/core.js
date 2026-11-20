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
  const MAX_VIDEO_BYTES = 10 * 1024 * 1024; // 跟後端一致（15 秒完整畫面約 5 MB）
  const UPLOAD_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,200}\/exec$/;

  const LR = (window.LR = { FPS, MAX_SECONDS, MAX_LABEL, MAX_SPEAKER, DIM, MAX_VIDEO_BYTES, events: new EventTarget() });
  LR.BRAND = "無聲溝通專題";
  LR.BRAND_SUB = "無聲口型資料收集";

  // ───────────────────────── 小工具 ─────────────────────────
  LR.el = function (tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === "class") e.className = v;
        else if (k === "text") e.textContent = v;
        else if (k === "style") e.style.cssText = v;
        else if (/^on/i.test(k)) {
          if (typeof v !== "function") throw new Error("事件屬性必須是函式：" + k);
          e.addEventListener(k.slice(2), v);
        }
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
  /**
   * 加上離場用的 class，等動畫或轉場跑完再 resolve（例如刪除清單項目、關閉視窗）。
   * 使用者開了「減少動態」就立刻 resolve；動畫沒觸發時最多等 ms＋80 毫秒，不會卡住。
   */
  LR.animateOut = (node, cls, ms = 260) => new Promise((resolve) => {
    if (!node || LR.reducedMotion()) { resolve(); return; }
    let done = false;
    const go = (e) => { if (e && e.target !== node) return; if (!done) { done = true; resolve(); } };
    node.addEventListener("animationend", go);
    node.addEventListener("transitionend", go);
    node.classList.add(cls);
    setTimeout(go, ms + 80);
  });
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

  // ───────────────────────── 圖示（線條 SVG，取代 emoji） ─────────────────────────
  // 路徑全部是寫死在這裡的常數，不含任何外部字串，所以可以安全地放進 SVG
  const ICONS = {
    camera: '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h2l1.5-2h6l1.5 2h2A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.5"/>',
    video: '<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="m16 10.5 5-3v9l-5-3"/>',
    shuffle: '<path d="M16 4h4v4M4 20 20 4M20 16v4h-4M15 15l5 5M4 4l5 5"/>',
    book: '<path d="M4 19.5V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2zm0 0A2 2 0 0 0 6 22h14"/>',
    star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
    rec: '<circle cx="12" cy="12" r="6.5" fill="currentColor" stroke="none"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/>',
    cloud: '<path d="M7 18.5a4.5 4.5 0 0 1-.7-8.95A6 6 0 0 1 17.8 8.6a4.5 4.5 0 0 1 .2 9.9z"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
    flag: '<path d="M5 21V4m0 0h11.5l-2 4.2 2 4.3H5"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    pen: '<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/>',
    cap: '<path d="m2 9 10-5 10 5-10 5zM6 11v5c3 2.5 9 2.5 12 0v-5M22 9v6"/>',
    alert: '<path d="M12 3.5 2.5 20h19zM12 10v4.5M12 17.4v.1"/>',
    bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
    trend: '<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>',
    lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
    target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
    shield: '<path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z"/><path d="m9 12 2 2 4-4"/>',
    ban: '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
    lips: '<path d="M3 12c2.5-3.2 5.2-4.5 7-3.6.8.4 1.2.4 2 0 1.8-.9 4.5.4 7 3.6-2.6 3.6-5.6 5.2-9 5.2S5.6 15.6 3 12Zm2.6 0c2 1.1 4.2 1.6 6.4 1.6s4.4-.5 6.4-1.6"/>',
    micoff: '<path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 10V5a3 3 0 0 0-5.9-.7M5 11a7 7 0 0 0 11.5 5.3M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
    play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    upload: '<path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16"/>',
    face: '<circle cx="12" cy="12" r="8.5"/><path d="M9 10h.01M15 10h.01M8.5 14.5c2 1.8 5 1.8 7 0"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4"/>',
    ruler: '<path d="M3 16 16 3l5 5L8 21zM7 12l2 2M10 9l2 2M13 6l2 2"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 7.6v.1"/>',
    speaker: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  };
  LR.icon = function (name, size) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size || 18));
    svg.setAttribute("height", String(size || 18));
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "ico");
    svg.innerHTML = ICONS[name] || ICONS.info; // 常數字串，見上方說明
    return svg;
  };
  /** 把頁面上 <span data-icon="camera"></span> 換成 SVG 圖示 */
  LR.hydrateIcons = function (root) {
    (root || document).querySelectorAll("[data-icon]:not([data-icon-done])").forEach((n) => {
      n.prepend(LR.icon(n.dataset.icon, Number(n.dataset.iconSize) || undefined));
      n.setAttribute("data-icon-done", "");
    });
  };

  LR.toast = function (msg, kind = "info", ms = 4500) {
    let box = document.getElementById("toasts");
    if (!box) {
      box = LR.el("div", { id: "toasts", class: "toasts", "aria-live": "polite" });
      document.body.append(box);
    }
    const icon = { good: "check", bad: "alert", warn: "alert", info: "info" }[kind] || "info";
    const t = LR.el("div", { class: `toast ${kind}` }, LR.el("span", { class: "toast-icon", "aria-hidden": "true" }, LR.icon(icon, 14)), LR.el("span", { text: msg }));
    box.append(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 250); }, ms);
  };

  /**
   * 網站風格的確認視窗（取代瀏覽器內建的 confirm／prompt：樣式一致，App 內建瀏覽器也不會被略過）。
   * 回傳 Promise<boolean>。typeToConfirm：要使用者照打一次這段文字才能按確定。
   * recommendCancel：建議的做法是「取消」那一邊時（例如「先調整」），把它做成主按鈕、預設焦點也放在它上面。
   */
  LR.confirm = function ({ title, body, ok = "確定", cancel = "取消", danger = false, typeToConfirm = "", recommendCancel = false } = {}) {
    const E = LR.el;
    return new Promise((resolve) => {
      const lines = Array.isArray(body) ? body : String(body || "").split("\n");
      const okBtn = E("button", { class: "btn " + (danger ? "danger-solid" : recommendCancel ? "" : "primary"), type: "submit", value: "ok", text: ok });
      const cancelBtn = E("button", { class: "btn " + (recommendCancel ? "primary" : "ghost"), type: "submit", value: "cancel", text: cancel });
      const input = typeToConfirm ? E("input", { class: "input", autocomplete: "off", spellcheck: "false", "aria-label": `請輸入「${typeToConfirm}」` }) : null;
      if (input) {
        okBtn.disabled = true;
        input.addEventListener("input", () => { okBtn.disabled = input.value.trim() !== typeToConfirm; });
      }
      const form = E("form", { class: "dialog-body", method: "dialog" },
        E("div", { class: "dialog-h confirm-h" },
          E("span", { class: "confirm-ico" + (danger ? " danger" : "") }, LR.icon(danger ? "trash" : "info", 20)),
          E("h2", { id: "lrConfirmTitle", text: title || "確定嗎？" })),
        E("div", { class: "confirm-body" }, lines.filter((l) => l !== "").map((l) => E("p", { text: l }))),
        input ? E("div", { class: "field", style: "margin-top:14px" }, E("label", { text: `請輸入「${typeToConfirm}」確認` }), input) : null,
        E("div", { class: "dialog-actions" }, E("span", { class: "spacer" }),
          ...(recommendCancel ? [okBtn, cancelBtn] : [cancelBtn, okBtn])));
      const dlg = E("dialog", { class: "dialog confirm", "aria-labelledby": "lrConfirmTitle" }, form);
      document.body.append(dlg);
      dlg.addEventListener("close", () => { resolve(dlg.returnValue === "ok"); dlg.remove(); });
      // 關閉時也有動畫：先讓視窗滑下去，再真的關掉（減少動態時立刻關）
      let closing = false;
      const shut = (value) => {
        if (closing) return;
        closing = true;
        LR.animateOut(dlg, "closing", 200).then(() => dlg.close(value));
      };
      form.addEventListener("submit", (e) => {
        if (!e.submitter) return; // 很舊的瀏覽器拿不到按了哪個鍵：照原生行為直接關
        e.preventDefault();
        shut(e.submitter.value === "ok" ? "ok" : "cancel");
      });
      dlg.addEventListener("cancel", (e) => { e.preventDefault(); shut("cancel"); });
      dlg.showModal();
      (input || (recommendCancel ? cancelBtn : okBtn)).focus();
    });
  };

  /** LINE、Facebook、Instagram 等 App 內建瀏覽器（常常開不了鏡頭） */
  LR.inAppBrowser = function () {
    const ua = navigator.userAgent || "";
    if (/\bLine\//i.test(ua)) return "LINE";
    if (/FBAN|FBAV|FB_IAB/i.test(ua)) return "Facebook";
    if (/Instagram/i.test(ua)) return "Instagram";
    if (/MicroMessenger/i.test(ua)) return "微信";
    return "";
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

  /** 即時檢查鏡頭畫面：臉在不在框內、距離、是否正對、光線。回傳 { ok, checks, res }。 */
  let lumCanvas = null;
  LR.checkFrame = function (video) {
    if (!landmarker || !video.videoWidth) return null;
    const res = landmarker.detect(video);
    const checks = { face: false, center: null, size: null, front: null, light: null };
    let nose = null, faceW = 0;
    // 亮度：縮小成 32×24 取平均
    lumCanvas = lumCanvas || Object.assign(document.createElement("canvas"), { width: 32, height: 24 });
    const g = lumCanvas.getContext("2d", { willReadFrequently: true });
    g.drawImage(video, 0, 0, 32, 24);
    const px = g.getImageData(0, 0, 32, 24).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const lum = sum / (px.length / 4);
    checks.light = lum < 55 ? "dark" : lum > 225 ? "bright" : "ok";
    if (res && res.faceLandmarks && res.faceLandmarks.length) {
      const lm = res.faceLandmarks[0];
      checks.face = true;
      nose = lm[1];
      checks.center = nose.x > 0.3 && nose.x < 0.7 && nose.y > 0.28 && nose.y < 0.75 ? "ok" : "off";
      faceW = Math.abs(lm[454].x - lm[234].x);
      checks.size = faceW < 0.28 ? "far" : faceW > 0.78 ? "near" : "ok";
      const W = video.videoWidth, H = video.videoHeight;
      const d = (a, b) => Math.hypot((a.x - b.x) * W, (a.y - b.y) * H);
      const ratio = d(nose, lm[33]) / (d(nose, lm[263]) || 1e-6);
      checks.front = ratio > 0.62 && ratio < 1.6 ? "ok" : "turned";
    }
    const ok = checks.face && checks.center === "ok" && checks.size === "ok" && checks.front === "ok" && checks.light === "ok";
    return { ok, checks, lum, nose: nose ? { x: nose.x, y: nose.y } : null, faceW, box: checks.face ? mouthBox(res, video.videoWidth, video.videoHeight) : null, lipPts: checks.face ? lipPoints(res) : null };
  };

  // 嘴唇節點在畫面上的位置（0–1 的相對座標，未鏡像）：外圈 20 點接著內圈 20 點。給錄影頁即時畫在鏡頭上用
  function lipPoints(res) {
    const lm = res.faceLandmarks[0], out = [];
    for (const i of LIP_OUTER.concat(LIP_INNER)) out.push(lm[i].x, lm[i].y);
    return out;
  }

  // 嘴唇外圈的範圍（像素），用來裁出「只有嘴巴」的畫面
  function mouthBox(res, W, H) {
    const lm = res.faceLandmarks[0];
    let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
    for (const i of LIP_OUTER) { const p = lm[i]; x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    return { cx: (x0 + x1) / 2 * W, cy: (y0 + y1) / 2 * H, w: (x1 - x0) * W, h: (y1 - y0) * H };
  }

  /** 錄影當下逐格分析：回傳這一格的特徵、嘴唇輪廓、嘴巴位置；抓不到臉時 feature 為 null。 */
  LR.analyzeFrame = function (video) {
    if (!landmarker || !video.videoWidth) return null;
    const W = video.videoWidth, H = video.videoHeight;
    const res = landmarker.detect(video);
    const feature = frameFeature(res, W, H);
    if (!feature) return { feature: null };
    return { feature, lips: lipShape(res, W, H), box: mouthBox(res, W, H), lipPts: lipPoints(res) };
  };

  /** 把錄影時收集的逐格結果整理成跟 LR.extract 一樣的格式（重新取樣成每秒 25 格）。 */
  LR.fromLiveSamples = function (samples) {
    if (!samples.length) throw new Error("沒有錄到畫面");
    const last = samples[samples.length - 1].t;
    const raw = [], lips = [];
    let n = 0, miss = 0, j = 0;
    for (let t = 20; t <= last; t += 1000 / FPS) {
      while (j + 1 < samples.length && samples[j + 1].t <= t) j++;
      n++;
      const s = samples[j];
      if (s && s.feature) { raw.push(s.feature); lips.push(s.lips); } else miss++;
    }
    const quality = { frames: n, missed: miss, duration: Math.round(last / 10) / 100, source: "live" };
    if (raw.length < 5 || miss > n * 0.5) throw new Error(`有 ${miss}/${n} 格抓不到臉，請把臉放進框裡重錄`);
    return { frames: preprocess(raw), lips, quality };
  };

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
      const quality = { frames: n, missed: miss, duration: Math.round(dur * 100) / 100, width: W, height: H, source: "file" };
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
      consent: o.consent && typeof o.consent === "object" && Number.isFinite(Date.parse(o.consent.at))
        ? { version: LR.cleanText(o.consent.version, 20), at: o.consent.at } : null,
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
      quality: { frames: quality.frames, missed: quality.missed, duration: quality.duration, source: quality.source || "" },
      createdAt: new Date().toISOString(),
      createdBy: author || "",
      consent: LR.policy.accepted() ? { version: LR.policy.version, at: LR.policy.accepted().at } : null,
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
        // 只有使用者刻意改過（customUpload）才用存下的網址；否則一律用 config.js，網站換網址時大家會自動跟上
        uploadUrl: s.customUpload && s.uploadUrl ? s.uploadUrl : (CFG.uploadUrl || ""),
        customUpload: !!(s.customUpload && s.uploadUrl && s.uploadUrl !== CFG.uploadUrl),
      };
    },
    token() { return store.get("sessionStorage", TKEY) || store.get("localStorage", TKEY) || ""; },
    remembered() { return !!store.get("localStorage", TKEY); },
    save(s, token, remember) {
      const custom = !!(s.uploadUrl && s.uploadUrl !== CFG.uploadUrl);
      store.set("localStorage", SKEY, JSON.stringify({ owner: s.owner, repo: s.repo, branch: s.branch, login: s.login || "", uploadUrl: custom ? s.uploadUrl : "", customUpload: custom }));
      store.del("sessionStorage", TKEY);
      store.del("localStorage", TKEY);
      if (token) store.set(remember ? "localStorage" : "sessionStorage", TKEY, token);
    },
    disconnect() {
      store.del("sessionStorage", TKEY);
      store.del("localStorage", TKEY);
      LR.blobStore.clear();
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
  // 團隊通關碼模式：不需要 GitHub 帳號，由後端服務代為存取 GitHub
  const TEAM_KEY = "lr-team", ADMIN_KEY = "lr-admin";
  LR.team = {
    get() {
      for (const area of ["sessionStorage", "localStorage"]) {
        try { const o = JSON.parse(store.get(area, TEAM_KEY) || "null"); if (o && o.code) return { code: String(o.code), name: LR.cleanText(o.name, 30) }; } catch { /* 忽略壞掉的資料 */ }
      }
      return null;
    },
    remembered() { return !!store.get("localStorage", TEAM_KEY); },
    save(code, name, remember) {
      this.clear();
      store.set(remember ? "localStorage" : "sessionStorage", TEAM_KEY, JSON.stringify({ code, name }));
    },
    /** 清掉通關碼、管理員密碼與通行證（通行證會順便通知後端作廢） */
    clear() {
      const s = LR.session.get();
      if (s) LR.drive.raw({ action: "logout", session: s.t }, {}).catch(() => {});
      LR.session.clear();
      LR.blobStore.clear();
      store.del("localStorage", TEAM_KEY); store.del("sessionStorage", TEAM_KEY); store.del("sessionStorage", ADMIN_KEY);
    },
    adminCode() { return store.get("sessionStorage", ADMIN_KEY) || ""; },
    setAdmin(code) { if (code) store.set("sessionStorage", ADMIN_KEY, code); else store.del("sessionStorage", ADMIN_KEY); },
  };

  // ── 後端發的「通行證」（開了 Turnstile 時使用）：登入一次，之後每個請求只帶通行證、不帶通關碼 ──
  const SESSION_KEY = "lr-session";
  const SESSION_RE = /^[0-9a-f]{64}$/;
  LR.session = {
    get() {
      for (const area of ["sessionStorage", "localStorage"]) {
        try {
          const o = JSON.parse(store.get(area, SESSION_KEY) || "null");
          if (o && SESSION_RE.test(o.t || "") && Number(o.exp) > Date.now()) return { t: o.t, role: o.role === "admin" ? "admin" : "team", exp: Number(o.exp) };
        } catch { /* 忽略壞掉的資料 */ }
      }
      return null;
    },
    /** persist：記住通關碼時存 localStorage；管理員通行證一律只存在這個分頁 */
    save(j, persist) {
      this.clear();
      if (!j || !SESSION_RE.test(j.session || "")) throw new Error("後端回傳的通行證格式不正確");
      const ttl = Math.min(Math.max(Number(j.expiresIn) || 0, 0), 6 * 3600);
      const rec = { t: j.session, role: j.role === "admin" ? "admin" : "team", exp: Date.now() + Math.max(ttl - 120, 0) * 1000 };
      store.set(persist && rec.role !== "admin" ? "localStorage" : "sessionStorage", SESSION_KEY, JSON.stringify(rec));
    },
    clear() { store.del("localStorage", SESSION_KEY); store.del("sessionStorage", SESSION_KEY); },
  };

  // ── Cloudflare Turnstile 人機驗證（config.js 的 turnstileSiteKey 有填才啟用） ──
  const TS_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  const TS_KEY_RE = /^[0-9]x[0-9A-Za-z_-]{10,80}$/;
  let tsLoading = null;
  function loadTurnstile() {
    if (window.turnstile && window.turnstile.render) return Promise.resolve(window.turnstile);
    if (!tsLoading) {
      tsLoading = new Promise((resolve, reject) => {
        // Cloudflare 規定直接載入官方網址（不能自行代管或固定版本），所以這裡無法加 SRI
        const s = document.createElement("script");
        s.src = TS_SRC;
        s.async = true;
        s.onload = () => (window.turnstile && window.turnstile.render ? resolve(window.turnstile) : reject(new Error("人機驗證載入失敗")));
        s.onerror = () => reject(new Error("載入人機驗證失敗：請檢查網路，或暫時關閉擋廣告的外掛"));
        document.head.append(s);
      }).catch((err) => { tsLoading = null; throw err; });
    }
    return tsLoading;
  }
  LR.turnstile = {
    enabled: () => TS_KEY_RE.test(CFG.turnstileSiteKey || ""),
    /**
     * 取得一次性的驗證碼。大多數人不會看到任何東西；Cloudflare 覺得可疑時才會在 host 裡出現勾選框。
     * host 沒給時，放在目前開著的視窗（dialog）或畫面右下角。
     */
    async token(host) {
      const ts = await loadTurnstile();
      const own = !host;
      const box = host || LR.el("div", { class: "ts-float", role: "region", "aria-label": "人機驗證" });
      if (own) (document.querySelector("dialog[open]") || document.body).append(box);
      box.hidden = false;
      return new Promise((resolve, reject) => {
        let id = null, finished = false;
        const done = (fn, v) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          try { if (id != null) ts.remove(id); } catch { /* 已移除 */ }
          if (own) box.remove(); else { box.replaceChildren(); box.hidden = true; }
          fn(v);
        };
        const timer = setTimeout(() => done(reject, new Error("人機驗證逾時，請再試一次")), 120000);
        try {
          id = ts.render(box, {
            sitekey: CFG.turnstileSiteKey,
            action: "login",
            appearance: "interaction-only",
            language: "zh-tw",
            callback: (t) => done(resolve, String(t || "")),
            "error-callback": () => { done(reject, new Error("人機驗證失敗，請重新整理頁面再試")); return true; },
            "expired-callback": () => done(reject, new Error("人機驗證過期，請再試一次")),
            "timeout-callback": () => done(reject, new Error("人機驗證逾時，請再試一次")),
          });
        } catch (err) {
          done(reject, new Error("人機驗證無法啟動：" + ((err && err.message) || err)));
        }
      });
    },
  };
  /** "github"：用自己的 token；"team"：用通關碼；null：未連線 */
  LR.mode = () => {
    if (LR.settings.token() && LR.settings.valid(LR.settings.get())) return "github";
    if (LR.team.get() && LR.drive.url()) return "team";
    return null;
  };
  LR.whoami = () => (LR.mode() === "github" ? LR.settings.get().login : (LR.team.get() || {}).name || "訪客");

  LR.drive = {
    url() { const u = LR.settings.get().uploadUrl; return UPLOAD_URL_RE.test(u || "") ? u : ""; },
    enabled() { return !!this.url() && LR.gh.connected(); },
    authFor(action) {
      if (LR.mode() === "github") return { token: LR.settings.token() };
      const t = LR.team.get() || {};
      const a = { code: t.code, name: t.name };
      if (["deleteSample", "trash", "journalDelete", "scheduleOp"].includes(action) && LR.team.adminCode()) a.adminCode = LR.team.adminCode();
      return a;
    },
    /** 一般呼叫：開了 Turnstile 的團隊模式改用通行證，過期時自動重新登入一次 */
    async call(payload, auth) {
      if (!auth && LR.mode() === "team" && LR.turnstile.enabled()) return this.callWithSession(payload, false);
      return this.raw(payload, auth || this.authFor(payload.action));
    },
    async callWithSession(payload, retried) {
      const s = await this.ensureSession();
      try {
        return await this.raw(payload, { session: s.t });
      } catch (err) {
        if (!retried && (err.code === "SESSION_EXPIRED" || err.code === "LOGIN_REQUIRED")) {
          // 只清掉「失敗的那一張」：同時有別的請求已經重新登入時，不要把新的通行證也清掉
          const cur = LR.session.get();
          if (cur && cur.t === s.t) LR.session.clear();
          return this.callWithSession(payload, true);
        }
        throw err;
      }
    },
    /** 有效的通行證；沒有就用記住的通關碼重新登入（同時多個請求只登入一次） */
    ensureSession() {
      const s = LR.session.get();
      if (s) return Promise.resolve(s);
      if (!this._pending) {
        const t = LR.team.get();
        if (!t) return Promise.reject(Object.assign(new Error("請先在網頁右上角輸入團隊通關碼"), { status: 401 }));
        const admin = LR.team.adminCode();
        this._pending = this.login({ code: t.code, name: t.name, adminCode: admin })
          .then((j) => { LR.session.save(j, LR.team.remembered()); return LR.session.get(); })
          .finally(() => { this._pending = null; });
      }
      return this._pending;
    },
    /** 登入：先通過人機驗證，再用通關碼（和選填的管理員密碼）換通行證。host：放驗證框的位置 */
    async login(cred, host) {
      const turnstile = await LR.turnstile.token(host);
      const body = { action: "login", code: cred.code, name: cred.name || "", turnstile };
      if (cred.adminCode) body.adminCode = cred.adminCode;
      return this.raw(body, {});
    },
    /** 直接送出（不處理通行證） */
    async raw(payload, auth) {
      const url = this.url();
      if (!url) throw new Error("尚未設定後端服務網址");
      let res;
      try {
        // 不加自訂 header（text/plain），避免 CORS 預檢；host 固定為 script.google.com
        res = await fetch(url, { method: "POST", body: JSON.stringify(Object.assign({}, auth || {}, payload)), redirect: "follow" });
      } catch {
        throw new Error("連不到後端服務，請檢查網路");
      }
      let j;
      try { j = await res.json(); } catch { throw new Error("後端服務回應格式錯誤（確認 Apps Script 有部署成「網頁應用程式」、存取權為「所有人」）"); }
      if (!j || !j.ok) {
        const err = new Error(LR.cleanText(j && j.error, 200) || "後端服務發生錯誤");
        if (j && /^[A-Z_]{1,40}$/.test(j.code || "")) err.code = j.code;
        if (/通關碼錯誤|管理員密碼錯誤|請先在網頁右上角|登入已過期|請重新登入/.test(err.message)) err.status = 401;
        throw err;
      }
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

  // ── 樣本／日誌內容的快取（依 GitHub blob 的 sha） ──
  // sha 是內容的雜湊：同一個 sha 的內容永遠一樣，所以快取不會讀到舊資料。
  // 存在 IndexedDB：換分頁、關掉再開都還在，第二次打開只要抓新的樣本。
  // 登出時整個清掉；每次讀清單時，已經不在清單裡的（被刪除的樣本）也一起清掉。
  // IndexedDB 不能用（私密瀏覽、被封鎖）時只放記憶體，跟關掉分頁就沒了的舊行為一樣。
  const blobCache = new Map();
  const IDB_NAME = "lr-cache", IDB_STORE = "blobs";
  let idbOpen = null;
  function idb() {
    if (!idbOpen) {
      idbOpen = new Promise((resolve) => {
        try {
          const req = indexedDB.open(IDB_NAME, 1);
          req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          req.onblocked = () => resolve(null);
        } catch { resolve(null); }
      });
    }
    return idbOpen;
  }
  /** 開一個交易做事；任何錯誤都當作「沒有快取」，不影響正常讀取 */
  async function idbRun(mode, fn) {
    const db = await idb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, mode);
        const out = fn(tx.objectStore(IDB_STORE));
        tx.oncomplete = () => resolve(out);
        tx.onerror = tx.onabort = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  // 舊版放在 sessionStorage 的快取（樣本多時會塞爆）：清掉
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) { const k = sessionStorage.key(i); if (k && k.startsWith("lr-blob:")) sessionStorage.removeItem(k); }
  } catch { /* 封鎖儲存時忽略 */ }

  LR.blobStore = {
    /** 把 IndexedDB 裡有的先搬進記憶體。kind："s" 樣本、"j" 日誌 */
    async warm(kind, shas) {
      const want = shas.filter((sha) => !blobCache.has(sha));
      if (!want.length) return;
      const got = await idbRun("readonly", (st) => {
        const res = new Map();
        for (const sha of want) {
          const r = st.get(kind + ":" + sha);
          r.onsuccess = () => { if (typeof r.result === "string") res.set(sha, r.result); };
        }
        return res;
      });
      if (!got) return;
      for (const [sha, text] of got) {
        try { if (text.length <= MAX_SAMPLE_BYTES) blobCache.set(sha, JSON.parse(text)); } catch { /* 壞掉的快取當作沒有 */ }
      }
    },
    put(kind, sha, text) { idbRun("readwrite", (st) => { st.put(text, kind + ":" + sha); }); },
    /** 清掉已經不在清單裡的（例如被刪除的樣本） */
    async prune(kind, keep) {
      await idbRun("readwrite", (st) => {
        const r = st.getAllKeys();
        r.onsuccess = () => {
          for (const k of r.result || []) {
            if (typeof k === "string" && k.startsWith(kind + ":") && !keep.has(k.slice(kind.length + 1))) st.delete(k);
          }
        };
      });
    },
    /** 登出時呼叫：記憶體和 IndexedDB 都清空 */
    clear() {
      blobCache.clear();
      return idbRun("readwrite", (st) => { st.clear(); });
    },
  };

  function cachedBlob(sha) {
    return blobCache.has(sha) ? blobCache.get(sha) : null;
  }
  function putBlob(sha, text, kind) {
    if (text.length > MAX_SAMPLE_BYTES) throw new Error("樣本檔太大");
    const o = JSON.parse(text);
    blobCache.set(sha, o);
    LR.blobStore.put(kind || "s", sha, text);
    return o;
  }
  /** 讀清單後：先從 IndexedDB 補進記憶體，清單完整時順便清掉已刪除的 */
  async function syncCache(kind, entries, truncated) {
    const shas = entries.map((e) => e.sha);
    await LR.blobStore.warm(kind, shas);
    if (!truncated) LR.blobStore.prune(kind, new Set(shas));
  }

  // 通關碼模式：經後端服務讀寫
  const viaTeam = {
    async loadSamples(onProgress) {
      const l = await LR.drive.call({ action: "list" });
      const entries = (l.entries || []).filter((e) => SAMPLE_PATH_RE.test(e.path || "") && /^[0-9a-f]{40}$/.test(e.sha || ""));
      await syncCache("s", entries, !!l.truncated);
      const need = entries.filter((e) => !cachedBlob(e.sha)).map((e) => e.sha);
      let done = entries.length - need.length;
      if (onProgress) onProgress(done, entries.length);
      const chunks = [];
      for (let i = 0; i < need.length; i += 25) chunks.push(need.slice(i, i + 25));
      const worker = async () => {
        while (chunks.length) {
          const shas = chunks.shift();
          const r = await LR.drive.call({ action: "blobs", shas });
          for (const sha of shas) {
            const b64 = r.blobs && r.blobs[sha];
            if (b64) { try { putBlob(sha, b64decodeUtf8(b64), "s"); } catch { /* 壞檔略過 */ } }
          }
          done += shas.length;
          if (onProgress) onProgress(done, entries.length);
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, worker));
      const out = [];
      let bad = 0;
      for (const e of entries) {
        const s = LR.validateSample(cachedBlob(e.sha));
        if (s) out.push(Object.assign(s, { _path: e.path, _sha: e.sha })); else bad++;
      }
      out.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
      return { samples: out, bad, truncated: !!l.truncated };
    },
    async putSample(sample) {
      const r = await LR.drive.call({ action: "saveSample", sample });
      return Object.assign(sample, {
        _path: r.path, _sha: r.sha,
        createdBy: LR.cleanText(r.createdBy, 60) || sample.createdBy,
        createdAt: r.createdAt || sample.createdAt,
      });
    },
    async deleteSample(sample) {
      return LR.drive.call({ action: "deleteSample", path: sample._path, sha: sample._sha, driveId: sample.video && sample.video.driveId });
    },
  };

  // 日程、日誌、活動紀錄：兩種登入方式都經後端服務讀寫（後端用自己的 token 寫入）
  LR.api = {
    ready() { return !!LR.mode() && !!LR.drive.url(); },
    async loadJournal() {
      const l = await LR.drive.call({ action: "list", kind: "journal" });
      const entries = (l.entries || []).filter((e) => /^data\/journal\/[A-Za-z0-9_-]{1,80}\.json$/.test(e.path || "") && /^[0-9a-f]{40}$/.test(e.sha || ""));
      await syncCache("j", entries, !!l.truncated);
      const need = entries.filter((e) => !cachedBlob(e.sha)).map((e) => e.sha);
      for (let i = 0; i < need.length; i += 25) {
        const shas = need.slice(i, i + 25);
        const r = await LR.drive.call({ action: "blobs", shas });
        for (const sha of shas) if (r.blobs && r.blobs[sha]) { try { putBlob(sha, b64decodeUtf8(r.blobs[sha]), "j"); } catch { /* 壞檔略過 */ } }
      }
      return entries.map((e) => {
        const o = cachedBlob(e.sha);
        if (!o || typeof o !== "object") return null;
        return {
          id: LR.cleanText(o.id, 80), type: LR.cleanText(o.type, 10), date: /^\d{4}-\d{2}-\d{2}$/.test(o.date || "") ? o.date : "",
          title: LR.cleanText(o.title, 80), body: String(o.body || "").slice(0, 5000), author: LR.cleanText(o.author, 40),
          createdAt: typeof o.createdAt === "string" ? o.createdAt : "", _path: e.path, _sha: e.sha,
        };
      }).filter((x) => x && x.title);
    },
    addJournal(entry) { return LR.drive.call({ action: "journalAdd", entry }); },
    deleteJournal(e) { return LR.drive.call({ action: "journalDelete", path: e._path, sha: e._sha }); },
    async commits(page) { return (await LR.drive.call({ action: "commits", page: page || 1 })).commits || []; },
    async schedule() { return (await LR.drive.call({ action: "schedule" })).schedule; },
    async scheduleOp(op) { return (await LR.drive.call({ action: "scheduleOp", op })).schedule; },
  };

  LR.gh = {
    connected() { return !!LR.mode(); },
    canDelete() { const m = LR.mode(); return m === "github" || (m === "team" && !!LR.team.adminCode()); },

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
      const hit = cachedBlob(sha);
      if (hit) return hit;
      const b = await this.request(`git/blobs/${sha}`);
      return putBlob(sha, b64decodeUtf8(b.content || ""), "s");
    },

    /** 讀出全部樣本。 */
    async loadSamples(onProgress) {
      if (LR.mode() === "team") return viaTeam.loadSamples(onProgress);
      const { entries, truncated } = await this.listEntries();
      await syncCache("s", entries, truncated);
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
      if (LR.mode() === "team") return viaTeam.putSample(sample);
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
      if (LR.mode() === "team") return viaTeam.deleteSample(sample);
      const s = LR.settings.get();
      if (!SAMPLE_PATH_RE.test(sample._path || "") || !/^[0-9a-f]{40}$/.test(sample._sha || "")) throw new Error("這筆樣本不在 GitHub 上");
      await this.request(`contents/${sample._path}`, {
        method: "DELETE",
        body: { message: `刪除樣本：${sample.label}（${sample.speaker || "未填錄製者"}）`, sha: sample._sha, branch: s.branch },
      });
    },
  };

  // ───────────────────────── 頂部導覽列與連線設定 ─────────────────────────
  LR.mountHeader = function (active, opts) {
    const bar = document.getElementById("appbar");
    const chip = LR.el("button", { class: "conn", type: "button" });
    const renderChip = () => {
      const s = LR.settings.get(), mode = LR.mode();
      chip.classList.toggle("on", !!mode);
      const text = mode === "github" ? `${s.owner}/${s.repo}`
        : mode === "team" ? `${LR.team.adminCode() ? "管理員" : "團隊"}・${LR.whoami()}`
        : "輸入通關碼";
      chip.replaceChildren(LR.el("span", { class: "conn-dot", "aria-hidden": "true" }), LR.el("span", { class: "conn-text", text }));
      chip.title = mode ? "已連線，點擊修改設定" : "點擊輸入團隊通關碼";
      if (s.customUpload) {
        chip.append(LR.el("span", { class: "conn-warn", text: "自訂後端" }));
        chip.title = "注意：正在使用自訂的後端服務網址，不是網站預設的。點擊可以改回來。";
      }
    };
    const link = (href, key, text) => LR.el("a", { href, class: active === key ? "active" : null, "aria-current": active === key ? "page" : null, text });
    bar.append(
      LR.el("div", { class: "appbar-inner" },
        LR.el("a", { class: "brand", href: "index.html" },
          LR.el("span", { class: "brand-mark", "aria-hidden": "true" }, mouthIcon()),
          LR.el("span", { class: "brand-text" }, LR.el("strong", { text: LR.BRAND }), LR.el("small", { text: LR.BRAND_SUB }))
        ),
        LR.el("nav", { class: "nav", "aria-label": "頁面" },
          link("index.html", "input", "錄影"), link("report.html", "report", "報告"),
          link("schedule.html", "schedule", "日程"), link("log.html", "log", "日誌"), link("architecture.html", "arch", "架構")),
        chip
      )
    );
    renderChip();
    LR.hydrateIcons();
    // 卡片依序淡入（減少動態效果的設定會關掉）
    if (!LR.reducedMotion()) document.querySelectorAll("main .card, main .kpi, main .page-head").forEach((n, i) => { n.style.setProperty("--enter", i); n.classList.add("enter"); });
    LR.events.addEventListener("connection", renderChip);

    const dlg = buildSettingsDialog();
    document.body.append(dlg);
    chip.addEventListener("click", () => LR.openSettings());
    // 沒登入就鎖住整個頁面，只留登入視窗（真正的資料保護在後端：沒有通關碼讀不到任何資料）
    const consentDlg = buildConsentDialog();
    document.body.append(consentDlg);
    document.body.append(LR.el("footer", { class: "site-foot" },
      LR.el("a", { href: "privacy.html", text: "隱私權與使用規範" }),
      LR.el("span", { text: `・資料保存到專題總截止日後 ${LR.policy.retentionYears} 年` })));

    // 隱私權頁面不用登入就能看
    if (opts && opts.public) {
      document.documentElement.classList.remove("prelock");
      return;
    }
    // 沒登入就鎖住整個頁面，只留登入視窗；登入後還沒同意目前版本的政策，也要先同意
    // （真正的資料保護在後端：沒有通關碼讀不到任何資料）
    const applyLock = () => {
      const loggedIn = !!LR.mode();
      const consented = !!LR.policy.accepted();
      const locked = !loggedIn || !consented;
      document.body.classList.toggle("locked", locked);
      document.documentElement.classList.remove("prelock");
      if (!loggedIn) { if (consentDlg.open) consentDlg.close(); if (!dlg.open) LR.openSettings(); }
      else if (!consented && !consentDlg.open) { if (dlg.open) dlg.close(); LR.openConsent(); }
    };
    applyLock();
    LR.events.addEventListener("connection", applyLock);
    LR.events.addEventListener("consent", applyLock);
  };

  // ───────────────────────── 隱私權政策與知情同意 ─────────────────────────
  const CONSENT_KEY = "lr-consent";
  LR.policy = {
    version: LR.cleanText(CFG.privacyVersion, 20) || "1",
    retentionYears: Math.max(0, Math.min(10, Number(CFG.retentionYears) || 1)),
    // 只接受 Google 表單網址（host 白名單），避免設定檔被改成奇怪的連結
    contactFormUrl: /^https:\/\/(forms\.gle\/[A-Za-z0-9]{6,40}|docs\.google\.com\/forms\/d\/e\/[A-Za-z0-9_-]{20,120}\/viewform(\?usp=[A-Za-z_]{1,30})?)$/.test(CFG.contactFormUrl || "") ? CFG.contactFormUrl : "",
    accepted() {
      try {
        const c = JSON.parse(store.get("localStorage", CONSENT_KEY) || "null");
        // 同意紀錄要是「現在登入的這個人」的，共用裝置換人時要重新同意
        return c && c.version === this.version && c.who === LR.whoami() ? c : null;
      } catch { return null; }
    },
    accept() {
      const c = { version: this.version, at: new Date().toISOString(), who: LR.whoami() };
      store.set("localStorage", CONSENT_KEY, JSON.stringify(c));
      LR.events.dispatchEvent(new Event("consent"));
      return c;
    },
    withdraw() {
      store.del("localStorage", CONSENT_KEY);
      LR.events.dispatchEvent(new Event("consent"));
    },
  };

  function buildConsentDialog() {
    const E = LR.el;
    const c1 = E("input", { type: "checkbox", id: "consentRead" });
    const c2 = E("input", { type: "checkbox", id: "consentPeople" });
    const ok = E("button", { class: "btn primary", type: "submit", text: "同意並開始使用", disabled: true });
    const no = E("button", { class: "btn ghost", type: "button", text: "不同意（登出）" });
    const sync = () => { ok.disabled = !(c1.checked && c2.checked); };
    c1.addEventListener("change", sync);
    c2.addEventListener("change", sync);
    const P = LR.policy;
    const form = E("form", { class: "dialog-body", method: "dialog" },
      E("div", { class: "dialog-h confirm-h" },
        E("span", { class: "confirm-ico" }, LR.icon("shield", 20)),
        E("div", null,
          E("h2", { id: "consentTitle", text: "開始前，請確認這四件事" }),
          E("p", { class: "help", text: `隱私權政策 ${P.version} 版` }))),
      E("ul", { class: "consent-points" },
        E("li", null, E("strong", { text: "用途：" }), "只用於本專題（辨識訓練與測試、專題報告與展示），報告只用統計數字與嘴型動畫，不公開影片。"),
        E("li", null, E("strong", { text: "存放：" }), "口型數據在 GitHub 私有 repo、影片在專題負責人的雲端硬碟，只有專題成員看得到。"),
        E("li", null, E("strong", { text: "期限：" }), `保存到專題總截止日後 ${P.retentionYears} 年，期滿全部刪除。`),
        E("li", null, E("strong", { text: "權利：" }), "自願參與，可以隨時撤回同意、要求刪除自己的資料。未滿 18 歲需法定代理人同意。")),
      E("p", { class: "consent-links" },
        E("a", { href: "privacy.html", target: "_blank", rel: "noopener" }, "閱讀完整的隱私權與使用規範", LR.icon("external", 13)),
        P.contactFormUrl ? E("a", { href: P.contactFormUrl, target: "_blank", rel: "noopener noreferrer" }, "隱私權請求表單", LR.icon("external", 13)) : null),
      E("label", { class: "check consent-check" }, c1, E("span", { text: "我已閱讀並同意隱私權政策與使用規範" })),
      E("label", { class: "check consent-check" }, c2, E("span", { text: "我只會錄自己，或已經取得影片中的人同意" })),
      E("div", { class: "dialog-actions" }, no, E("span", { class: "spacer" }), ok));
    const dlg = E("dialog", { class: "dialog", "aria-labelledby": "consentTitle" }, form);
    LR.openConsent = () => { c1.checked = false; c2.checked = false; sync(); if (!dlg.open) dlg.showModal(); };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!(c1.checked && c2.checked)) return;
      P.accept();
      dlg.close();
      LR.toast("謝謝！可以開始使用了", "good");
    });
    no.addEventListener("click", () => {
      dlg.close();
      LR.settings.disconnect();
      LR.team.clear();
      store.del("localStorage", CONSENT_KEY); // 換人使用時要重新同意
      LR.events.dispatchEvent(new Event("connection"));
    });
    // 還沒同意前不能用 Esc 關掉（被瀏覽器強制關掉時再打開）
    dlg.addEventListener("cancel", (e) => { if (LR.mode() && !P.accepted()) e.preventDefault(); });
    dlg.addEventListener("close", () => { if (LR.mode() && !P.accepted()) setTimeout(() => { if (!dlg.open && LR.mode() && !P.accepted()) dlg.showModal(); }, 0); });
    return dlg;
  }

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
    const E = LR.el;
    // 欄位：錯誤訊息直接顯示在欄位下方，並標成 aria-invalid（螢幕閱讀器會一起唸）
    const field = (id, label, attrs, help) => {
      const err = E("p", { class: "field-err", id: id + "Err", role: "alert", hidden: true });
      return E("div", { class: "field" }, E("label", { for: id, text: label }),
        E("input", Object.assign({ id, class: "input", "aria-describedby": help ? id + "Help " + id + "Err" : id + "Err" }, attrs)),
        help ? E("p", { class: "help", id: id + "Help", text: help }) : null, err);
    };
    const status = E("p", { class: "dialog-status", role: "status" });
    const tsBox = E("div", { class: "ts-box", hidden: true });   // Turnstile 需要互動時，勾選框會出現在這裡
    const btnSave = E("button", { class: "btn primary lg", type: "submit" }, E("span", { class: "btn-label", text: "登入" }), LR.icon("arrow", 16));
    const btnOff = E("button", { class: "btn ghost danger", type: "button", text: "登出" });
    const btnCancel = E("button", { class: "btn ghost", type: "button", text: "取消" });

    // 第一次來的人：先知道這是什麼、為什麼要錄嘴巴，再輸入通關碼（U1）
    const welcome = E("aside", { class: "welcome" },
      E("div", { class: "welcome-mark", "aria-hidden": "true" }, talkingLips()),
      E("p", { class: "eyebrow brand-ink", text: LR.BRAND }),
      E("h2", { class: "welcome-title", text: "幫我們錄幾句「無聲的話」" }),
      E("p", { class: "welcome-lede", text: "這是大學專題「無聲溝通系統」：讓電腦從嘴型看懂沒有出聲的話。你只要對著鏡頭、不出聲地念幾個短句。" }),
      E("ul", { class: "welcome-points" },
        E("li", null, LR.icon("micoff", 18), E("span", null, E("strong", { text: "不錄聲音" }), "，預設只存嘴巴特寫")),
        E("li", null, LR.icon("clock", 18), E("span", null, E("strong", { text: "一句約 3 秒" }), "，跟著畫面提示念就好")),
        E("li", null, LR.icon("shield", 18), E("span", null, E("strong", { text: "隨時可以撤回" }), "，也能要求刪除自己的資料"))),
      E("a", { class: "welcome-link", href: "privacy.html" }, "先看隱私權政策", LR.icon("arrow", 14)));

    // 通關碼
    const rememberTeam = E("input", { type: "checkbox", id: "setTeamRemember" });
    const teamBox = E("div", null,
      field("setName", "你的名字或代號", { autocomplete: "nickname", maxlength: "30", placeholder: "例如：小明、A" }, "會記在上傳紀錄裡；錄影時也會預先帶入。"),
      field("setCode", "團隊通關碼", { type: "password", autocomplete: "off", spellcheck: "false", maxlength: "100", placeholder: "向專題負責人索取" }),
      E("label", { class: "check", style: "margin-top:12px" }, rememberTeam, E("span", { text: "記住通關碼（公用電腦請勿勾選）" }))
    );

    // 開發者（志願者用不到，收在「進階」裡）
    const rememberDev = E("input", { type: "checkbox", id: "setRemember" });
    const tokenLink = E("a", { href: "https://github.com/settings/personal-access-tokens/new", target: "_blank", rel: "noopener noreferrer", text: "建立 token" });
    const backToTeam = E("button", { class: "btn ghost sm", type: "button" }, "← 改用團隊通關碼");
    const devBox = E("div", null,
      E("div", { class: "dev-head" }, E("strong", { text: "開發者登入（GitHub token）" }), backToTeam),
      E("div", { class: "field-row" },
        field("setOwner", "帳號／組織", { autocomplete: "off", spellcheck: "false", maxlength: "100", placeholder: "GitHub 帳號或組織" }),
        field("setRepo", "資料 Repo", { autocomplete: "off", spellcheck: "false", maxlength: "100", placeholder: "存資料的 repo" })),
      field("setBranch", "分支", { autocomplete: "off", spellcheck: "false", maxlength: "100" }),
      E("div", { class: "field" },
        E("label", { for: "setToken" }, "Personal access token　", tokenLink),
        E("input", { id: "setToken", class: "input mono", type: "password", autocomplete: "off", spellcheck: "false", placeholder: "github_pat_…", "aria-describedby": "setTokenErr" }),
        E("p", { class: "help", text: "Fine-grained token：只勾資料 repo，Contents 設為 Read and write。已連線時留空表示沿用原本的 token。" }),
        E("p", { class: "field-err", id: "setTokenErr", role: "alert", hidden: true })),
      E("label", { class: "check" }, rememberDev, E("span", { text: "在這台電腦記住 token（公用電腦請勿勾選）" }))
    );

    const toDev = E("button", { class: "linkish", type: "button", text: "我是開發者，用 GitHub token 登入" });
    // 管理員密碼：大多數人用不到，跟開發者登入一起收在「進階設定」；已經是管理員時摘要旁會標出來
    const adminWrap = E("div", { class: "admin-field" },
      field("setAdmin", "管理員密碼（要刪除資料才需要）", { type: "password", autocomplete: "off", spellcheck: "false", maxlength: "100" }, "只記在這次開啟的分頁，關掉就要重新輸入；勾「記住」也一樣。"));
    const adminTag = E("span", { class: "adv-tag", text: "目前是管理員", hidden: true });
    const advBox = E("details", { class: "admin-box adv-box" },
      E("summary", null, "進階設定", adminTag),
      adminWrap,
      field("setUpload", "後端服務網址（Google Apps Script）", { class: "input mono", autocomplete: "off", spellcheck: "false", placeholder: "https://script.google.com/macros/s/…/exec" }, "通常不用改，網站已經預設好了。"),
      toDev);

    const title = E("h2", { id: "setTitle", text: "輸入通關碼開始" });
    const sub = E("p", { class: "help", text: "通關碼請向專題負責人索取，不需要註冊帳號。" });
    const form = E("form", { class: "dialog-body login-form", method: "dialog", novalidate: true },
      E("div", { class: "dialog-h" }, title, sub),
      teamBox, devBox, advBox, tsBox, status,
      E("div", { class: "dialog-actions" }, btnOff, E("span", { class: "spacer" }), btnCancel, btnSave));
    const dlg = E("dialog", { class: "dialog login", "aria-labelledby": "setTitle" }, E("div", { class: "login-grid" }, welcome, form));
    const $f = (id) => form.querySelector("#" + id);

    let tab = "team";
    // 開發者入口預設不出現（不在登入框秀出帳號與資料 repo）：網址帶 ?dev，或已經用 token 登入時才顯示
    let devEnabled = false;
    const setTab = (m) => {
      tab = m;
      teamBox.hidden = m !== "team";
      devBox.hidden = m !== "github";
      toDev.hidden = m === "github" || !devEnabled;
      adminWrap.hidden = m !== "team";
      if (m === "github") advBox.open = true;
      dlg.querySelector(".btn-label").textContent = m === "team" ? (LR.mode() ? "儲存" : "登入") : "連線並儲存";
      clearErrors();
    };
    toDev.addEventListener("click", () => { setTab("github"); $f("setOwner").focus(); });
    backToTeam.addEventListener("click", () => { setTab("team"); $f("setCode").focus(); });

    function clearErrors() {
      status.textContent = "";
      status.className = "dialog-status";
      form.querySelectorAll(".field-err").forEach((p) => { p.hidden = true; p.textContent = ""; });
      form.querySelectorAll("[aria-invalid]").forEach((i) => i.removeAttribute("aria-invalid"));
    }
    // 有對應欄位就把錯誤放在欄位下方並把游標移過去；沒有就顯示在按鈕上方（U7）
    const fail = (msg, fieldId) => {
      const input = fieldId && $f(fieldId);
      const err = fieldId && $f(fieldId + "Err");
      if (input && err) {
        if (input.closest("details")) input.closest("details").open = true;
        err.textContent = msg; err.hidden = false;
        input.setAttribute("aria-invalid", "true");
        input.focus();
        input.classList.remove("shake"); void input.offsetWidth; input.classList.add("shake");
        status.textContent = "";
      } else {
        status.textContent = msg; status.className = "dialog-status bad";
      }
    };
    const errField = (msg) =>
      /管理員密碼/.test(msg) ? "setAdmin" : /通關碼|嘗試太多次/.test(msg) ? "setCode" : /token/i.test(msg) ? "setToken" : /後端服務網址/.test(msg) ? "setUpload" : null;

    LR.openSettings = () => {
      const s = LR.settings.get(), t = LR.team.get();
      const first = !LR.mode();
      dlg.classList.toggle("first", first);
      welcome.hidden = !first;
      title.textContent = first ? "輸入通關碼開始" : "登入設定";
      sub.textContent = first ? "通關碼請向專題負責人索取，不需要註冊帳號。" : "可以改名字或登出；管理員密碼在「進階設定」裡。";
      devEnabled = LR.mode() === "github" || new URLSearchParams(location.search).has("dev");
      // 只有已經用 token 連線的人才帶入原本的帳號與 repo；新開的表單一律空白，由開發者自己輸入
      $f("setOwner").value = LR.mode() === "github" ? s.owner : "";
      $f("setRepo").value = LR.mode() === "github" ? s.repo : "";
      $f("setBranch").value = s.branch;
      $f("setToken").value = "";
      $f("setUpload").value = s.uploadUrl || "";
      $f("setName").value = t ? t.name : "";
      $f("setCode").value = "";
      $f("setCode").placeholder = t ? "已記住（留空沿用）" : "向專題負責人索取";
      $f("setAdmin").value = "";
      const isAdmin = LR.mode() === "team" && !!LR.team.adminCode();
      $f("setAdmin").placeholder = isAdmin ? "已是管理員（留空沿用）" : "";
      adminTag.hidden = !isAdmin;
      advBox.open = isAdmin;
      rememberDev.checked = LR.settings.remembered();
      rememberTeam.checked = t ? LR.team.remembered() : false;
      btnOff.hidden = !LR.mode();
      btnCancel.hidden = !LR.mode(); // 還沒登入就不能取消
      setTab(LR.mode() === "github" ? "github" : "team");
      if (!dlg.open) dlg.showModal();
      setTimeout(() => (first ? $f(t ? "setCode" : "setName") : btnCancel).focus(), 30);
    };
    btnCancel.addEventListener("click", () => { if (LR.mode()) dlg.close(); });
    // 按 Esc 也不能在未登入時關掉
    dlg.addEventListener("cancel", (e) => { if (!LR.mode()) e.preventDefault(); });
    // 有些瀏覽器不讓網頁攔 Esc；被關掉時只要還沒登入就立刻再打開（頁面內容本來就是隱藏的）
    dlg.addEventListener("close", () => { if (!LR.mode()) setTimeout(() => { if (!dlg.open && !LR.mode()) dlg.showModal(); }, 0); });
    btnOff.addEventListener("click", () => {
      LR.settings.disconnect();
      LR.team.clear();
      store.del("localStorage", CONSENT_KEY); // 換人使用時要重新同意
      dlg.close();
      LR.events.dispatchEvent(new Event("connection"));
      LR.toast("已登出，通關碼與 token 已從這個瀏覽器移除", "info");
    });
    form.addEventListener("input", (e) => {
      if (e.target.getAttribute && e.target.getAttribute("aria-invalid")) {
        e.target.removeAttribute("aria-invalid");
        const err = $f(e.target.id + "Err");
        if (err) err.hidden = true;
      }
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      clearErrors();
      const cur = LR.settings.get();
      const uploadUrl = $f("setUpload").value.trim();
      if (!LR.settings.validUploadUrl(uploadUrl)) return fail("網址格式不對，應該是 https://script.google.com/macros/s/…/exec", "setUpload");
      btnSave.disabled = true;
      btnSave.classList.add("loading");
      tsBox.hidden = true;
      status.textContent = "連線中…";
      try {
        if (tab === "team") {
          const name = LR.cleanText($f("setName").value, 30);
          const code = $f("setCode").value.trim() || (LR.team.get() || {}).code || "";
          // 已經是管理員、這次沒重填：沿用原本的管理員密碼，改名字不會被降成一般成員
          const admin = $f("setAdmin").value.trim() || LR.team.adminCode();
          if (!code) return fail("請輸入團隊通關碼", "setCode");
          if (!uploadUrl) return fail("網站沒有設定後端服務網址，請聯絡專題負責人");
          LR.settings.save(Object.assign({}, cur, { uploadUrl }), LR.settings.token(), LR.settings.remembered());
          let session = null;
          if (LR.turnstile.enabled()) {
            // 開了人機驗證：通過後用通關碼換一張通行證，之後的請求都不再帶通關碼
            status.textContent = "人機驗證中…（如果下面出現勾選框，請勾一下）";
            session = await LR.drive.login({ code, name, adminCode: admin }, tsBox);
          } else {
            await LR.drive.raw({ action: "ping" }, { code, name });
            if (admin) await LR.drive.raw({ action: "ping" }, { adminCode: admin, name });
          }
          // 通關碼模式不使用 GitHub token，避免兩種身分混用
          LR.settings.disconnect();
          LR.team.save(code, name, rememberTeam.checked);
          LR.team.setAdmin(admin);
          if (session) LR.session.save(session, rememberTeam.checked);
          dlg.close();
          LR.events.dispatchEvent(new Event("connection"));
          LR.toast(`歡迎${name ? "，" + name : ""}！${admin ? "已用管理員身分登入" : "可以開始錄了"}`, "good");
        } else {
          const s = {
            owner: $f("setOwner").value.trim(),
            repo: $f("setRepo").value.trim(),
            branch: $f("setBranch").value.trim() || "main",
            uploadUrl,
          };
          const token = $f("setToken").value.trim() || LR.settings.token();
          if (!LR.settings.valid(s)) return fail("帳號、repo 或分支名稱只能用英數字和 . _ -", "setOwner");
          if (!token) return fail("請貼上 token", "setToken");
          const info = await LR.gh.connect(s, token);
          LR.settings.save(Object.assign(s, { login: info.login }), token, rememberDev.checked);
          dlg.close();
          LR.events.dispatchEvent(new Event("connection"));
          LR.toast(`已連線 ${s.owner}/${s.repo}（${info.login}）${info.isPrivate ? "" : "。注意：這是公開 repo"}`, info.isPrivate ? "good" : "warn");
          if (s.uploadUrl) {
            LR.drive.ping()
              .then(() => LR.toast("Google 雲端上傳服務連線成功", "good"))
              .catch((err) => LR.toast(err.message, "warn", 8000));
          }
        }
      } catch (err) {
        // 後端開了人機驗證、網頁卻沒設定網站金鑰：怎麼登入都會失敗，直接說清楚（N6）
        if (err && err.code === "LOGIN_REQUIRED" && !LR.turnstile.enabled()) {
          fail("網站的人機驗證設定不一致（後端已開啟，網頁沒有設定 turnstileSiteKey），請聯絡專題負責人。");
        } else {
          fail(err.message, errField(err.message || ""));
        }
      } finally {
        btnSave.disabled = false;
        btnSave.classList.remove("loading");
        if (status.textContent === "連線中…" || /^人機驗證中/.test(status.textContent)) status.textContent = "";
      }
    });
    return dlg;
  }

  /** 登入頁的嘴唇插圖：會「無聲說話」的小動畫（減少動態效果時靜止） */
  function talkingLips() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 120 80");
    svg.setAttribute("class", "talk-lips");
    // 常數圖形，不含外部字串
    svg.innerHTML =
      '<ellipse class="tl-shadow" cx="60" cy="72" rx="34" ry="4"/>' +
      '<path class="tl-upper" d="M14 40c10-13 22-20 31-16 6 3 9 3 15 0s9-3 15 0c9-4 21 3 31 16-14 2-29 3-46 3S28 42 14 40z"/>' +
      '<path class="tl-mouth" d="M22 41c12 3 25 4 38 4s26-1 38-4c-10 9-23 14-38 14S32 50 22 41z"/>' +
      '<path class="tl-lower" d="M14 40c10 14 26 22 46 22s36-8 46-22c-14 4-29 6-46 6S28 44 14 40z"/>';
    return svg;
  }
})();
