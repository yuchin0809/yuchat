/* =========================================================
   🎊 ゆう番くじ売り場の画面（yuworld.js から呼ばれる）

   ・発売前（ふつうの人）：カウントダウンと、A賞・B賞・ラストワン賞のヒントだけ（くじの中身は発売日に発表）。
   ・発売後：300枚の一覧から自分で選んで買う。1人1日15枚まで。残りが101枚以上のあいだは先着、100枚以下になったら次の日から整理券制（完売まで毎朝 8:30 から先着で配る）。
   ・買ったあとは「券をめくる」演出（タップでめくる／スキップで全部いっぺんに）。景品は買った瞬間にサーバー（Worker）が決めていて、画面は見せるだけ。
   ・管理者だけ：発売前でも本物の売り場を「テスト」で見られる（コインは引かれず、結果もどこにも保存されない）。販売の一時停止・再開もできる。
   ・サーバーの書類（Firestore）には触れず、Worker の bankuji* アクションだけを呼ぶ。
========================================================= */

export const BANKUJI_SALE_MS = new Date("2026-10-26T08:00:00+09:00").getTime();

let ctx = null, st = null, timer = null, pollAt = 0, stylesDone = false;
let picks = new Set(), busy = false, note = "", playing = false;
const fmt = (n) => Number(n || 0).toLocaleString("ja-JP");
const pad = (n) => String(n).padStart(2, "0");
const $ = (s) => ctx && ctx.root.querySelector(s);

export function stopBankuji() {
  if (timer) { clearInterval(timer); timer = null; }
  document.querySelectorAll(".yb-mask").forEach((e) => e.remove());
  ctx = null; st = null; picks = new Set(); busy = false; playing = false;
}

/* 発売までの残り時間の表示。発売時刻を過ぎたら null */
export function bankujiRemain(nowMs) {
  const ms = BANKUJI_SALE_MS - nowMs;
  if (ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  return { days: Math.floor(s / 86400), hh: pad(Math.floor((s % 86400) / 3600)), mm: pad(Math.floor((s % 3600) / 60)), ss: pad(s % 60) };
}
const nowMs = () => (ctx && typeof ctx.now === "function" ? ctx.now() : Date.now());
const hhmm = (ms) => { const d = new Date(ms + 9 * 3600000); return `${d.getUTCHours()}:${pad(d.getUTCMinutes())}`; };
const mmdd = (ms) => { const d = new Date(ms + 9 * 3600000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const untilText = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };

/* ---------- 景品の見せ方 ---------- */
const ICON = { A: "🏢", B: "📈", C: "🌈", D: "🎫", E: "🛠️", F: "🎨", G: "📊", H: "🪙", L: "👑" };
const GEAR = { body: "本体", edge: "カバー", sole: "底", weight: "おもり" };
const COLOR = { gold: "金", silver: "銀", rainbow: "虹", blackgold: "黒金" };
const SHORT = { A: "会社を運営できる権利", C: "確変台の予約 3回", D: "確変台の予約 優先1回確定" };
/* 確変台の予約権の、残りの回数（C賞3回・D賞1回・ラストワン賞3回。使った分は引く） */
const TICKET_USES = { kaku3: 3, kaku1: 1, last: 3 };
const ticketLeft = (r) => Math.max(0, (TICKET_USES[r.kind] || 0) - Math.max(0, Math.floor(Number(r.used) || 0)));
function prizeLine(r) {
  const p = (st && st.prizes || []).find((x) => x.id === r.id) || {};
  const nm = r.name || p.name || (r.id === "L" ? "ラストワン賞" : `${r.id}賞`);
  if (r.id === "L") return `${ICON.L} ${nm}（伝説セット）　確変の予約 残り${ticketLeft(r)}回・全5社5株はゆう株に入っています`;
  if (r.kind === "stock") return `${ICON[r.id]} ${nm}　ゆう株 ${r.code} ${r.qty}株`;
  if (r.kind === "coin") return `${ICON[r.id]} ${nm}　ゆうコイン ${fmt(r.amount)}`;
  if (r.kind === "gear") return `${ICON[r.id]} ${nm}　消しバトの限定${GEAR[r.code] || "パーツ"}`;
  if (r.kind === "color") return `${ICON[r.id]} ${nm}　消しバトの限定カラー「${COLOR[r.code] || r.code}」`;
  if (r.kind === "company") return `${ICON.A} ${nm}　自分の会社を運営できる権利`;
  if (r.kind === "kaku3" || r.kind === "kaku1") return `${ICON[r.id]} ${nm}　${SHORT[r.id]}${r.until ? `（${mmdd(r.until)}まで）` : ""}　残り${ticketLeft(r)}回`;
  return `${ICON[r.id] || "🎁"} ${nm}`;
}
const RARE = new Set(["A", "L"]);

/* ---------- 画面 ---------- */
export function renderBankuji(c) {
  stopBankuji();
  ctx = c;
  injectStyles();
  ctx.root.innerHTML = `<div class="yb-head"><button type="button" class="yw-back" id="ybBack">← ゆうくじ売り場</button><h2>🎊 ゆう番くじ</h2></div><div class="yb-card">読み込み中…</div>`;
  $("#ybBack")?.addEventListener("click", back);
  timer = setInterval(tick, 1000);
  load();
}
function back() { const cb = ctx && ctx.onBack; stopBankuji(); if (cb) cb(); }

async function load() {
  if (!ctx) return;
  try { st = await ctx.api("bankujiStatus"); pollAt = Date.now(); }
  catch (_) { if (!st) { ctx.root.innerHTML = `<div class="yb-head"><button type="button" class="yw-back" id="ybBack">← ゆうくじ売り場</button><h2>🎊 ゆう番くじ</h2></div><div class="yb-card">読み込めませんでした。少し待って、もう一度開いてください。</div>`; $("#ybBack")?.addEventListener("click", back); } return; }
  if (!ctx) return;
  picks = new Set([...picks].filter((n) => st.sold && st.sold[n] !== "1"));
  draw();
}

const head = () => `<div class="yb-head"><button type="button" class="yw-back" id="ybBack">← ゆうくじ売り場</button><h2>🎊 ゆう番くじ</h2></div>`;

function draw() {
  if (!ctx || !st) return;
  const esc = ctx.esc;
  if (st.phase === "before" && !st.adminPreview) return drawTeaser();
  if (st.phase === "paused") {
    ctx.root.innerHTML = `${head()}<div class="yb-card yb-msg"><b>🚧 ただいま一時停止中です</b><p>しばらくお待ちください。</p></div>`;
    $("#ybBack")?.addEventListener("click", back);
    return;
  }
  const test = st.adminPreview === true;
  const canBuy = test || st.phase === "selling";
  const mine = st.mine || { tickets: 0, prizes: [] };
  const left = Math.max(0, (st.perDay || 15) - (st.todayCount || 0));
  const selN = picks.size;
  const admin = st.isTopAdmin ? `<div class="yw-admin"><span>管理者メニュー：ゆう番くじの販売 <b>${st.paused ? "一時停止中" : "販売中"}</b></span><button type="button" id="ybPause" class="yw-btn yw-btn-sub">${st.paused ? "再開する" : "一時停止する"}</button></div>` : "";
  const testBar = test ? `<div class="yb-test">🧪 管理者だけに先行公開中（テスト）。ここで「買う」を押しても、コインは引かれず、結果は保存されません。発売は ${mmdd(st.saleStartMs)} ${hhmm(st.saleStartMs)}。</div>` : "";
  ctx.root.innerHTML = `${head()}${admin}${testBar}
    <div class="yb-status">
      <div><small>1枚</small><b>${fmt(st.price)}<i>コイン</i></b></div>
      <div><small>残り</small><b id="ybRemain">${fmt(st.remaining)}<i>/ ${fmt(st.pool)}枚</i></b></div>
      <div><small>今日あと</small><b>${test ? st.perDay : left}<i>枚</i></b></div>
      <div><small>所持</small><b id="ybBal">${st.balance == null ? "－" : fmt(st.balance)}</b></div>
    </div>
    <div class="yb-bar"><span style="width:${Math.round(((st.pool - st.remaining) / st.pool) * 100)}%"></span></div>
    ${gateHtml(test)}
    <div class="yb-card"><h3>🎁 景品</h3>${(st.prizes || []).map((p) => `<div class="yb-pz${p.id === "L" ? " last" : ""}"><b>${ICON[p.id] || ""} ${esc(p.name)}</b><span>${esc(p.desc)}</span><em data-left="${p.id}">${leftText(p)}</em></div>`).join("")}
      <p class="yb-small">どの番号を選んでも、景品は箱の中の残りから公平に引かれます。景品は買った瞬間に決まります。</p></div>
    ${canBuy || st.phase === "soldout" ? `<div class="yb-card"><h3>🎟 券を選ぼう（${canBuy ? "タップで選択" : "完売"}）</h3>
      <div class="yb-grid" id="ybGrid">${gridHtml(canBuy)}</div></div>` : ""}
    ${mineHtml(mine)}
    ${canBuy ? `<div class="yb-actions" id="ybActions"><div class="yb-sel"><b id="ybSel">${selN}</b>枚 選択中 <small>（今日あと ${test ? st.perDay : left}枚）</small></div>
      <div class="yb-btns"><button type="button" class="yw-btn yw-btn-sub" id="ybRandom">残りの枠をおまかせで選ぶ</button><button type="button" class="yw-btn yw-btn-sub" id="ybClear">クリア</button>
      <button type="button" class="yb-buy" id="ybBuy">買う</button></div><div class="yb-note" id="ybNote">${esc(note)}</div></div>` : ""}`;
  $("#ybBack")?.addEventListener("click", back);
  $("#ybPause")?.addEventListener("click", togglePause);
  $("#ybApply")?.addEventListener("click", applyPass);
  $("#ybGrid")?.addEventListener("click", (ev) => { const b = ev.target.closest("[data-n]"); if (b) togglePick(Number(b.dataset.n)); });
  $("#ybRandom")?.addEventListener("click", fillRandom);
  $("#ybClear")?.addEventListener("click", () => { picks.clear(); refreshPicks(); });
  $("#ybBuy")?.addEventListener("click", buy);
  ctx.root.querySelectorAll("[data-use]").forEach((b) => b.addEventListener("click", () => useGear(Number(b.dataset.use))));
  refreshPicks();
  tick();
}

/* 景品の残り本数の表示（リアルタイム更新：数秒おきに、軽い更新 bankujiLeft で書き換える） */
function leftText(p) {
  const test = st.adminPreview === true, left = st.left ? Number(st.left[p.id]) : null;
  if (test || left == null || Number.isNaN(left)) return p.id === "L" ? "最後の1枚" : `${fmt(p.count)}本`;
  if (p.id === "L") return left > 0 ? "最後の1枚（まだ）" : "出ました";
  return left > 0 ? `残り ${fmt(left)}/${fmt(p.count)}本` : "完売";
}
function paintLight() {
  if (!ctx || !st) return;
  const rm = $("#ybRemain"); if (rm) rm.innerHTML = `${fmt(st.remaining)}<i>/ ${fmt(st.pool)}枚</i>`;
  const bar = ctx.root.querySelector(".yb-bar span"); if (bar) bar.style.width = `${Math.round(((st.pool - st.remaining) / st.pool) * 100)}%`;
  (st.prizes || []).forEach((p) => { const el = ctx.root.querySelector(`[data-left="${p.id}"]`); if (el) { el.textContent = leftText(p); el.classList.toggle("out", st.left && Number(st.left[p.id]) <= 0); } });
}
let lightAt = 0, lightBusy = false;
async function pollLight() {
  if (lightBusy) return; lightBusy = true; lightAt = Date.now();
  try {
    const r = await ctx.api("bankujiLeft");
    if (!ctx || !st || !r || !r.sold) return;
    const soldChanged = r.sold !== st.sold;
    st.left = r.left; st.remaining = r.remaining; st.sold = r.sold;
    paintLight();
    if (r.passLeft != null && st.pass && st.pass.state === "canApply") {   // 整理券の残り（先着で配っているあいだ）
      st.pass.left = r.passLeft; const el = $("#ybPassLeft"); if (el) el.textContent = fmt(r.passLeft);
      if (r.passLeft <= 0) { load(); return; }
    }
    if (soldChanged) {
      const had = picks.size;
      picks = new Set([...picks].filter((n) => st.sold[n] !== "1"));
      const grid = $("#ybGrid"); if (grid) { grid.innerHTML = gridHtml(st.phase === "selling"); refreshPicks(); }
      if (picks.size < had) setNote("選んだ券の一部が、先に売れてしまいました。");
    }
    if (r.done || (r.mode && r.mode !== st.mode) || (st.mode === "open" && st.phase === "selling" && st.remaining <= (r.stopRemaining || 0))) load();   // 完売・その日の販売の終わりは、全体を読み直す
  } catch (_) { /* 次の回にもう一度 */ }
  finally { lightBusy = false; }
}

function gateHtml(test) {
  const p = st.pass;
  if (test) return `<div class="yb-card yb-gate"><b>🧪 本番の流れ（テストなので何も起きません）</b><p>残りが101枚以上のあいだは、毎日先着で買えます。残りが100枚以下になると、その日の販売は終了。次の日からは、完売まで毎朝 8:30 から整理券を先着で配り、持っている人だけが買えます。</p></div>`;
  if (st.phase === "soldout") return `<div class="yb-card yb-gate"><b>🎉 完売しました！</b><p>ラストワン賞は ${st.lastOne ? `<b>${ctx.esc(st.lastOne.name)}</b> さん` : "出ました"}！</p></div>`;
  if (st.phase === "closedToday") return `<div class="yb-card yb-gate"><b>⏰ 今日の販売は終了しました</b><p>残りが100枚以下になったので、明日からは整理券制です。完売まで毎朝 8:30 から、整理券を先着で配ります（持っている人だけが、その日にくじを買えます）。</p></div>`;
  if (st.phase === "needPass" && p) {
    const passLeft = `<p>今日の整理券：先着 ${fmt(p.count)}枚（残り <b id="ybPassLeft">${fmt(p.left)}</b>枚）</p>`;
    if (p.state === "before") return `<div class="yb-card yb-gate"><b>🎫 整理券は ${hhmm(p.openMs)} から配ります</b><p>残りが100枚以下なので、整理券制です。${hhmm(p.openMs)} から先着で配ります。持っている人だけが、今日くじを買えます。</p>${passLeft}<div class="yb-count" id="ybGateCount" data-to="${p.openMs}"></div></div>`;
    if (p.state === "canApply") return `<div class="yb-card yb-gate"><b>🎫 整理券を配布中！（先着）</b>${passLeft}<button type="button" class="yb-buy" id="ybApply">整理券をもらう</button></div>`;
    return `<div class="yb-card yb-gate"><b>🎫 今日の整理券は配り終わりました</b><p>明日の ${hhmm(p.openMs)} から、また先着で配ります（完売するまで毎日）。</p></div>`;
  }
  if (st.mode === "pass" && p && p.state === "won") return `<div class="yb-card yb-gate yb-win"><b>🎉 整理券をもらいました！</b><p>今日の分（あと ${Math.max(0, st.perDay - st.todayCount)}枚）を買えます。</p></div>`;
  if (st.mode === "open") return `<div class="yb-card yb-gate"><b>🏃 いまは先着販売です</b><p>残りが100枚以下になると、その日の販売は終了します（次の日から、整理券制）。</p></div>`;
  return "";
}
function gridHtml(canBuy) {
  const sold = st.sold || "";
  let out = "";
  for (let n = 0; n < st.pool; n++) {
    const s = sold[n] === "1";
    out += `<button type="button" class="yb-t${s ? " sold" : ""}" data-n="${n}" ${s || !canBuy ? "disabled" : ""} aria-label="${n + 1}番">${s ? "×" : n + 1}</button>`;
  }
  return out;
}

function mineHtml(mine) {
  const list = mine.prizes || [];
  if (!list.length) return `<div class="yb-card"><h3>🎒 もちもの</h3><p class="yb-small">まだ景品はありません。くじを引くと、ここに入ります。</p></div>`;
  const usable = (r) => (r.kind === "gear" || r.kind === "color") && !(r.used > 0) && !st.adminPreview;   // E賞・F賞は、消しバトの持ちものに入れて使う
  const rows = list.slice().reverse().map((r) => `<div class="yb-own${RARE.has(r.id) ? " rare" : ""}">${ctx.esc(prizeLine(r))}${r.used > 0 ? "（使用済み）" : ""}${usable(r) ? ` <button type="button" class="yb-use" data-use="${Number(r.n)}">消しバトで使う</button>` : ""}</div>`).join("");
  const coin = list.filter((r) => r.kind === "coin").reduce((s, r) => s + (r.amount || 0), 0);
  const stock = list.filter((r) => r.kind === "stock").reduce((s, r) => s + (r.qty || 0), 0);
  return `<div class="yb-card"><h3>🎒 もちもの（${fmt(list.length)}枚ぶん）</h3>
    <p class="yb-small">コイン・ゆう株は、もう受け取っています（コイン ${fmt(coin)}／ゆう株 ${fmt(stock)}株）。確変台の予約権・会社の運営権・消しバトの限定品（E賞・F賞）は、「消しバトで使う」を押すと、消しバトの持ちものに入ります。確変台の予約権（C賞・D賞・ラストワン賞）は、ゆうスロの台の一覧の上にある「確変台チケット売り場」の「🎟 ゆう番くじのチケットを使う」から使えます。</p>${rows}</div>`;
}

function refreshPicks() {
  if (!ctx || !st) return;
  ctx.root.querySelectorAll("#ybGrid [data-n]").forEach((b) => b.classList.toggle("on", picks.has(Number(b.dataset.n))));
  const sel = $("#ybSel"); if (sel) sel.textContent = String(picks.size);
  const test = st.adminPreview === true;
  const cost = picks.size * st.price;
  const btn = $("#ybBuy");
  if (btn) { btn.disabled = busy || picks.size < 1; btn.textContent = picks.size ? `買う（${fmt(cost)}コイン）` : "券を選んでね"; }
}
function dayLeft() { return st.adminPreview ? st.perDay : Math.max(0, st.perDay - (st.todayCount || 0)); }
function togglePick(n) {
  if (!st || busy) return;
  if (picks.has(n)) picks.delete(n);
  else {
    if (picks.size >= dayLeft()) { setNote(`1日に買えるのは ${st.perDay}枚までです（今日あと ${dayLeft()}枚）。`); return; }
    picks.add(n);
  }
  setNote(""); refreshPicks();
}
function fillRandom() {
  if (!st || busy) return;
  const free = []; for (let i = 0; i < st.pool; i++) if (st.sold[i] !== "1" && !picks.has(i)) free.push(i);
  let need = Math.min(dayLeft() - picks.size, free.length);
  if (need <= 0) { setNote(dayLeft() <= 0 ? "今日はもう買えません。" : "選べる券がありません。"); return; }
  while (need-- > 0) { const k = Math.floor(Math.random() * free.length); picks.add(free[k]); free.splice(k, 1); }
  setNote(""); refreshPicks();
}
function setNote(t) { note = t; const el = $("#ybNote"); if (el) el.textContent = t; }

const ERR = {
  bad_count: "1回に買えるのは15枚までです。", daily_limit: "今日の購入上限（15枚）に達しています。", insufficient_coins: "コインが足りません。",
  closed_today: "今日の販売は終了しました（明日から整理券制）。", no_pass: "今日は整理券をもらっていないので買えません。", pass_pending: "整理券は 8:30 から配ります。お待ちください。",
  sold_out: "売り切れです。", paused: "ただいま一時停止中です。", busy: "混み合っています。もう一度「買う」を押してください。", not_started: "まだ発売前です。",
  not_enough: "残りの枚数が足りません。", taken: "選んだ券の一部が、先に売れてしまいました。選びなおしてください。", bad_request: "選んだ券を確認できませんでした。"
};

async function buy() {
  if (!st || busy || picks.size < 1) return;
  const list = [...picks].sort((a, b) => a - b), cost = list.length * st.price;
  const test = st.adminPreview === true;
  if (!test && !window.confirm(`${list.length}枚 × ${fmt(st.price)}コイン ＝ ${fmt(cost)}コインで買います。よろしいですか？`)) return;
  busy = true; refreshPicks(); setNote(test ? "テストで引いています…" : "買っています…");
  try {
    if (test) {
      const results = fakeResults(list);
      picks.clear(); busy = false; setNote(""); refreshPicks();
      await peel(results, { test: true });
      return;
    }
    const r = await ctx.api("bankujiBuy", { tickets: list });
    picks.clear(); busy = false; setNote("");
    await peel(r.results || [], { test: false, lastOne: r.lastOne });
    if (ctx) load();
  } catch (e) {
    busy = false;
    const code = e && (e.code || (e.detail && e.detail.error));
    if (code === "taken" || code === "busy" || code === "closed_today" || code === "sold_out" || code === "daily_limit") await load();
    setNote(ERR[code] || "うまく買えませんでした。もう一度ためしてください。");
    refreshPicks();
  }
}

/* E賞（限定改造品）・F賞（限定カラー）を、消しバトの持ちものに入れる。付けるのは、消しバトのショップ */
async function useGear(n) {
  if (busy) return;
  const rec = ((st && st.mine && st.mine.prizes) || []).find((r) => r.n === n);
  const what = rec ? prizeLine(rec).replace(/^\S+\s+/, "") : "この景品";
  if (!window.confirm(`${what} を、消しバトの持ちものに入れますか？（入れたあとは、消しバトのショップで付けられます）`)) return;
  busy = true;
  try {
    const r = await ctx.api("bankujiUse", { n });
    window.alert(`🎉 ${r.label} を、消しバトの持ちものに入れました！\n消しバトのショップで付けられます。`);
  } catch (e) {
    const code = e && (e.code || (e.detail && e.detail.error));
    window.alert(code === "already_have" ? "同じものをもう持っています。この景品は、ゆうマートで売れます。" : code === "used" ? "この景品は、もう使いました。" : code === "not_published" ? "消しバトは、まだ公開されていません。" : "うまくいきませんでした。もう一度お試しください。");
  }
  busy = false; load();
}
async function applyPass() {
  if (busy) return; busy = true;
  try { const r = await ctx.api("bankujiApply"); setNote(r && r.already ? "すでに整理券をもらっています。" : "整理券をもらいました！くじを買えます。"); }
  catch (e) { const code = e && (e.code || (e.detail && e.detail.error)); setNote(code === "passes_gone" ? "ごめんなさい、今日の整理券は配り終わりました。" : code === "apply_not_open" ? "整理券は 8:30 から配ります。" : code === "busy" ? "混み合っています。もう一度押してください。" : "もらえませんでした。"); }
  busy = false; load();
}
async function togglePause() {
  if (busy || !st) return; busy = true;
  try { await ctx.api("bankujiSetPaused", { paused: !st.paused }); } catch (_) { /* 何もしない */ }
  busy = false; load();
}

/* テスト用の作り物の結果（管理者だけ。サーバーの景品の本数に比例して引く。何も保存しない） */
function fakeResults(list) {
  const pool = [];
  (st.prizes || []).forEach((p) => { if (p.id !== "L") for (let i = 0; i < p.count; i++) pool.push(p.id); });
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  return list.map((n) => {
    const id = pool.length ? pool[Math.floor(Math.random() * pool.length)] : "H";
    const p = (st.prizes || []).find((x) => x.id === id) || {};
    const r = { n, id, name: p.name, kind: id === "A" ? "company" : id === "B" || id === "G" ? "stock" : id === "C" ? "kaku3" : id === "D" ? "kaku1" : id === "E" ? "gear" : id === "F" ? "color" : "coin" };
    if (r.kind === "stock") { r.code = pick(["YGM", "YMT", "YFD", "YEN", "YPY"]); r.qty = id === "B" ? 25 : 1 + Math.floor(Math.random() * 3); }
    if (r.kind === "coin") r.amount = 100;
    if (r.kind === "gear") r.code = pick(Object.keys(GEAR));
    if (r.kind === "color") r.code = pick(Object.keys(COLOR));
    return r;
  });
}

/* ---------- 券をめくる演出 ---------- */
let soundOn = (() => { try { return localStorage.getItem("yb_sound") !== "off"; } catch (_) { return true; } })();
function peel(results, opts = {}) {
  return new Promise((resolve) => {
    playing = true;
    const esc = ctx.esc, sfx = ctx.sfx || {};
    const tone = (n, vol, type, when) => { if (!soundOn) return; try { if (sfx.tone) sfx.tone(n, vol, type, when); } catch (_) { /* 音が出せなくても続ける */ } };
    const mask = document.createElement("div");
    mask.className = "yb-mask";
    mask.innerHTML = `<div class="yb-bg"></div>
      <div class="yb-pstage"><div class="yb-ptitle">${opts.test ? "🧪 テスト（保存されません）<br>" : ""}券をめくろう！ <span id="ybCnt">0</span>/${results.length}</div>
      <div class="yb-ptickets" id="ybTickets">${results.map((r, i) => `<button type="button" class="yb-tk" data-i="${i}" aria-label="券をめくる"><span class="yb-cover"><span class="yb-flap">▶</span><b>ゆう番くじ</b><small>タップしてめくる</small></span><span class="yb-prize${RARE.has(r.id) ? " rare" : ""} p${r.id}"><i>${ICON[r.id] || "🎁"}</i><b>${esc(r.id === "L" ? "ラストワン賞" : (r.name || `${r.id}賞`))}</b><small>${esc(prizeLine(r).replace(/^\S+\s+\S+\s*/, "") || "")}</small></span></button>`).join("")}</div>
      <div class="yb-pres" id="ybRes"></div></div>
      <button type="button" class="yb-snd" id="ybSnd" aria-label="音">${soundOn ? "🔊" : "🔇"}</button>
      <button type="button" class="yb-skip" id="ybSkip">スキップ ▶</button>`;
    document.body.appendChild(mask);
    const tks = [...mask.querySelectorAll(".yb-tk")];
    let opened = 0, done = false;
    const cnt = mask.querySelector("#ybCnt");
    const confetti = (n) => {
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const COL = ["#ff2d78", "#ff8a00", "#ffe14a", "#17e36a", "#17b6ff", "#b14cff"];
      for (let k = 0; k < n; k++) { const c = document.createElement("span"); c.className = "yb-conf"; c.style.left = Math.random() * 100 + "%"; c.style.background = COL[k % COL.length]; c.style.animationDelay = (Math.random() * 0.5).toFixed(2) + "s"; mask.appendChild(c); setTimeout(() => c.remove(), 3200); }
    };
    const openOne = (i, quick) => {
      const tk = tks[i];
      if (!tk || tk.classList.contains("open")) return;
      tk.classList.add("open"); opened++; cnt.textContent = String(opened);
      const r = results[i];
      if (!quick) {
        if (RARE.has(r.id)) { tone([523, 0.15], 0.07, "square"); tone([659, 0.15], 0.07, "square", 0.15); tone([784, 0.15], 0.07, "square", 0.3); tone([1047, 0.7], 0.08, "square", 0.45); confetti(90); mask.classList.add("flash"); setTimeout(() => mask.classList.remove("flash"), 900); }
        else if (r.id === "B" || r.id === "C") { tone([784, 0.15], 0.06, "triangle"); tone([988, 0.3], 0.06, "triangle", 0.12); confetti(30); }
        else tone([520 + (opened % 5) * 60, 0.08], 0.04, "triangle");
      }
      if (opened >= results.length) finish();
    };
    const finish = () => {
      if (done) return; done = true;
      mask.querySelector("#ybSkip").remove();
      const coin = results.filter((r) => r.kind === "coin").reduce((s, r) => s + (r.amount || 0), 0);
      const top = results.filter((r) => RARE.has(r.id));
      mask.querySelector("#ybRes").innerHTML = `<div class="yb-sum"><h3>${top.length ? "🎉 すごい！おめでとう！" : "結果"}</h3>
        ${results.slice().sort((a, b) => ("ABCDEFGHL".indexOf(a.id === "L" ? "A" : a.id)) - ("ABCDEFGHL".indexOf(b.id === "L" ? "A" : b.id))).map((r) => `<div class="yb-own${RARE.has(r.id) ? " rare" : ""}">${esc(prizeLine(r))}</div>`).join("")}
        <p class="yb-small">${opts.test ? "テストなので、何も受け取っていません。" : `コイン景品 ${fmt(coin)} とゆう株は、もう受け取りました。景品は「もちもの」にも入っています。`}</p>
        <button type="button" class="yb-buy" id="ybClose">とじる</button></div>`;
      if (top.length) { confetti(120); tone([523, 0.15], 0.07, "square"); tone([784, 0.15], 0.07, "square", 0.15); tone([1047, 0.5], 0.08, "square", 0.3); }
      mask.querySelector("#ybClose").addEventListener("click", close);
      mask.scrollTop = mask.scrollHeight;
    };
    const close = () => { mask.remove(); playing = false; resolve(); };
    tks.forEach((tk, i) => tk.addEventListener("click", () => openOne(i, false)));
    mask.querySelector("#ybSkip").addEventListener("click", () => { tks.forEach((_, i) => openOne(i, true)); });
    mask.querySelector("#ybSnd").addEventListener("click", (ev) => { soundOn = !soundOn; try { localStorage.setItem("yb_sound", soundOn ? "on" : "off"); } catch (_) { /* 何もしない */ } ev.currentTarget.textContent = soundOn ? "🔊" : "🔇"; });
    mask._cancel = close;
  });
}

/* ---------- 発売前のお知らせ（ふつうの人） ---------- */
function drawTeaser() {
  ctx.root.innerHTML = `${head()}
    <div class="yb-hero">
      <div class="yb-new">NEW</div>
      <div class="yb-title">ゆう番くじ<br>まもなく初登場！</div>
      <div class="yb-sale">発売：10月26日（月）8:00</div>
      <div class="yb-count" id="ybCount"></div>
      <div class="yb-lead">初回は、とくべつ豪華！<br>ひとあし先に、ちょっとだけ中身をおしえちゃいます👀</div>
    </div>
    <div class="yb-card"><h3>🎁 こんな賞があるよ（いまわかっているのは、ここまで）</h3>
      <div class="yb-prize yb-a"><b>A賞</b><span><em>✨ 自分の会社をもてる権利…！？</em><small>会社の名前をつけて、自分で会社を育てられる…らしい</small></span></div>
      <div class="yb-prize yb-b"><b>B賞</b><span><em>📈 ゆう株がもらえる</em><small>ゆう経済の株が、まとめて手に入る！</small></span></div>
      <div class="yb-prize yb-last"><b>ラストワン賞</b><span><em>👑 とてつもなく豪華なセット</em><small>最後の1枚を引いた人だけがもらえる、特別な賞</small></span></div>
      <div class="yb-prize yb-secret"><b>C賞〜</b><span><em>🔒 ひみつ…</em><small>当たってからのお楽しみ。ほかにもいろいろ入っています</small></span></div>
    </div>
    <div class="yb-card yb-note"><h3>📣 くわしいことは発売日に発表！</h3>
      <p>くじの引きかた・本数・値段は、発売日（月曜 8:00）にここで発表します。宝くじ売り場の宝くじと同じ時刻に発売の予定です。</p>
      <p class="yb-small">※中身は変わることがあります。</p></div>`;
  $("#ybBack")?.addEventListener("click", back);
  tick();
}

function tick() {
  if (!ctx) return;
  const el = $("#ybCount");
  if (el) {
    const r = bankujiRemain(nowMs());
    if (!r) { el.innerHTML = `<span class="yb-soon">🎉 まもなく発売！</span>`; if (st && st.phase === "before" && Date.now() - pollAt > 3000) load(); }
    else el.innerHTML = `<small>発売まで</small><span>${r.days > 0 ? `${r.days}<i>日</i> ` : ""}${r.hh}<i>:</i>${r.mm}<i>:</i>${r.ss}</span>`;
  }
  const g = $("#ybGateCount");
  if (g) {
    const to = Number(g.dataset.to) || 0, left = to - nowMs();
    g.textContent = left > 0 ? `あと ${untilText(left)}` : "時刻になりました…";
    if (left <= 0 && Date.now() - pollAt > 3000) load();
  }
  // 売れ行き・景品の残りは、軽い更新を5秒おきに（ほかの人が買った券を、ほぼリアルタイムで反映）。ユーザーの書類まで読む全体の更新は60秒おき。めくる演出・購入中・画面が見えないときは止める
  if (st && !busy && !playing && !document.hidden && !st.adminPreview) {
    if (st.phase !== "before" && Date.now() - pollAt > 60000) load();
    else if ((st.phase === "selling" || st.phase === "needPass" || st.phase === "closedToday") && Date.now() - lightAt > 5000) pollLight();
  }
}

function injectStyles() {
  if (stylesDone && document.getElementById("yubankuji-styles")) return;
  stylesDone = true;
  const css = `
  .yb-head { margin-bottom: 8px; } .yb-head h2 { margin: 4px 0 0; font-size: 20px; }
  .yb-hero { position: relative; overflow: hidden; text-align: center; color: #fff; border-radius: 18px; padding: 22px 14px 20px; margin: 10px 0 14px;
    background: linear-gradient(135deg, #7b2ff7, #ff2d78 55%, #ff8a00); box-shadow: 0 8px 26px rgba(123,47,247,.35); }
  .yb-hero::before { content: ""; position: absolute; left: 50%; top: 50%; width: 200%; aspect-ratio: 1; margin: -100% 0 0 -100%; opacity: .16; pointer-events: none;
    background: repeating-conic-gradient(from 0deg, #fff 0 8deg, transparent 8deg 24deg); animation: yb-spin 24s linear infinite; }
  @keyframes yb-spin { to { transform: rotate(360deg); } }
  .yb-hero > * { position: relative; }
  .yb-new { display: inline-block; background: #ffe14a; color: #7a3a00; font-weight: 900; font-size: 12px; letter-spacing: .1em; padding: 3px 12px; border-radius: 999px; animation: yb-pulse 1.4s ease-in-out infinite; }
  @keyframes yb-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.12); } }
  .yb-title { font-size: 30px; font-weight: 900; line-height: 1.3; margin: 10px 0 6px; text-shadow: 0 2px 10px rgba(0,0,0,.35), 0 0 16px rgba(255,225,74,.8); }
  .yb-sale { font-size: 15px; font-weight: 800; }
  .yb-count { margin: 12px auto 10px; display: inline-block; background: rgba(0,0,0,.3); border-radius: 14px; padding: 8px 18px; min-width: 200px; }
  .yb-hero .yb-count small { display: block; font-size: 12px; opacity: .9; }
  .yb-hero .yb-count span { font-size: 30px; font-weight: 900; font-variant-numeric: tabular-nums; color: #ffe14a; text-shadow: 0 0 12px rgba(255,225,74,.8); }
  .yb-count i { font-style: normal; font-size: 16px; margin: 0 2px; } .yb-count .yb-soon { font-size: 22px; }
  .yb-lead { font-size: 13.5px; line-height: 1.8; }
  .yb-card { background: #fff; border-radius: 16px; padding: 14px 14px 12px; margin: 12px 0; box-shadow: 0 4px 16px rgba(0,0,0,.07); }
  .yb-card h3 { margin: 0 0 10px; font-size: 15px; } .yb-msg { text-align: center; }
  .yb-small { font-size: 11.5px; color: #888; line-height: 1.7; margin: 8px 0 0; }
  .yb-prize { display: grid; grid-template-columns: 78px 1fr; gap: 10px; align-items: center; padding: 10px; border-radius: 12px; margin-bottom: 8px; border: 1px solid #eee; }
  .yb-prize b { text-align: center; font-size: 15px; font-weight: 900; padding: 8px 4px; border-radius: 10px; color: #fff; background: #7b2ff7; }
  .yb-prize em { display: block; font-style: normal; font-weight: 800; font-size: 14.5px; } .yb-prize small { display: block; color: #666; font-size: 12px; line-height: 1.6; margin-top: 2px; }
  .yb-a { background: linear-gradient(90deg, #fff7d6, #fff); border-color: #ffd24a; } .yb-a b { background: linear-gradient(135deg, #ffb300, #ff6a00); }
  .yb-b b { background: linear-gradient(135deg, #17b6ff, #4a6bff); }
  .yb-last { background: linear-gradient(90deg, #ffe9f2, #fff); border-color: #ff9bbd; } .yb-last b { background: linear-gradient(135deg, #ff2d78, #b14cff); font-size: 12.5px; }
  .yb-secret { background: #f5f4fa; } .yb-secret b { background: #8c86a8; } .yb-secret em { color: #5b5675; }
  .yb-note p { margin: 0 0 6px; font-size: 13px; line-height: 1.8; color: #444; }
  /* 売り場 */
  .yb-test { background: #fff3cd; border: 1px solid #ffe08a; color: #7a5b00; border-radius: 12px; padding: 10px 12px; font-size: 12.5px; line-height: 1.7; margin-bottom: 10px; }
  .yb-status { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; background: linear-gradient(135deg, #7b2ff7, #ff2d78); color: #fff; border-radius: 14px; padding: 10px 6px; text-align: center; }
  .yb-status small { display: block; font-size: 10.5px; opacity: .9; } .yb-status b { font-size: 17px; font-variant-numeric: tabular-nums; } .yb-status i { font-style: normal; font-size: 10px; margin-left: 2px; opacity: .9; }
  .yb-bar { height: 8px; border-radius: 999px; background: #eadfff; margin: 8px 0 4px; overflow: hidden; } .yb-bar span { display: block; height: 100%; background: linear-gradient(90deg, #ffb300, #ff2d78); }
  .yb-gate b { font-size: 15px; } .yb-gate p { margin: 6px 0 0; font-size: 13px; line-height: 1.8; color: #444; } .yb-win { border: 2px solid #ffd24a; background: #fffbe8; }
  .yb-gate .yb-count { background: #f0eaff; color: #5a2fc2; font-weight: 800; padding: 6px 12px; min-width: 0; margin: 8px 0 0; display: block; text-align: center; }
  .yb-pz { display: grid; grid-template-columns: 96px 1fr auto; gap: 8px; align-items: center; padding: 7px 0; border-bottom: 1px dashed #eee; font-size: 12.5px; } .yb-pz b { font-size: 13px; } .yb-pz span { color: #555; } .yb-pz em { font-style: normal; font-weight: 800; color: #7b2ff7; }
  .yb-pz em.out { color: #999; text-decoration: line-through; } .yb-pz.last { background: #fff0f6; border-radius: 8px; padding-left: 6px; }
  .yb-grid { display: grid; grid-template-columns: repeat(10, 1fr); gap: 4px; }
  .yb-t { padding: 0; aspect-ratio: 1; border-radius: 6px; border: 1px solid #e0c6c6; background: #e53a3a; color: #fff; font-size: 10.5px; font-weight: 800; cursor: pointer; font-variant-numeric: tabular-nums; }
  .yb-t.on { background: #ffd24a; color: #6a3a00; border-color: #ff8a00; box-shadow: 0 0 0 2px #ff8a00 inset; transform: scale(1.06); }
  .yb-t.sold { background: #d9d6df; color: #a29fae; border-color: #d9d6df; cursor: default; } .yb-t:disabled:not(.sold) { opacity: .55; }
  .yb-use { margin-left: 6px; border: none; border-radius: 999px; padding: 3px 10px; font-size: 12px; font-weight: 800; color: #3a2a00; background: linear-gradient(135deg,#ffd700,#ff9a00); cursor: pointer; }
  .yb-own { padding: 7px 10px; margin-top: 6px; border-radius: 10px; background: #f6f3ff; font-size: 13px; } .yb-own.rare { background: linear-gradient(90deg, #ffe9a8, #fff3d0); font-weight: 800; border: 1px solid #ffd24a; }
  .yb-actions { position: sticky; bottom: 8px; z-index: 5; background: rgba(255,255,255,.97); border-radius: 16px; padding: 10px 12px; box-shadow: 0 -4px 22px rgba(0,0,0,.18); margin-top: 10px; }
  .yb-sel { font-size: 14px; margin-bottom: 6px; } .yb-sel b { font-size: 20px; color: #7b2ff7; } .yb-btns { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .yb-buy { flex: 1; min-width: 150px; border: none; border-radius: 12px; padding: 12px 14px; font-size: 16px; font-weight: 900; color: #fff; cursor: pointer; background: linear-gradient(135deg, #ff8a00, #ff2d78); box-shadow: 0 4px 14px rgba(255,45,120,.4); }
  .yb-buy:disabled { opacity: .5; box-shadow: none; cursor: default; } .yb-note { font-size: 12px; color: #c0392b; min-height: 0; margin-top: 4px; }
  /* めくる演出 */
  .yb-mask { position: fixed; inset: 0; z-index: 2147483200; overflow-y: auto; color: #fff; -webkit-overflow-scrolling: touch; }
  .yb-bg { position: fixed; inset: 0; background: radial-gradient(ellipse at 50% 30%, #6a1b9a 0%, #2a0a4a 60%, #10031f 100%); transition: filter .4s; } .yb-mask.flash .yb-bg { filter: brightness(1.8) saturate(1.4); }
  .yb-pstage { position: relative; z-index: 2; max-width: 520px; margin: 0 auto; padding: 18px 12px 90px; text-align: center; }
  .yb-ptitle { font-size: 18px; font-weight: 900; margin-bottom: 12px; text-shadow: 0 0 12px #ff2d78; }
  .yb-ptickets { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .yb-tk { position: relative; aspect-ratio: 3 / 2; padding: 0; border: none; background: none; cursor: pointer; perspective: 600px; }
  .yb-cover { position: absolute; inset: 0; z-index: 2; border-radius: 10px; background: linear-gradient(135deg, #f04a3a, #c4231a); box-shadow: 0 3px 10px rgba(0,0,0,.4); display: flex; flex-direction: column; align-items: center; justify-content: center; color: #fff; transform-origin: left center; transition: transform .6s ease, opacity .6s; }
  .yb-cover b { font-size: 14px; font-weight: 900; text-shadow: 0 1px 4px rgba(0,0,0,.4); } .yb-cover small { font-size: 10px; opacity: .9; margin-top: 2px; }
  .yb-flap { position: absolute; left: 0; top: 0; bottom: 0; width: 22%; display: flex; align-items: center; justify-content: center; background: linear-gradient(90deg, rgba(255,255,255,.55), rgba(255,255,255,.1)); border-radius: 10px 60% 60% 10px / 10px 50% 50% 10px; color: #c4231a; font-size: 14px; }
  .yb-tk.open .yb-cover { transform: rotateY(-100deg); opacity: 0; pointer-events: none; }
  .yb-tk .yb-prize { position: absolute; inset: 0; border-radius: 10px; background: #fff; color: #333; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 4px; border: 0; grid-template-columns: none; gap: 0; }
  .yb-tk .yb-prize i { font-style: normal; font-size: 22px; line-height: 1; } .yb-tk .yb-prize b { font-size: 12px; background: none; color: #6a1b9a; padding: 2px 0 0; } .yb-tk .yb-prize small { font-size: 9.5px; color: #666; line-height: 1.3; margin: 0; max-height: 2.7em; overflow: hidden; }
  .yb-tk .yb-prize.rare { background: linear-gradient(135deg, #fff3b0, #ffd24a); box-shadow: 0 0 18px 4px #ffd24a; } .yb-tk.open .yb-prize { animation: yb-pop .45s cubic-bezier(.2,1.5,.4,1); }
  @keyframes yb-pop { from { transform: scale(.6); } to { transform: scale(1); } }
  .yb-sum { margin-top: 16px; background: rgba(255,255,255,.12); border-radius: 16px; padding: 14px; text-align: left; } .yb-sum h3 { margin: 0 0 8px; text-align: center; font-size: 18px; } .yb-sum .yb-own { color: #333; }
  .yb-sum .yb-small { color: #e6dcff; } .yb-sum .yb-buy { width: 100%; margin-top: 12px; }
  .yb-skip, .yb-snd { position: fixed; z-index: 9; border: 1px solid rgba(255,255,255,.5); background: rgba(0,0,0,.5); color: #fff; border-radius: 999px; cursor: pointer; }
  .yb-skip { right: 12px; bottom: 14px; padding: 9px 18px; font-size: 14px; font-weight: 800; } .yb-snd { left: 12px; bottom: 14px; width: 42px; height: 42px; font-size: 18px; }
  .yb-conf { position: fixed; top: -14px; z-index: 6; width: 9px; height: 14px; border-radius: 2px; pointer-events: none; animation: yb-fall 3s linear forwards; }
  @keyframes yb-fall { 0% { transform: translateY(-10px) rotate(0); opacity: 0; } 8% { opacity: 1; } 100% { transform: translateY(110vh) rotate(900deg); opacity: .9; } }
  @media (prefers-reduced-motion: reduce) { .yb-hero::before, .yb-new, .yb-conf, .yb-tk.open .yb-prize { animation: none; } .yb-cover { transition: none; } }
  `;
  const style = document.createElement("style");
  style.id = "yubankuji-styles";
  style.textContent = css;
  document.head.appendChild(style);
}
