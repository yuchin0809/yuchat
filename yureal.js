/* 📸 YuSnap（1日1回の写真）の画面（内部の名前は yureal のまま）。中身は Worker（/yureal）が決める
   ・通知（9:00〜15:00 のどこか）から3分以内に撮る。カメラは、内カメラ（自撮り）だけ。写真ライブラリからは選べない。遅れても投稿できる（「○分遅れ」と出る）
   ・友達だけに見える。自分が投稿するまで、友達のきょうの写真は見えない。保存は2日
   ・写真は小さく縮めて送る（200KB以下）。一覧では写真を読まず、見える所に来たときに、1枚ずつ読む（読み取りを減らすため）
   ・いまは管理者だけ（公開の切り替えは管理者のこの画面から） */
import { hasNgWord, NG_MESSAGE } from "./yungwords.js?v=20261111-ng2";
const MAX_SIDE = 720, MAX_LEN = 200000;
const EMOJIS = ["❤️", "😂", "😮", "😢", "👍", "🔥"];
let cfg = null, root = null, st = null, observer = null, timer = 0, stream = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const STYLE = `
.yr{max-width:560px;margin:0 auto;padding:12px 12px 90px;display:flex;flex-direction:column;gap:12px;color:#1d2433}
.yr h2{margin:0;font-size:20px}
.yr-top{display:flex;align-items:center;gap:8px}.yr-top h2{flex:1}
.yr-btn{min-height:40px;padding:0 14px;border:1px solid #d6dbe6;border-radius:12px;background:#fff;font-size:14px;font-weight:700;color:#1d2433}
.yr-btn.pri{background:#1d2433;border-color:#1d2433;color:#fff}.yr-btn.big{min-height:54px;width:100%;font-size:17px;border-radius:16px}
.yr-note{margin:0;padding:8px 12px;border-radius:10px;background:#fff6d6;color:#6b5200;font-size:12.5px}
.yr-card{background:#fff;border:1px solid #e7e9ed;border-radius:18px;padding:14px;display:flex;flex-direction:column;gap:10px}
.yr-now{display:flex;flex-direction:column;gap:8px;text-align:center}.yr-now b{font-size:17px}.yr-now span{font-size:13px;color:#667089}
.yr-post{background:#fff;border:1px solid #e7e9ed;border-radius:18px;overflow:hidden}
.yr-head{display:flex;align-items:center;gap:8px;padding:10px 12px}.yr-head b{flex:1;font-size:15px}.yr-head small{color:#8a93a8;font-size:12px}
.yr-late{background:#eef0f4;color:#667089;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:700}
.yr-img{width:100%;aspect-ratio:3/4;background:#e9ecf1;display:flex;align-items:center;justify-content:center;color:#8a93a8;font-size:13px}.yr-img img{width:100%;height:100%;object-fit:cover;display:block}
.yr-cap{padding:8px 12px 0;font-size:14px}
.yr-react{display:flex;gap:6px;padding:8px 12px;flex-wrap:wrap}.yr-react button{border:1px solid #e1e4e8;background:#fff;border-radius:14px;min-height:34px;padding:0 10px;font-size:15px}.yr-react button.on{background:#eef3ff;border-color:#2f6bff}.yr-react button:disabled:not(.on){opacity:.4}.yr-react small{font-size:12px;margin-left:3px;color:#667089}
.yr-modal{position:fixed;inset:0;z-index:99990;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:12px}
.yr-modal video,.yr-modal .pv{width:min(100%,420px);aspect-ratio:3/4;object-fit:cover;border-radius:18px;background:#222}
.yr-modal .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:center}.yr-modal input[type=text]{width:min(100%,420px);border-radius:12px;border:0;padding:10px 12px;font-size:15px}
.yr-shutter{width:72px;height:72px;border-radius:50%;border:5px solid #fff;background:rgba(255,255,255,.25)}
`;
function style() { if (document.getElementById("yrStyle")) return; const el = document.createElement("style"); el.id = "yrStyle"; el.textContent = STYLE; document.head.appendChild(el); }

async function api(action, body = {}) {
  const res = await fetch(cfg.endpoint, { method: "POST", headers: { Authorization: `Bearer ${await cfg.getToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ action, username: cfg.getUsername(), ...body }) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw Object.assign(new Error(json.error || `http_${res.status}`), { code: json.error || `http_${res.status}` });
  return json;
}
const nowMs = () => Date.now() + (st?.offset || 0);
const fmtTime = (ms) => new Date(ms).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
const errText = (e) => ({ not_yet: "まだ通知の時刻になっていません", already_posted: "きょうは、もう投稿ずみです", bad_image: "写真を送れませんでした（大きすぎるかも）", post_first: "先に自分が投稿しよう", already_reacted: "リアクションは1つの投稿に1個までです", not_friend: "友達だけが見られます", ng_word: "使えないことばが含まれています。ひとことを書き直してください" }[e?.code] || `できませんでした（${e?.code || "エラー"}）`);

export function initYureal(c) { cfg = c; }
export function stopYurealView() { clearInterval(timer); timer = 0; closeCamera(); observer?.disconnect(); observer = null; }
export async function openYurealView() {
  root = document.getElementById("yurealRoot"); if (!root || !cfg) return;
  style(); st = { offset: 0, conf: null, feed: null, error: "" };
  root.innerHTML = '<div class="yr"><p>読み込み中…</p></div>';
  await refresh();
  clearInterval(timer); timer = setInterval(tick, 1000);
}
async function refresh() {
  try {
    const conf = await api("config"); st.offset = conf.serverNowMs - Date.now(); st.conf = conf;
    st.feed = conf.allowed ? await api("feed") : null; st.error = "";
  } catch (e) { st.error = errText(e); }
  render();
}
function nowBox() {
  const f = st.feed, c = st.conf; if (!f) return "";
  if (f.posted) { const mine = f.items.find((i) => i.mine && i.date === f.today); return `<div class="yr-now"><b>✅ きょうは投稿ずみ</b><span>${mine ? (mine.lateMin ? `${mine.lateMin}分遅れで投稿` : "ちょうどいいタイミング！") : ""}</span></div>`; }
  if (c.atMs && nowMs() >= c.atMs) {
    const left = c.atMs + c.windowMs - nowMs();
    return `<div class="yr-now"><b>📸 YuSnap の時間です！</b><span id="yrCount">${left > 0 ? `あと ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")}` : `${Math.ceil(-left / 60000)}分遅れ（それでも投稿できます）`}</span><button class="yr-btn pri big" id="yrShoot">📸 いま撮る</button></div>`;
  }
  return `<div class="yr-now"><b>まだ、きょうの時間ではありません</b><span>通知が来たら、3分以内に撮ろう（9時〜15時のどこか）</span></div>`;
}
function render() {
  if (!root) return;
  const c = st.conf, f = st.feed;
  const admin = c?.isAdmin ? `<p class="yr-note">${c.published ? "公開中（ベータ版・全員に見えています）" : "管理者だけに見えています（まだ公開していません）"}</p><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="yr-btn" id="yrPub">${c.published ? "非公開にする" : "全員に公開する"}</button><button class="yr-btn" id="yrTest">テスト投稿（いつでも）</button></div>` : "";
  root.innerHTML = `<div class="yr"><div class="yr-top"><h2>📸 YuSnap（ベータ版）</h2><button class="yr-btn" id="yrReload">更新</button></div>${st.error ? `<p class="yr-note">${esc(st.error)}</p>` : ""}${admin}
    ${f ? `<div class="yr-card" id="yrNow">${nowBox()}</div>` : ""}
    ${f && f.hidden ? '<p class="yr-note">友達の投稿があります。自分が投稿すると見られます</p>' : ""}
    ${f ? (f.items.length ? f.items.map(postHtml).join("") : '<p style="text-align:center;color:#8a93a8">まだ投稿がありません</p>') : ""}
    ${f ? '<p style="text-align:center;color:#8a93a8;font-size:12px">写真は2日で消えます。友達だけに見えます。絵文字をタップするとリアクションが送れます（1つの投稿に1個だけ）</p>' : ""}</div>`;
  root.querySelector("#yrReload")?.addEventListener("click", refresh);
  root.querySelector("#yrShoot")?.addEventListener("click", () => openCamera(false));
  root.querySelector("#yrTest")?.addEventListener("click", () => openCamera(true));
  root.querySelector("#yrPub")?.addEventListener("click", async () => { if (!confirm(c.published ? "非公開にしますか？" : "全員に公開しますか？（通知も全員に届くようになります）")) return; try { await api("setPublished", { published: !c.published }); } catch (e) { st.error = errText(e); } refresh(); });
  root.querySelectorAll("[data-react]").forEach((b) => b.addEventListener("click", () => act(b.dataset.id, "react", { emoji: b.dataset.react })));
  root.querySelectorAll("[data-report]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("この投稿を通報しますか？（運営が確認します。相手には知らされません）")) return;
    try {
      const res = await fetch(cfg.reportEndpoint, { method: "POST", headers: { Authorization: `Bearer ${await cfg.getToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "report", username: cfg.getUsername(), kind: "snap", refId: b.dataset.report, reason: "inappropriate" }) });
      alert(res.ok ? "通報を受け付けました。ありがとうございます" : "通報できませんでした。時間をおいて、もう一度お試しください。");
    } catch (_) { alert("通報できませんでした。通信を確かめてください。"); }
  }));
  root.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => { if (confirm("この投稿を消しますか？")) { try { await api("deletePost", { id: b.dataset.del }); } catch (e) { st.error = errText(e); } refresh(); } }));
  observePhotos();
}
function postHtml(p) {
  const rc = EMOJIS.map((e) => `<button data-react="${e}" data-id="${p.id}" class="${p.myReaction === e ? "on" : ""}" ${p.myReaction ? "disabled" : ""}>${e}${p.reactions[e] ? `<small>${p.reactions[e]}</small>` : ""}</button>`).join("");
  return `<div class="yr-post"><div class="yr-head"><b>${esc(p.name)}${p.mine ? "（あなた）" : ""}</b>${p.lateMin ? `<span class="yr-late">${p.lateMin}分遅れ</span>` : ""}<small>${fmtTime(p.at)}</small>${p.mine ? `<button class="yr-btn" style="min-height:30px;padding:0 8px" data-del="${p.id}" aria-label="消す">🗑</button>` : `<button class="yr-btn" style="min-height:30px;padding:0 8px" data-report="${p.id}" aria-label="通報">🚩</button>`}</div>
    <div class="yr-img" data-photo="${p.id}">写真を読み込み中…</div>${p.caption ? `<div class="yr-cap">${esc(p.caption)}</div>` : ""}
    <div class="yr-react">${rc}</div></div>`;
}
async function act(id, action, body) {
  try {
    const r = await api(action, { id, ...body });
    const it = st.feed.items.find((i) => i.id === id); if (it && r.item) Object.assign(it, r.item);
  } catch (e) { st.error = errText(e); }
  const y = window.scrollY; render(); window.scrollTo(0, y);
}
const photoCache = new Map();
function observePhotos() {
  observer?.disconnect();
  observer = new IntersectionObserver((ents) => {
    for (const en of ents) if (en.isIntersecting) { observer.unobserve(en.target); loadPhoto(en.target); }
  }, { rootMargin: "200px" });
  root.querySelectorAll("[data-photo]").forEach((el) => { if (photoCache.has(el.dataset.photo)) setImg(el, photoCache.get(el.dataset.photo)); else observer.observe(el); });
}
const setImg = (el, src) => { el.innerHTML = ""; const im = new Image(); im.src = src; im.alt = ""; el.appendChild(im); };
async function loadPhoto(el) {
  const id = el.dataset.photo;
  try { const r = await api("photo", { id }); photoCache.set(id, r.img); if (el.isConnected) setImg(el, r.img); }
  catch (e) { el.textContent = e.code === "gone" ? "写真は消えました" : errText(e); }
}
let lastCfg = 0;
function tick() {
  const c = st?.conf, el = document.getElementById("yrCount");
  if (st?.feed && !st.feed.posted && c && c.atMs === undefined && Date.now() - lastCfg > 30000) {   // 通知の時刻になったら「いま撮る」を出す（設定だけ読む。一覧は読み直さない）
    lastCfg = Date.now();
    api("config").then((n) => { st.offset = n.serverNowMs - Date.now(); if (n.atMs !== undefined) { st.conf = n; render(); } }).catch(() => {});
  }
  if (el && c?.atMs) { const left = c.atMs + c.windowMs - nowMs(); el.textContent = left > 0 ? `あと ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")}` : `${Math.ceil(-left / 60000)}分遅れ（それでも投稿できます）`; }
}

/* ---- カメラ（内カメラだけ。撮る→確認→ひとこと→投稿）。写真ライブラリからは選べない ---- */
function closeCamera() { stream?.getTracks().forEach((t) => t.stop()); stream = null; document.getElementById("yrModal")?.remove(); }
async function openCamera(test) {
  closeCamera();
  const m = document.createElement("div"); m.className = "yr-modal"; m.id = "yrModal";
  m.innerHTML = '<video playsinline muted autoplay style="transform:scaleX(-1)"></video><div class="row"><button class="yr-btn" id="yrClose">やめる</button><button class="yr-shutter" id="yrSnap" aria-label="撮る"></button></div>';
  document.body.appendChild(m);
  const video = m.querySelector("video");
  const start = async () => { stream?.getTracks().forEach((t) => t.stop()); try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1080 } }, audio: false }); video.srcObject = stream; } catch (_) { video.replaceWith(Object.assign(document.createElement("p"), { textContent: "内カメラが使えません。カメラの許可を確かめてください", style: "color:#fff" })); } };
  start();
  m.querySelector("#yrClose").addEventListener("click", closeCamera);
  m.querySelector("#yrSnap").addEventListener("click", () => { if (video.videoWidth) review(drawFrom(video, video.videoWidth, video.videoHeight, true), test); });
}
/* 3:4 に切り取って、小さくして、200KB以下の JPEG にする */
function drawFrom(src, w, h, mirror) {
  const ratio = 3 / 4; let sw = w, sh = h;
  if (w / h > ratio) sw = Math.round(h * ratio); else sh = Math.round(w / ratio);
  const sx = Math.round((w - sw) / 2), sy = Math.round((h - sh) / 2);
  let side = MAX_SIDE;
  for (let i = 0; i < 6; i++) {
    const cw = Math.round(side * ratio), ch = side;
    const cv = document.createElement("canvas"); cv.width = cw; cv.height = ch; const g = cv.getContext("2d");
    if (mirror) { g.translate(cw, 0); g.scale(-1, 1); }
    g.drawImage(src, sx, sy, sw, sh, 0, 0, cw, ch);
    for (const q of [0.7, 0.6, 0.5, 0.4]) { const u = cv.toDataURL("image/jpeg", q); if (u.length <= MAX_LEN) return u; }
    side = Math.round(side * 0.82);
  }
  return "";
}
function review(dataUrl, test) {
  const m = document.getElementById("yrModal"); if (!m) return;
  stream?.getTracks().forEach((t) => t.stop()); stream = null;
  if (!dataUrl) { m.innerHTML = '<p style="color:#fff">写真を小さくできませんでした</p><button class="yr-btn" id="yrClose2">とじる</button>'; m.querySelector("#yrClose2").addEventListener("click", closeCamera); return; }
  m.innerHTML = `<img class="pv" src="${dataUrl}" alt=""><input type="text" id="yrCap" maxlength="40" placeholder="ひとこと（なくてもOK）"><div class="row"><button class="yr-btn" id="yrRe">撮り直す</button><button class="yr-btn pri" style="background:#2f6bff;border-color:#2f6bff" id="yrSend">投稿する</button></div><p id="yrMsg" style="color:#fff;margin:0;font-size:13px"></p>`;
  m.querySelector("#yrRe").addEventListener("click", () => openCamera(test));
  m.querySelector("#yrSend").addEventListener("click", async (ev) => {
    if (hasNgWord(m.querySelector("#yrCap").value)) { m.querySelector("#yrMsg").textContent = NG_MESSAGE; return; }
    ev.currentTarget.disabled = true; m.querySelector("#yrMsg").textContent = "送っています…";
    try { await api("post", { img: dataUrl, caption: m.querySelector("#yrCap").value, ...(test ? { test: true } : {}) }); closeCamera(); photoCache.clear(); await refresh(); }
    catch (e) { m.querySelector("#yrMsg").textContent = errText(e); ev.currentTarget.disabled = false; }
  });
}
