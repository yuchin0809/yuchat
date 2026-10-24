/* =========================================================
   🏪 ゆうマート（フリマ）の画面（script.js から呼ばれる）

   ・いらなくなった消しバトのパーツを、ほかの人に売る・買う。売れたパーツは「中古」になる（新品より、増える点数がほんの少しだけ低い）。
   ・手数料は売れた値段の 10%。値段の上限はない。値下げ依頼（買う人が値段を出す／NPC から来ることもある）を、出品者が受ける・断る。
   ・売る・買う・コインの移動は、すべて Worker（mart* アクション）が決める。この画面は表示と操作だけ。
   ・商品の画像：mart-img/{枠}-{パーツ}.png（例：mart-img/body-titan.png）。ファイルがなければ絵文字で表示する。
========================================================= */

let deps = null, root = null, stylesDone = false, token = 0;
let S = null, M = null, tab = "buy", slotFilter = "all", sort = "new", busy = false, note = null, adminData = null;
const fmt = (n) => Number(n || 0).toLocaleString("ja-JP");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (s) => root && root.querySelector(s);
const SLOT = { body: "本体", edge: "ふち", sole: "そこ", weight: "おもり" };
const EMOJI = { body: "🧽", edge: "🔲", sole: "👟", weight: "⚖️" };
const STAT = [["m", "重さ"], ["s", "すべり"], ["b", "反発"], ["z", "大きさ"]];
const ERR = {
  gone: "この商品はもうありません（売れた・取り下げられた・期限切れ）", own_listing: "自分の出品は買えません", insufficient_coins: "コインが足りません", already_owned: "同じ中古パーツをすでに持っています",
  seated: "ゆうスロの席に着いているあいだは買えません。席を立ってからもう一度どうぞ", busy: "混み合っています。もう一度お試しください", paused: "ゆうマートは一時お休み中です",
  too_many: "出品は1人10件までです", mart_full: "出品がいっぱいで、いまは追加できません", bad_price: "その値段は出せません", bad_request: "出品できないパーツです", not_owned: "そのパーツを持っていません",
  already_offered: "この商品には、すでに値下げ依頼を出しています", offers_full: "この商品への値下げ依頼がいっぱいです", buyer_no_coins: "相手のコインが足りないため、売れませんでした（依頼は消えました）",
  buyer_busy: "相手がいまゆうスロの席に着いているため、売れませんでした", buyer_has_it: "相手はすでに同じ中古パーツを持っているため、売れませんでした（依頼は消えました）", already_sold: "すでに売れています。画面を開きなおしてください",
  not_published: "ゆうマートはまだ公開されていません"
};

async function api(action, payload = {}) {
  const t = await deps.getToken();
  const res = await fetch(deps.endpoint, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify({ action, username: deps.getUsername(), ...payload }) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) { const e = new Error(json.error || `http_${res.status}`); e.code = json.error || `http_${res.status}`; e.detail = json; throw e; }
  return json;
}
export function initYuMart(options) { deps = options; root = document.getElementById("yumartRoot"); }
export function stopYuMartView() { token++; busy = false; }
export async function openYuMartView() {
  if (!root || !deps) return;
  injectStyles();
  const my = ++token;
  if (!S) root.innerHTML = `<div class="ym-card ym-msg">読み込み中…</div>`;
  await refresh(my);
}
async function refresh(my = token) {
  try {
    const [s, m] = await Promise.all([api("martStatus"), api("martMine")]);
    if (my !== token) return;
    S = s; M = m; draw();
  } catch (e) {
    if (my !== token) return;
    const msg = e && e.code === "not_published" ? ERR.not_published : "読み込みに失敗しました。通信環境をご確認のうえ、もう一度お試しください。";
    root.innerHTML = `<div class="ym-card ym-msg"><b>${esc(msg)}</b>${e && e.code === "not_published" ? "" : `<p><button type="button" class="ym-btn" id="ymRetry">もう一度</button></p>`}</div>`;
    $("#ymRetry")?.addEventListener("click", () => openYuMartView());
  }
}

/* ---------- 部品 ---------- */
const partInfo = (slot, variant) => (S.table[slot] || []).find((p) => p.id === String(variant).replace(/~u$/, ""));
const usedStat = (v) => (v > 0 ? Math.round(v * S.usedRate) : v);
function effectText(slot, variant) {
  const p = partInfo(slot, variant); if (!p) return "";
  const used = String(variant).endsWith("~u");
  const t = STAT.map(([k, label]) => { const v = used ? usedStat(p[k]) : p[k]; return v ? `${label}${v > 0 ? "+" : ""}${v}` : ""; }).filter(Boolean);
  return t.join(" ") || "変化なし";
}
function thumb(slot, variant) {
  const id = String(variant).replace(/~u$/, "");
  return `<span class="ym-img"><img src="mart-img/${esc(slot)}-${esc(id)}.png" alt="" loading="lazy" onerror="this.remove()"><i>${EMOJI[slot] || "📦"}</i></span>`;
}
function priceTag(price, ref) {
  if (!ref) return "";
  const r = price / ref;
  return r <= 0.95 ? `<em class="ym-tag good">相場よりお得</em>` : r >= 1.5 ? `<em class="ym-tag high">相場より高め</em>` : "";
}
const timeLeft = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `あと${d}日${h}時間` : h ? `あと${h}時間${m}分` : `あと${m}分`; };
const nowMs = () => (S ? S.serverNowMs : Date.now()) + (Date.now() - (S ? S.fetchedAt || Date.now() : Date.now()));

/* ---------- 画面 ---------- */
function draw() {
  S.fetchedAt = S.fetchedAt || Date.now();
  const tabs = [["buy", "🛒 買う"], ["sell", "📦 出品する"], ["mine", `👤 自分の出品${M.listings.length ? `（${M.listings.length}）` : ""}`]];
  const alerts = M.listings.reduce((a, l) => a + l.offers.length + (l.npcOffer ? 1 : 0), 0);
  root.innerHTML = `<div class="ym-head"><h2>🏪 ゆうマート</h2><div class="ym-coins">🪙 ${fmt(M.coins)}</div></div>
    <p class="ym-lead">いらなくなった消しバトのパーツを、売ったり買ったり。売れたパーツは中古になります。手数料は ${S.feePct}%。</p>
    ${S.paused ? `<div class="ym-card ym-warn">⏸ いまゆうマートは一時お休み中です（買う・出品はできません）</div>` : ""}
    ${note ? `<div class="ym-note ${note.bad ? "bad" : "ok"}">${esc(note.text)}</div>` : ""}
    <div class="ym-tabs">${tabs.map(([k, label]) => `<button type="button" class="ym-tab${tab === k ? " on" : ""}" data-tab="${k}">${label}${k === "mine" && alerts ? ` <b class="ym-dot">${alerts}</b>` : ""}</button>`).join("")}</div>
    <div id="ymBody"></div>${S.isTopAdmin ? `<div id="ymAdmin"></div>` : ""}`;
  root.querySelectorAll(".ym-tab").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; note = null; draw(); }));
  if (tab === "buy") drawBuy(); else if (tab === "sell") drawSell(); else drawMine();
  if (S.isTopAdmin) drawAdmin();
}
function drawBuy() {
  let list = S.listings.filter((x) => slotFilter === "all" || x.slot === slotFilter);
  list = [...list].sort(sort === "cheap" ? (a, b) => a.price - b.price : sort === "dear" ? (a, b) => b.price - a.price : (a, b) => b.t - a.t);
  const my = M.myOffers.reduce((o, x) => { o[x.id] = x.q; return o; }, {});
  $("#ymBody").innerHTML = `<div class="ym-filter">
      <select id="ymSlot"><option value="all">すべての部位</option>${Object.entries(SLOT).map(([k, v]) => `<option value="${k}"${slotFilter === k ? " selected" : ""}>${v}</option>`).join("")}</select>
      <select id="ymSort"><option value="new"${sort === "new" ? " selected" : ""}>新しい順</option><option value="cheap"${sort === "cheap" ? " selected" : ""}>安い順</option><option value="dear"${sort === "dear" ? " selected" : ""}>高い順</option></select>
      <button type="button" class="ym-btn ym-sub" id="ymReload">更新</button></div>
    <div class="ym-grid">${list.map((x) => {
      const p = partInfo(x.slot, x.part);
      return `<div class="ym-item">${thumb(x.slot, x.part)}<div class="ym-info"><b>${esc(p ? p.name : x.part)}<span class="ym-used">中古</span></b>
        <small>${SLOT[x.slot]}　${esc(effectText(x.slot, x.part))}</small>
        <div class="ym-price">🪙 ${fmt(x.price)} ${priceTag(x.price, x.ref)}</div><small class="ym-seller">出品：${esc(x.n)}${x.npc ? "" : ` ・${timeLeft(x.e - nowMs())}`}</small></div>
        <div class="ym-act">${x.mine ? `<span class="ym-small">自分の出品</span>` : `<button type="button" class="ym-btn" data-buy="${esc(x.id)}" ${busy || S.paused ? "disabled" : ""}>買う</button>${x.npc ? "" : my[x.id] ? `<span class="ym-small">依頼中 🪙${fmt(my[x.id])}</span>` : `<button type="button" class="ym-btn ym-sub" data-offer="${esc(x.id)}" ${busy || S.paused ? "disabled" : ""}>値下げ依頼</button>`}`}</div></div>`;
    }).join("") || `<div class="ym-card ym-msg">いま出品はありません</div>`}</div>
    <p class="ym-small">買ったあとのキャンセルはできません。中古パーツは、消しバトの「パーツ」から付けられます。</p>`;
  $("#ymSlot").addEventListener("change", (e) => { slotFilter = e.target.value; drawBuy(); });
  $("#ymSort").addEventListener("change", (e) => { sort = e.target.value; drawBuy(); });
  $("#ymReload").addEventListener("click", () => { note = null; refresh(); });
  root.querySelectorAll("[data-buy]").forEach((b) => b.addEventListener("click", () => buy(b.dataset.buy)));
  root.querySelectorAll("[data-offer]").forEach((b) => b.addEventListener("click", () => offer(b.dataset.offer)));
}
function drawSell() {
  const items = M.sellable;
  $("#ymBody").innerHTML = `<div class="ym-card"><h3>出品するパーツを選ぶ</h3>
    ${items.length ? items.map((x, i) => {
      const p = partInfo(x.slot, x.part), used = String(x.part).endsWith("~u");
      return `<div class="ym-item ym-sellrow">${thumb(x.slot, x.part)}<div class="ym-info"><b>${esc(p ? p.name : x.part)}${used ? `<span class="ym-used">中古</span>` : ""}</b>
        <small>${SLOT[x.slot]}　${esc(effectText(x.slot, x.part))}${x.equipped ? "　（いま付けている）" : ""}</small><small>相場の目安 🪙 ${fmt(x.ref)}</small></div>
        <div class="ym-act"><input type="number" inputmode="numeric" min="1" step="1" class="ym-input" id="ymP${i}" placeholder="${fmt(x.ref)}" value="${x.ref}"><button type="button" class="ym-btn" data-list="${i}" ${busy || S.paused ? "disabled" : ""}>出品</button></div></div>`;
    }).join("") : `<div class="ym-msg">出品できるパーツがありません。消しバトのショップでパーツを買うと、ここから売れます。</div>`}
    <p class="ym-small">出品すると、そのパーツは「預かり」になります（出品中は付けられません。売れ残ったら、そのまま戻ります）。出品は ${S.maxOpen} 件・3日間まで。値段の上限はありません。売れたら ${S.feePct}% の手数料が引かれます。</p></div>`;
  root.querySelectorAll("[data-list]").forEach((b) => b.addEventListener("click", () => {
    const x = items[Number(b.dataset.list)], price = Number($(`#ymP${b.dataset.list}`).value);
    if (!Number.isInteger(price) || price < 1) { setNote("値段は1以上の整数で入れてください", true); return; }
    const p = partInfo(x.slot, x.part);
    if (!confirm(`${p ? p.name : x.part}（中古になって売られます）を 🪙${fmt(price)} で出品しますか？\n売れると手数料 ${S.feePct}% が引かれます。`)) return;
    run(async () => { await api("martList", { slot: x.slot, part: x.part, price }); tab = "mine"; return "出品しました"; });
  }));
}
function drawMine() {
  const L = M.listings;
  $("#ymBody").innerHTML = `${L.length ? L.map((x) => {
    const p = partInfo(x.slot, x.part);
    const offers = [...(x.npcOffer ? [{ u: "npc", n: x.npcOffer.n, q: x.npcOffer.q }] : []), ...x.offers];
    return `<div class="ym-card ym-mine"><div class="ym-item">${thumb(x.slot, x.part)}<div class="ym-info"><b>${esc(p ? p.name : x.part)}${String(x.part).endsWith("~u") ? `<span class="ym-used">中古</span>` : ""}</b>
      <div class="ym-price">🪙 ${fmt(x.price)}</div><small>${x.expired ? "期限切れ（取り下げてください）" : timeLeft(x.e - nowMs())}</small></div>
      <div class="ym-act"><button type="button" class="ym-btn ym-sub" data-cancel="${esc(x.id)}" ${busy ? "disabled" : ""}>取り下げる</button></div></div>
      ${offers.map((o) => `<div class="ym-offer"><span>💬 <b>${esc(o.n)}</b> さんが <b>🪙 ${fmt(o.q)}</b> で買いたいそうです（値下げ依頼）</span>
        <span><button type="button" class="ym-btn" data-ans="${esc(x.id)}" data-who="${esc(o.u)}" data-acc="1" ${busy ? "disabled" : ""}>受ける</button> <button type="button" class="ym-btn ym-sub" data-ans="${esc(x.id)}" data-who="${esc(o.u)}" data-acc="0" ${busy ? "disabled" : ""}>断る</button></span></div>`).join("")}</div>`;
  }).join("") : `<div class="ym-card ym-msg">出品中のパーツはありません</div>`}
    <div class="ym-card"><h3>最近の取引</h3>${M.done.length ? M.done.map((d) => {
      const [slot, id] = d.i.split(":"), p = partInfo(slot, id), name = p ? p.name : d.i, me = deps.getUsername();
      const text = d.npc ? `${esc(d.b)} さんに売れました（手数料 ${fmt(d.fee)}）` : d.sn === me ? `${esc(d.bn || "")} さんに売れました（手数料 ${fmt(d.fee)}）` : `${esc(d.sn)} さんから買いました`;
      return `<div class="ym-log">${esc(name)}　🪙 ${fmt(d.q)}　<small>${text}</small></div>`;
    }).join("") : `<div class="ym-msg">まだ取引はありません</div>`}</div>`;
  root.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => { if (confirm("この出品を取り下げて、パーツを戻しますか？")) run(async () => { await api("martCancel", { id: b.dataset.cancel }); return "取り下げました。パーツは手元に戻りました"; }); }));
  root.querySelectorAll("[data-ans]").forEach((b) => b.addEventListener("click", () => {
    const acc = b.dataset.acc === "1";
    run(async () => { const r = await api("martAnswer", { id: b.dataset.ans, who: b.dataset.who, accept: acc }); return acc ? `🪙 ${fmt(r.price)} で売れました！（手数料 ${fmt(r.fee)}）` : "断りました"; });
  }));
}
function buy(id) {
  const x = S.listings.find((l) => l.id === id); if (!x) return;
  const p = partInfo(x.slot, x.part);
  if (!confirm(`${p ? p.name : x.part}（中古）を 🪙${fmt(x.price)} で買いますか？\n買ったあとのキャンセルはできません。`)) return;
  run(async () => { await api("martBuy", { id }); return `買いました！「${p ? p.name : ""}（中古）」は、消しバトのパーツから付けられます`; });
}
function offer(id) {
  const x = S.listings.find((l) => l.id === id); if (!x) return;
  const min = Math.ceil(x.price * 0.3), v = prompt(`いくらなら買いますか？（${fmt(min)}〜${fmt(x.price - 1)} コイン）\n出品者が受けると、その値段で買うことになります。`, String(Math.max(min, Math.floor(x.price * 0.85))));
  if (v === null) return;
  const price = Number(v);
  if (!Number.isInteger(price)) { setNote("値段は整数で入れてください", true); return; }
  run(async () => { await api("martOffer", { id, price }); return "値下げ依頼を出しました。出品者が受けると売れます（24時間）"; });
}
function setNote(text, bad) { note = { text, bad }; draw(); }
async function run(fn) {
  if (busy) return;
  busy = true; const my = token;
  try { const text = await fn(); note = { text, bad: false }; }
  catch (e) { note = { text: ERR[e && e.code] || "うまくいきませんでした。もう一度お試しください", bad: true }; }
  busy = false;
  if (my === token) await refresh(my);
}

/* ---------- 管理者（最上位管理者だけ） ---------- */
function drawAdmin() {
  const el = $("#ymAdmin"); if (!el) return;
  el.innerHTML = `<div class="ym-card ym-adminbox"><h3>管理者メニュー</h3>
    <p class="ym-small">状態：<b>${S.paused ? "お休み中" : "営業中"}</b>　<button type="button" class="ym-btn ym-sub" id="ymPause">${S.paused ? "再開する" : "一時お休みにする"}</button>　<button type="button" class="ym-btn ym-sub" id="ymReport">監視ログを見る</button></p>
    <div id="ymReportBox">${adminData ? adminHtml() : ""}</div></div>`;
  $("#ymPause").addEventListener("click", () => run(async () => { await api("martAdmin", { op: "pause", paused: !S.paused }); return S.paused ? "再開しました" : "お休みにしました"; }));
  $("#ymReport").addEventListener("click", async () => { try { adminData = await api("martAdmin", { op: "report" }); $("#ymReportBox").innerHTML = adminHtml(); bindAdmin(); } catch (_) { setNote("読み込めませんでした", true); } });
  bindAdmin();
}
function adminHtml() {
  const d = adminData, t = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(5, 16).replace("T", " ");
  return `<h4>売れた記録（新しい順・印は目安。止めはしません）</h4>${d.log.slice(0, 60).map((e) => `<div class="ym-log${e.flags.length ? " flag" : ""}">${t(e.at)}　${esc(e.s)} → ${esc(e.b)}　${esc(e.i)}　🪙${fmt(e.q)}${e.ref ? `（相場 ${fmt(e.ref)}）` : ""}　${e.flags.map((f) => `<b>${esc(f)}</b>`).join(" ")}</div>`).join("") || "<div class='ym-msg'>まだありません</div>"}
    <h4>出品中（${d.listings.length}件）</h4>${d.listings.map((l) => `<div class="ym-log">${esc(l.seller)}　${esc(l.slot)}:${esc(l.part)}　🪙${fmt(l.price)}　<button type="button" class="ym-btn ym-sub" data-rm="${esc(l.id)}">取り下げさせる</button></div>`).join("")}`;
}
function bindAdmin() {
  root.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => { if (confirm("この出品を強制的に取り下げて、持ち主に戻しますか？")) run(async () => { await api("martAdmin", { op: "remove", id: b.dataset.rm }); adminData = null; return "取り下げさせました"; }); }));
}

function injectStyles() {
  if (stylesDone && document.getElementById("yumart-styles")) return;
  stylesDone = true;
  const st = document.createElement("style"); st.id = "yumart-styles";
  st.textContent = `
  .ym-head { display: flex; align-items: center; justify-content: space-between; margin: 4px 0 2px; } .ym-head h2 { margin: 0; font-size: 21px; }
  .ym-coins { font-weight: 900; background: #fff6d6; border-radius: 999px; padding: 5px 12px; font-size: 14px; }
  .ym-lead, .ym-small { font-size: 12.5px; color: #666; line-height: 1.7; margin: 6px 0; }
  .ym-tabs { display: flex; gap: 6px; margin: 10px 0; } .ym-tab { flex: 1; border: 1px solid #ddd; background: #fff; border-radius: 12px; padding: 9px 4px; font-weight: 800; font-size: 13px; cursor: pointer; }
  .ym-tab.on { background: linear-gradient(135deg, #ff7a18, #ffb347); color: #fff; border-color: transparent; }
  .ym-dot { background: #e5262e; color: #fff; border-radius: 999px; font-size: 11px; padding: 1px 6px; }
  .ym-card { background: #fff; border-radius: 16px; padding: 12px 14px; margin: 10px 0; box-shadow: 0 3px 12px rgba(0,0,0,.07); } .ym-card h3 { margin: 0 0 8px; font-size: 15px; } .ym-msg { text-align: center; color: #666; font-size: 13.5px; padding: 14px; }
  .ym-warn { background: #fff3e0; font-weight: 800; font-size: 13px; }
  .ym-note { border-radius: 12px; padding: 9px 12px; font-size: 13px; font-weight: 800; margin: 8px 0; } .ym-note.ok { background: #e6f8ec; color: #1b6b3a; } .ym-note.bad { background: #fdeaea; color: #a32525; }
  .ym-filter { display: flex; gap: 6px; margin-bottom: 8px; } .ym-filter select { flex: 1; padding: 8px; border-radius: 10px; border: 1px solid #ddd; background: #fff; font-size: 13px; }
  .ym-grid { display: grid; gap: 8px; }
  .ym-item { display: grid; grid-template-columns: 64px 1fr auto; gap: 10px; align-items: center; background: #fff; border-radius: 14px; padding: 10px; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
  .ym-mine .ym-item { box-shadow: none; padding: 0; }
  .ym-img { position: relative; width: 64px; height: 64px; border-radius: 12px; background: linear-gradient(135deg, #fff1d6, #ffe0e8); display: grid; place-items: center; overflow: hidden; }
  .ym-img img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; } .ym-img i { font-style: normal; font-size: 30px; }
  .ym-info b { font-size: 14.5px; } .ym-info small { display: block; color: #777; font-size: 11.5px; line-height: 1.6; }
  .ym-used { background: #8a7a5a; color: #fff; border-radius: 6px; font-size: 10px; padding: 1px 5px; margin-left: 5px; vertical-align: 2px; }
  .ym-price { font-weight: 900; font-size: 16px; color: #d6361f; margin: 2px 0; } .ym-tag { font-style: normal; font-size: 10.5px; border-radius: 6px; padding: 1px 6px; margin-left: 4px; vertical-align: 2px; } .ym-tag.good { background: #dff7e6; color: #1b6b3a; } .ym-tag.high { background: #fde9d4; color: #9a4b00; }
  .ym-act { display: grid; gap: 5px; justify-items: stretch; min-width: 78px; }
  .ym-btn { border: none; border-radius: 10px; padding: 9px 12px; font-weight: 900; font-size: 13px; cursor: pointer; color: #fff; background: linear-gradient(135deg, #ff7a18, #ff4d6d); } .ym-btn[disabled] { opacity: .45; cursor: default; } .ym-sub { background: #eee; color: #444; }
  .ym-input { width: 96px; padding: 7px; border-radius: 9px; border: 1px solid #ccc; font-size: 14px; text-align: right; }
  .ym-sellrow { margin-bottom: 8px; }
  .ym-offer { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: space-between; background: #fff7e6; border-radius: 10px; padding: 8px 10px; margin-top: 8px; font-size: 13px; }
  .ym-log { font-size: 12.5px; padding: 6px 0; border-bottom: 1px solid #f0f0f0; line-height: 1.6; } .ym-log.flag { background: #fff3f0; } .ym-log b { color: #c0392b; font-size: 11px; }
  .ym-adminbox h4 { margin: 12px 0 4px; font-size: 13px; }
  @media (max-width: 420px) { .ym-item { grid-template-columns: 54px 1fr; } .ym-img { width: 54px; height: 54px; } .ym-act { grid-column: 1 / -1; grid-template-columns: 1fr 1fr; } }
  `;
  document.head.appendChild(st);
}
