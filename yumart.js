/* =========================================================
   🏪 ゆうマート（フリマ）の画面（script.js から呼ばれる）

   ・いらなくなった消しバトのパーツを、ほかの人に売る・買う。売れたパーツは「中古」になる（新品より、増える点数がほんの少しだけ低い）。
   ・手数料は売れた値段の 10%。値段の上限はない。値下げ依頼（買う人が値段を出す／NPC から来ることもある）を、出品者が受ける・断る。
   ・売る・買う・コインの移動は、すべて Worker（mart* アクション）が決める。この画面は表示と操作だけ。
   ・商品の画像：mart-img/{枠}-{パーツ}.png（例：mart-img/body-titan.png）。ファイルがなければ、パーツごとに描いた絵（yumart-art.js）を表示する。
========================================================= */

import { partArt, kakuArt, prizeArt } from "./yumart-art.js?v=20261024-mart7";

let deps = null, root = null, stylesDone = false, token = 0;
let sellMode = "fixed", sellHours = 24, negoOpen = null, negoMsg = {};
let S = null, M = null, SELL = null, sellBusy = false, tab = "buy", slotFilter = "all", sort = "new", busy = false, note = null, adminData = null;
const fmt = (n) => Number(n || 0).toLocaleString("ja-JP");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (s) => root && root.querySelector(s);
const SLOT = { body: "本体", edge: "ふち", sole: "そこ", weight: "おもり" };
const STAT = [["m", "重さ"], ["s", "すべり"], ["b", "反発"], ["z", "大きさ"]];
const ERR = {
  gone: "この商品はもうありません（売れた・取り下げられた・期限切れ）", own_listing: "自分の出品は買えません", insufficient_coins: "コインが足りません", already_owned: "同じ中古パーツをすでに持っています",
  seated: "ゆうスロの席に着いているあいだは買えません。席を立ってからもう一度どうぞ", busy: "混み合っています。もう一度お試しください", paused: "ゆうマートは一時お休み中です",
  too_many: "出品は1人10件までです", mart_full: "出品がいっぱいで、いまは追加できません", bad_price: "その値段は出せません", bad_request: "出品できないパーツです", not_owned: "そのパーツを持っていません",
  already_offered: "この商品には、すでに値下げ依頼を出しています", offers_full: "この商品への値下げ依頼がいっぱいです", buyer_no_coins: "相手のコインが足りないため、売れませんでした（依頼は消えました）",
  buyer_busy: "相手がいまゆうスロの席に着いているため、売れませんでした", buyer_has_it: "相手はすでに同じ中古パーツを持っているため、売れませんでした（依頼は消えました）", already_sold: "すでに売れています。画面を開きなおしてください",
  not_published: "ゆうマートはまだ公開されていません", too_late: "枠の始まりの10分前をすぎたので、出品できません", already_listed: "この枠はすでに出品しています", no_resale: "確変台の予約権は、買ったものをまた売ることはできません",
  right_expired: "この予約権は、期限が近いか、すぎているので出品できません", company_exists: "すでに会社を作っているので、A賞は出品できません", slot_limit: "1日にもてる確変の枠は3つまでです", no_more: "この商品では、もう交渉できません（1つの商品につき3回まで）", reserved: "別のお客さんが交渉中です。しばらくしてからどうぞ",
  auction_only: "これはオークションです。「入札」から参加してください", bid_too_low: "入札額が低すぎます", already_top: "あなたがいま最高額で入札中です", has_bids: "入札があるので、取り下げられません", bids_full: "このオークションは、これ以上入札できません", no_auction: "確変台の枠はオークションにできません"
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
  SELL = null;
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
const MACHINE = { yubasic: "ゆうベーシック", yurush: "ゆうラッシュ", yuchance: "ゆうチャンス", yutreasure: "ゆうトレジャー", yurainbow: "ゆうレインボー", yujackpot: "ゆうジャックポット" };
const PRIZE = { A: "A賞　自分の会社を運営できる権利", C: "C賞　確変台の予約を3回とれる権利", D: "D賞　確変台の予約を優先で1回確定でとれる権利", E: "E賞　消しバトの限定改造品", F: "F賞　消しバトの限定カラー" };
const GEAR = { body: "本体", edge: "ふち", sole: "そこ", weight: "おもり" }, COLOR = { gold: "金", silver: "銀", rainbow: "虹", blackgold: "黒金" };
const jst = (ms) => new Date(ms + 9 * 3600000);
const hm = (ms) => { const d = jst(ms); return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
const md = (ms) => { const d = jst(ms); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${"日月火水木金土"[d.getUTCDay()]}）`; };
function img(file) { return `<img src="mart-img/${esc(file)}.png" alt="" loading="lazy" onerror="this.remove()">`; }
/* 出品・持ち物の見せ方：{ name, sub, art, used } */
function itemOf(x) {
  if (x.k === "kaku") return { name: `🌈 確変台の枠（${MACHINE[x.machine] || "確変台"}）`, sub: `${md(x.ss)} ${hm(x.ss)}〜${hm(x.se)}（${Math.round((x.se - x.ss) / 60000)}分）`, art: kakuArt() + img("kaku"), used: false };
  if (x.k === "prize") {
    const z = x.prize || {}, extra = z.id === "E" ? `（${GEAR[z.code] || ""}）` : z.id === "F" ? `「${COLOR[z.code] || ""}」` : "";
    return { name: `${PRIZE[x.pid] || x.pid}${extra}`, sub: `ゆう番くじの景品${z.until ? `　期限 ${md(z.until)}` : ""}`, art: prizeArt(x.pid, z.code) + img(`prize-${x.pid}`), used: false };
  }
  const p = partInfo(x.slot, x.part), id = String(x.part).replace(/~u$/, "");
  return { name: p ? p.name : x.part, sub: `${SLOT[x.slot]}　${effectText(x.slot, x.part)}`, art: partArt(x.slot, id) + img(`${x.slot}-${id}`), used: String(x.part).endsWith("~u") };
}
const thumb = (it) => `<span class="ym-img">${it.art}</span>`;
const nameHtml = (it) => `${esc(it.name)}${it.used ? `<span class="ym-used">中古</span>` : ""}`;
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
    <p class="ym-lead">いらなくなった消しバトのパーツ・確変台の枠・ゆう番くじの景品を、売ったり買ったり。売れたパーツは中古になります。手数料は ${S.feePct}%。</p>
    ${S.paused ? `<div class="ym-card ym-warn">⏸ いまゆうマートは一時お休み中です（買う・出品はできません）</div>` : ""}
    ${note ? `<div class="ym-note ${note.bad ? "bad" : "ok"}">${esc(note.text)}</div>` : ""}
    <div class="ym-tabs">${tabs.map(([k, label]) => `<button type="button" class="ym-tab${tab === k ? " on" : ""}" data-tab="${k}">${label}${k === "mine" && alerts ? ` <b class="ym-dot">${alerts}</b>` : ""}</button>`).join("")}</div>
    <div id="ymBody"></div>${S.isTopAdmin ? `<div id="ymAdmin"></div>` : ""}`;
  root.querySelectorAll(".ym-tab").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; note = null; draw(); }));
  if (tab === "buy") drawBuy(); else if (tab === "sell") drawSell(); else drawMine();
  if (S.isTopAdmin) drawAdmin();
}
const KINDS = [["all", "すべて"], ["kaku", "🌈 確変台の枠"], ["prize", "🎁 番くじの景品"], ["body", "🧽 本体"], ["edge", "🔲 ふち"], ["sole", "👟 そこ"], ["weight", "⚖️ おもり"]];
function drawBuy() {
  let list = S.listings.filter((x) => slotFilter === "all" || (slotFilter === "kaku" || slotFilter === "prize" ? x.k === slotFilter : x.k === "part" && x.slot === slotFilter));
  list = [...list].sort(sort === "cheap" ? (a, b) => a.price - b.price : sort === "dear" ? (a, b) => b.price - a.price : (a, b) => b.t - a.t);
  const my = M.myOffers.reduce((o, x) => { o[x.id] = x.q; return o; }, {});
  const bidInfo = (M.myBids || []).reduce((o, x) => { o[x.id] = x; return o; }, {});
  $("#ymBody").innerHTML = `<div class="ym-filter">
      <select id="ymSlot">${KINDS.map(([k, v]) => `<option value="${k}"${slotFilter === k ? " selected" : ""}>${v}</option>`).join("")}</select>
      <select id="ymSort"><option value="new"${sort === "new" ? " selected" : ""}>新しい順</option><option value="cheap"${sort === "cheap" ? " selected" : ""}>安い順</option><option value="dear"${sort === "dear" ? " selected" : ""}>高い順</option></select>
      <button type="button" class="ym-btn ym-sub" id="ymReload">更新</button></div>
    <div class="ym-grid">${list.map((x) => {
      const it = itemOf(x);
      return `<div class="ym-item">${thumb(it)}<div class="ym-info"><b>${nameHtml(it)}</b>
        <small>${esc(it.sub)}</small>
        <div class="ym-price">${x.au ? `<span class="ym-au">🔨 オークション</span> 現在 ` : ""}🪙 ${fmt(x.price)} ${x.au ? "" : priceTag(x.price, x.ref)}</div>
        ${x.au ? `<small>入札 ${x.au.nb}件${x.au.top ? `　最高：${esc(x.au.top)}${x.au.top === deps.getUsername() ? "（あなた）" : ""}` : "　まだ入札なし"}</small>` : ""}
        ${x.deal ? `<small class="ym-deal">🤝 交渉成立！ 🪙${fmt(x.deal.from)} → 🪙${fmt(x.price)}${x.dealMine && x.deal.until > nowMs() ? `（あなたが ${timeLeft(x.deal.until - nowMs()).replace("あと", "あと")} 優先で買えます）` : x.deal.until > nowMs() ? "（交渉したお客さんが優先中）" : ""}</small>` : ""}
        <small class="ym-seller">出品：${esc(x.n)} ・${timeLeft(x.e - nowMs())}</small></div>
        <div class="ym-act">${x.mine ? `<span class="ym-small">自分の出品</span>` : x.au ? `<button type="button" class="ym-btn" data-bid="${esc(x.id)}" ${busy || S.paused ? "disabled" : ""}>入札する</button>${bidInfo[x.id] ? `<span class="ym-small">${bidInfo[x.id].top ? "最高額で入札中" : "追い越されました"}</span>` : ""}` : `<button type="button" class="ym-btn" data-buy="${esc(x.id)}" ${busy || S.paused ? "disabled" : ""}>買う</button>${x.dutch ? "" : !x.npc && my[x.id] ? `<span class="ym-small">依頼中 🪙${fmt(my[x.id])}</span>` : `<button type="button" class="ym-btn ym-sub" data-nego="${esc(x.id)}" ${busy || S.paused ? "disabled" : ""}>${x.npc ? "値下げ交渉" : "値下げ依頼"}</button>`}`}</div>
        ${negoOpen === x.id ? negoPanel(x) : ""}</div>`;
    }).join("") || `<div class="ym-card ym-msg">いま出品はありません</div>`}</div>
    <p class="ym-small">買ったあとのキャンセルはできません。買った確変台の枠は、また売ることはできません。</p>`;
  $("#ymSlot").addEventListener("change", (e) => { slotFilter = e.target.value; drawBuy(); });
  $("#ymSort").addEventListener("change", (e) => { sort = e.target.value; drawBuy(); });
  $("#ymReload").addEventListener("click", () => { note = null; refresh(); });
  root.querySelectorAll("[data-buy]").forEach((b) => b.addEventListener("click", () => buy(b.dataset.buy)));
  root.querySelectorAll("[data-nego]").forEach((b) => b.addEventListener("click", () => { negoOpen = negoOpen === b.dataset.nego ? null : b.dataset.nego; drawBuy(); }));
  root.querySelectorAll("[data-nsend]").forEach((b) => b.addEventListener("click", () => nego(b.dataset.nsend)));
  root.querySelectorAll("[data-bid]").forEach((b) => b.addEventListener("click", () => bid(b.dataset.bid)));
}
/* 出品できるもの：パーツ（martMine）＋確変枠・番くじ景品（martSellable。この画面を開いたときだけ読む） */
async function loadSell() {
  if (sellBusy) return; sellBusy = true; const my = token;
  try { const r = await api("martSellable"); if (my === token) { SELL = r; if (tab === "sell") drawSell(); } }
  catch (_) { if (my === token) { SELL = { slots: [], prizes: [], failed: true }; if (tab === "sell") drawSell(); } }
  sellBusy = false;
}
function drawSell() {
  if (!SELL) { $("#ymBody").innerHTML = `<div class="ym-card ym-msg">読み込み中…</div>`; loadSell(); return; }
  const rows = [
    ...SELL.slots.map((x) => ({ item: { k: "kaku", ...x }, ref: x.ref, send: { kind: "kaku", day: x.day, si: x.si }, extra: "（始まる10分前まで）" })),
    ...SELL.prizes.map((x) => ({ item: { k: "prize", ...x }, ref: x.ref, send: { kind: "prize", n: x.n }, extra: "" })),
    ...M.sellable.map((x) => ({ item: { k: "part", ...x }, ref: x.ref, send: { kind: "part", slot: x.slot, part: x.part }, extra: x.equipped ? "（いま付けている）" : "" }))
  ];
  $("#ymBody").innerHTML = `<div class="ym-card"><h3>出品するものを選ぶ</h3>
    <div class="ym-mode"><button type="button" class="ym-tab${sellMode === "fixed" ? " on" : ""}" data-mode="fixed">💰 値段を決めて売る</button><button type="button" class="ym-tab${sellMode === "auction" ? " on" : ""}" data-mode="auction">🔨 オークション</button>
      ${sellMode === "auction" ? `<select id="ymHours">${S.auctionHours.map((h) => `<option value="${h}"${sellHours === h ? " selected" : ""}>${h >= 24 ? `${h / 24}日` : `${h}時間`}</option>`).join("")}</select>` : ""}</div>
    ${sellMode === "auction" ? `<p class="ym-small">入力する金額は<b>開始価格</b>です。入札は5%以上ずつ上がり、終わりの5分前以降の入札で、終了が5分のびます。入札があると、取り下げられません。確変台の枠はオークションにできません。</p>` : ""}
    ${rows.length ? rows.map((r, i) => {
      const it = itemOf(r.item);
      return `<div class="ym-item ym-sellrow">${thumb(it)}<div class="ym-info"><b>${nameHtml(it)}</b>
        <small>${esc(it.sub)}${esc(r.extra)}</small><small>相場の目安 🪙 ${fmt(r.ref)}</small></div>
        <div class="ym-act"><input type="number" inputmode="numeric" min="1" step="1" class="ym-input" id="ymP${i}" placeholder="${fmt(r.ref)}" value="${sellMode === "auction" ? Math.max(1, Math.round(r.ref * 0.5)) : r.ref}"><button type="button" class="ym-btn" data-list="${i}" ${busy || S.paused || (sellMode === "auction" && r.item.k === "kaku") ? "disabled" : ""}>${sellMode === "auction" ? "オークションに出す" : "出品"}</button></div></div>`;
    }).join("") : `<div class="ym-msg">いま出品できるものがありません。消しバトのパーツを買う・確変台の枠に当たる・ゆう番くじで景品が当たると、ここから売れます。</div>`}
    <p class="ym-small">パーツと番くじの景品は、出品すると「預かり」になります（売れ残ったら、そのまま戻ります）。確変台の枠は、自分が当てた枠だけ、始まる10分前まで出品できます（買った枠は売れません）。出品は ${S.maxOpen} 件・3日間まで。値段の上限はありません。売れたら ${S.feePct}% の手数料が引かれます。${SELL.failed ? "<br>（確変台の枠・番くじの景品は読み込めませんでした。開きなおしてください）" : ""}</p></div>`;
  root.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => { sellMode = b.dataset.mode; drawSell(); }));
  $("#ymHours")?.addEventListener("change", (e) => { sellHours = Number(e.target.value); });
  root.querySelectorAll("[data-list]").forEach((b) => b.addEventListener("click", () => {
    const r = rows[Number(b.dataset.list)], price = Number($(`#ymP${b.dataset.list}`).value), auc = sellMode === "auction";
    if (!Number.isInteger(price) || price < 1) { setNote("値段は1以上の整数で入れてください", true); return; }
    const it = itemOf(r.item);
    if (!confirm(auc ? `「${it.name}」を、開始価格 🪙${fmt(price)}・${sellHours >= 24 ? `${sellHours / 24}日間` : `${sellHours}時間`}のオークションに出しますか？${r.item.k === "part" ? "\n（中古になって売られます）" : ""}\n入札があると取り下げられません。落札されたら手数料 ${S.feePct}% が引かれます。` : `「${it.name}」を 🪙${fmt(price)} で出品しますか？${r.item.k === "part" ? "\n（中古になって売られます）" : ""}\n売れると手数料 ${S.feePct}% が引かれます。`)) return;
    run(async () => { await api("martList", { ...r.send, price, ...(auc ? { auction: true, hours: sellHours } : {}) }); tab = "mine"; return auc ? "オークションに出しました" : "出品しました"; });
  }));
}
function drawMine() {
  const L = M.listings;
  $("#ymBody").innerHTML = `${L.length ? L.map((x) => {
    const it = itemOf(x);
    const offers = [...(x.npcOffer ? [{ u: "npc", n: x.npcOffer.n, q: x.npcOffer.q }] : []), ...x.offers];
    return `<div class="ym-card ym-mine"><div class="ym-item">${thumb(it)}<div class="ym-info"><b>${nameHtml(it)}</b>
      <small>${esc(it.sub)}</small><div class="ym-price">${x.au ? `<span class="ym-au">🔨 オークション</span> 現在 ` : ""}🪙 ${fmt(x.price)}</div>
      ${x.au ? `<small>開始価格 🪙 ${fmt(x.au.s)}　入札 ${x.au.nb}件${x.au.top ? `　最高：${esc(x.au.top)}` : ""}</small>` : ""}
      <small>${x.expired ? "期限切れ（取り下げてください）" : timeLeft(x.e - nowMs())}</small></div>
      <div class="ym-act"><button type="button" class="ym-btn ym-sub" data-cancel="${esc(x.id)}" ${busy || (x.au && x.au.nb > 0 && !x.expired) ? "disabled" : ""}>${x.au && x.au.nb > 0 && !x.expired ? "入札あり" : "取り下げる"}</button></div></div>
      ${offers.map((o) => `<div class="ym-offer"><span>💬 <b>${esc(o.n)}</b> さんが <b>🪙 ${fmt(o.q)}</b> で買いたいそうです（値下げ依頼）</span>
        <span><button type="button" class="ym-btn" data-ans="${esc(x.id)}" data-who="${esc(o.u)}" data-acc="1" ${busy ? "disabled" : ""}>受ける</button> <button type="button" class="ym-btn ym-sub" data-ans="${esc(x.id)}" data-who="${esc(o.u)}" data-acc="0" ${busy ? "disabled" : ""}>断る</button></span></div>`).join("")}</div>`;
  }).join("") : `<div class="ym-card ym-msg">出品中のものはありません</div>`}
    <div class="ym-card"><h3>最近の取引</h3>${M.done.length ? M.done.map((d) => {
      const name = keyName(d.i), me = deps.getUsername();
      const text = d.npc ? `${esc(d.b)} さんに売れました（手数料 ${fmt(d.fee)}）` : d.sn === me ? `${esc(d.bn || "")} さんに売れました（手数料 ${fmt(d.fee)}）` : `${esc(d.sn)} さんから買いました`;
      return `<div class="ym-log">${esc(name)}　🪙 ${fmt(d.q)}　<small>${text}</small></div>`;
    }).join("") : `<div class="ym-msg">まだ取引はありません</div>`}</div>`;
  root.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => { if (confirm("この出品を取り下げますか？（預かっているものは戻ります）")) run(async () => { await api("martCancel", { id: b.dataset.cancel }); return "取り下げました"; }); }));
  root.querySelectorAll("[data-ans]").forEach((b) => b.addEventListener("click", () => {
    const acc = b.dataset.acc === "1";
    run(async () => { const r = await api("martAnswer", { id: b.dataset.ans, who: b.dataset.who, accept: acc }); return acc ? `🪙 ${fmt(r.price)} で売れました！（手数料 ${fmt(r.fee)}）` : "断りました"; });
  }));
}
/* 取引の記録の「もの」の名前（part：枠:パーツ／kaku:日付:番号／prize:賞） */
function keyName(key) {
  const [a, b, c] = String(key).split(":");
  if (a === "kaku") return `🌈 確変台の枠 ${b} #${c}`;
  if (a === "prize") return PRIZE[b] || `${b}賞`;
  const p = partInfo(a, b); return p ? p.name : key;
}
function buy(id) {
  const x = S.listings.find((l) => l.id === id); if (!x) return;
  const it = itemOf(x);
  if (!confirm(`「${it.name}」${it.used ? "（中古）" : ""}を 🪙${fmt(x.price)} で買いますか？\n買ったあとのキャンセルはできません。${x.k === "kaku" ? "\n（買った枠は、また売ることはできません）" : ""}`)) return;
  run(async () => { await api("martBuy", { id }); return x.k === "kaku" ? "買いました！ゆうスロの確変台で、その時間に遊べます" : x.k === "prize" ? "買いました！ゆう番くじの「もちもの」に入ります" : `買いました！「${it.name}（中古）」は、消しバトのパーツから付けられます`; });
}
function bid(id) {
  const x = S.listings.find((l) => l.id === id); if (!x || !x.au) return;
  const v = prompt(`いくらで入札しますか？（🪙 ${fmt(x.au.min)} 以上）\n入札のときコインは引かれません。終わったとき、いちばん高い人が、自分の入札額を払います（払えないときは次の人へ）。`, String(x.au.min));
  if (v === null) return;
  const price = Number(v);
  if (!Number.isInteger(price)) { setNote("金額は整数で入れてください", true); return; }
  run(async () => { await api("martBid", { id, price }); return `🪙 ${fmt(price)} で入札しました。追い越されたら、もう一度入札できます`; });
}
/* 値下げの交渉・依頼の入力欄（カードの下に開く）。NPC には交渉（その場で返事）、人には依頼（出品者が受けたら売れる） */
function negoPanel(x) {
  const min = Math.ceil(x.price * 0.3), msg = negoMsg[x.id];
  return `<div class="ym-nego">
    <label>${x.npc ? `「${esc(x.n)}」に、いくらにしてほしいか伝えます。納得してくれたら、値段がその金額に変わります。` : `いくらなら買いますか？（🪙 ${fmt(min)}〜${fmt(x.price - 1)}）　出品者が受けると、その値段で買うことになります（24時間）。`}</label>
    <div class="ym-nrow"><input type="number" inputmode="numeric" id="ymN" class="ym-input" min="1" step="1" value="${Math.max(x.npc ? 1 : min, Math.floor(x.price * (x.npc ? 0.9 : 0.85)))}"><button type="button" class="ym-btn" data-nsend="${esc(x.id)}" ${busy ? "disabled" : ""}>${x.npc ? "この値段で交渉する" : "この値段で依頼する"}</button></div>
    ${msg ? `<div class="ym-nmsg ${msg.good ? "good" : ""}">${esc(msg.text)}</div>` : ""}</div>`;
}
async function nego(id) {
  const x = S.listings.find((l) => l.id === id); if (!x || busy) return;
  const price = Number($("#ymN").value);
  if (!Number.isInteger(price) || price < 1) { negoMsg[id] = { text: "値段は1以上の整数で入れてください" }; drawBuy(); return; }
  busy = true; const my = token; drawBuy();
  try {
    if (x.npc) {
      const r = await api("martNegotiate", { id, price });
      negoMsg[id] = r.accepted ? { good: true, text: `「${r.npc}」：いいでしょう！ 🪙${fmt(r.price)} にします。10分のあいだ、あなたが優先で買えます。` }
        : r.counter ? { text: `「${r.npc}」：うーん、その値段はちょっと…。🪙${fmt(r.counter)} ならどうでしょう？（あと${r.triesLeft}回）` }
        : r.limit ? { text: `「${r.npc}」：これ以上は、下げられないんです…。` }
        : r.near ? { text: `「${r.npc}」：うーん…もうちょっと上なら、考えますよ。（あと${r.triesLeft}回）` }
        : { text: `「${r.npc}」：それはさすがに安すぎます…！（あと${r.triesLeft}回）` };
      if (r.accepted) { negoOpen = null; note = { text: `🤝 ${r.npc}と交渉成立！ 🪙${fmt(r.price)} になりました。10分以内に「買う」を押してください`, bad: false }; }
    } else {
      await api("martOffer", { id, price });
      negoOpen = null; note = { text: "値下げ依頼を出しました。出品者が受けると売れます（24時間）", bad: false };
    }
  } catch (e) { negoMsg[id] = { text: (ERR[e && e.code] || "うまくいきませんでした。もう一度お試しください") + (e && e.code === "bad_price" && e.detail && e.detail.max ? `（🪙 ${fmt(e.detail.max)} 以下）` : "") }; }
  busy = false;
  if (my === token) await refresh(my);
}
function setNote(text, bad) { note = { text, bad }; draw(); }
async function run(fn) {
  if (busy) return;
  busy = true; const my = token;
  try { const text = await fn(); note = { text, bad: false }; }
  catch (e) { note = { text: (ERR[e && e.code] || "うまくいきませんでした。もう一度お試しください") + (e && e.code === "bid_too_low" && e.detail && e.detail.min ? `（🪙 ${fmt(e.detail.min)} 以上）` : ""), bad: true }; }
  busy = false;
  SELL = null;
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
  return `<h4>売れた記録（新しい順・印は目安。止めはしません）</h4>${d.log.slice(0, 60).map((e) => `<div class="ym-log${e.flags.length ? " flag" : ""}">${t(e.at)}　${esc(e.s)} → ${esc(e.b)}　${esc(keyName(e.i))}　🪙${fmt(e.q)}${e.ref ? `（相場 ${fmt(e.ref)}）` : ""}　${e.flags.map((f) => `<b>${esc(f)}</b>`).join(" ")}</div>`).join("") || "<div class='ym-msg'>まだありません</div>"}
    <h4>出品中（${d.listings.length}件）</h4>${d.listings.map((l) => `<div class="ym-log">${esc(l.seller)}　${esc(itemOf(l).name)}　🪙${fmt(l.price)}　<button type="button" class="ym-btn ym-sub" data-rm="${esc(l.id)}">取り下げさせる</button></div>`).join("")}`;
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
  .ym-img img, .ym-img .ym-art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .ym-info b { font-size: 14.5px; } .ym-info small { display: block; color: #777; font-size: 11.5px; line-height: 1.6; }
  .ym-used { background: #8a7a5a; color: #fff; border-radius: 6px; font-size: 10px; padding: 1px 5px; margin-left: 5px; vertical-align: 2px; }
  .ym-price { font-weight: 900; font-size: 16px; color: #d6361f; margin: 2px 0; } .ym-tag { font-style: normal; font-size: 10.5px; border-radius: 6px; padding: 1px 6px; margin-left: 4px; vertical-align: 2px; } .ym-tag.good { background: #dff7e6; color: #1b6b3a; } .ym-tag.high { background: #fde9d4; color: #9a4b00; }
  .ym-act { display: grid; gap: 5px; justify-items: stretch; min-width: 78px; }
  .ym-btn { border: none; border-radius: 10px; padding: 9px 12px; font-weight: 900; font-size: 13px; cursor: pointer; color: #fff; background: linear-gradient(135deg, #ff7a18, #ff4d6d); } .ym-btn[disabled] { opacity: .45; cursor: default; } .ym-sub { background: #eee; color: #444; }
  .ym-input { width: 96px; padding: 7px; border-radius: 9px; border: 1px solid #ccc; font-size: 14px; text-align: right; }
  .ym-sellrow { margin-bottom: 8px; }
  .ym-nego { grid-column: 1 / -1; background: #fff7e6; border-radius: 12px; padding: 10px; } .ym-nego label { display: block; font-size: 12.5px; line-height: 1.7; color: #555; margin-bottom: 6px; }
  .ym-nrow { display: flex; gap: 8px; align-items: center; } .ym-nrow .ym-input { flex: 0 0 110px; } .ym-nmsg { margin-top: 8px; font-size: 13px; font-weight: 800; line-height: 1.6; color: #a35a00; } .ym-nmsg.good { color: #1b6b3a; }
  .ym-deal { color: #1b6b3a; font-weight: 800; }
  .ym-mode { display: flex; gap: 6px; margin: 6px 0; flex-wrap: wrap; } .ym-mode .ym-tab { padding: 8px 6px; } .ym-mode select { padding: 8px; border-radius: 10px; border: 1px solid #ddd; background: #fff; }
  .ym-au { background: #2f4bd0; color: #fff; border-radius: 6px; font-size: 10.5px; padding: 1px 6px; vertical-align: 2px; }
  .ym-offer { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: space-between; background: #fff7e6; border-radius: 10px; padding: 8px 10px; margin-top: 8px; font-size: 13px; }
  .ym-log { font-size: 12.5px; padding: 6px 0; border-bottom: 1px solid #f0f0f0; line-height: 1.6; } .ym-log.flag { background: #fff3f0; } .ym-log b { color: #c0392b; font-size: 11px; }
  .ym-adminbox h4 { margin: 12px 0 4px; font-size: 13px; }
  @media (max-width: 420px) { .ym-item { grid-template-columns: 54px 1fr; } .ym-img { width: 54px; height: 54px; } .ym-act { grid-column: 1 / -1; grid-template-columns: 1fr 1fr; } }
  `;
  document.head.appendChild(st);
}
