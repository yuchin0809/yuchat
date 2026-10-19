/* =========================================================
   🎟 ゆう宝くじ売り場の画面（yuworld.js から呼ばれる）

   ・抽選・購入・賞金・公開/非公開の判定はすべて通知 Worker（/yuslot の lottery* アクション）が行う。
     ここは Worker が返した内容を表示して、購入ボタンを押したら Worker に頼むだけ。Firebase には直接触れない。
   ・毎週金曜 14:30（日本時間）に抽選。名前・賞金は毎週変わり、6週に1回ビッグイベント（Worker が決める）。
   ・券には番号（30組×100番＝全3,000通り）が付く。買い方は「連番」（同じ組の続き番号）か「バラ」（ランダム）。番号の割り当て・当選番号・
     前後賞（1等の前後の番号）はすべて Worker が決める。1等は全体で1本。確率は Worker が返した値から計算して表示。
   ・結果発表は「抽選会ショー」（yulotteryshow.js）。ブラウザ内の演出だけで、Worker が確定した結果を見せる。
     14:30 に売り場を開いていれば、結果が出た瞬間に自動で始まる。あとから開いたときは、買った回（または当選した回）の結果を初めて見るとき
     に1回だけ自動で流れる（見た・買ったは端末内 localStorage に保存。Firebase には保存しない）。「もう一度見る」ボタンでいつでも再生できる。
========================================================= */
import { playLotteryShow, stopLotteryShow } from "./yulotteryshow.js?v=20261019-show1";

let ctx = null;          // { root, api, esc, sfx, onBack }
let st = null;           // 直近の lotteryStatus
let timer = null;
let busy = false;
let buyCount = 1;
let buyMode = "seq";    // "seq"＝連番 / "random"＝バラ
let lastBought = "";    // 直前に買った番号の表示（買い直したら消える）
let offset = 0;          // serverNowMs - Date.now()
let lastLoadAt = 0;
let stylesDone = false;
const shownShow = new Set();   // この画面を開いている間に、もう流した回
let waiting = null;            // 抽選待ち中 { id: 回ID, until: 待つ期限(ms) }（時刻を過ぎたら、結果が出るまで短い間隔で確かめる）
let active = false;            // この画面を開いている間だけ true
let playing = false;

const fmt = (n) => Number(n || 0).toLocaleString("ja-JP");
const DAYS = ["日", "月", "火", "水", "木", "金", "土"];
const reduced = () => { try { return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; } };
const $ = (s) => ctx && ctx.root.querySelector(s);
const nowMs = () => Date.now() + offset;
function fmtDraw(ms) {
  const d = new Date(ms + 9 * 3600000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${DAYS[d.getUTCDay()]}) ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
/* 番号（0〜2999）の表示：01組000番 */
const fmtNo = (n) => `${String(Math.floor(n / 100) + 1).padStart(2, "0")}組${String(n % 100).padStart(3, "0")}番`;
/* 番号の並びを、続き番号はまとめて表示（例：12組045〜054番）。組をまたぐ連続は別々に表す */
function fmtNumbers(list) {
  const a = [...(list || [])].sort((x, y) => x - y), out = [];
  for (let i = 0; i < a.length;) {
    let j = i;
    while (j + 1 < a.length && a[j + 1] === a[j] + 1 && Math.floor(a[j + 1] / 100) === Math.floor(a[i] / 100)) j++;
    out.push(j === i ? fmtNo(a[i]) : `${fmtNo(a[i]).slice(0, -1)}〜${String(a[j] % 100).padStart(3, "0")}番`);
    i = j + 1;
  }
  return out.join("、");
}
function fmtRemain(ms) {
  if (ms <= 0) return "00:00:00";
  const s = Math.floor(ms / 1000), day = Math.floor(s / 86400);
  const hh = `${String(Math.floor((s % 86400) / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return day > 0 ? `${day}日 ${hh}` : hh;
}

export function stopLottery() {
  if (timer) { clearInterval(timer); timer = null; }
  busy = false;
  waiting = null;
  active = false;
  stopLotteryShow(); // 抽選会ショーは画面全体を覆う（body 直下）ので、離れるときに消す
}

export function renderLottery(c) {
  ctx = c;
  active = true;
  lastBought = "";
  injectStyles();
  ctx.root.innerHTML = `<div class="yl-head"><button type="button" class="yw-back" id="ylBack">← お店の一覧</button><h2>🎟 ゆう宝くじ売り場</h2></div><div class="yl-card yl-msg">読み込み中…</div>`;
  $("#ylBack")?.addEventListener("click", () => { stopLottery(); ctx.onBack(); });
  return load();
}

async function load() {
  try { st = await ctx.api("lotteryStatus"); }
  catch (_) { renderError(); return; }
  offset = (st.serverNowMs || Date.now()) - Date.now();
  lastLoadAt = Date.now();
  buyCount = clampBuy(buyCount);
  draw();
  startTimer();
  maybeReveal();
}

function renderError() {
  ctx.root.innerHTML = `<div class="yl-head"><button type="button" class="yw-back" id="ylBack">← お店の一覧</button><h2>🎟 ゆう宝くじ売り場</h2></div>
    <div class="yl-card yl-msg"><b>読み込みに失敗しました</b><p>通信環境をご確認のうえ、もう一度お試しください。</p><button type="button" class="yw-btn" id="ylRetry">もう一度</button></div>`;
  $("#ylBack")?.addEventListener("click", () => { stopLottery(); ctx.onBack(); });
  $("#ylRetry")?.addEventListener("click", load);
}

/* 1回に買える最大枚数（1回の上限・この回の上限・所持コイン） */
function maxBuyable() {
  if (!st || !st.event) return 0;
  const byRound = (st.limits?.maxPerRound || 0) - (st.myTickets || 0);
  const byCoins = st.balance == null ? Infinity : Math.floor(st.balance / st.event.price);
  const byStock = st.remaining == null ? Infinity : st.remaining;
  return Math.max(0, Math.min(st.limits?.maxPerBuy || 0, byRound, byCoins, byStock));
}
function clampBuy(n) { const m = maxBuyable(); return m < 1 ? 0 : Math.max(1, Math.min(m, Math.floor(n) || 1)); }

function draw() {
  const head = `<div class="yl-head"><button type="button" class="yw-back" id="ylBack">← お店の一覧</button><h2>🎟 ゆう宝くじ売り場</h2></div>`;
  if (!st.published && !st.isTopAdmin) {
    ctx.root.innerHTML = `${head}<div class="yl-card yl-msg"><b>🚧 現在準備中です</b><p>宝くじ売り場はまだ公開されていません。公開までもうしばらくお待ちください。</p></div>`;
    $("#ylBack")?.addEventListener("click", () => { stopLottery(); ctx.onBack(); });
    return;
  }
  const e = st.event, esc = ctx.esc;
  const admin = st.isTopAdmin ? `<div class="yw-admin"><span>管理者メニュー：宝くじ売り場の公開状態 <b>${st.published ? "公開中" : "非公開（準備中）"}</b></span>
      <button type="button" id="ylToggle" class="yw-btn yw-btn-sub">${st.published ? "非公開にする" : "公開する"}</button></div>` : "";
  const medals = { "1等": "🥇", "前後賞": "🎀", "2等": "🥈", "3等": "🥉" };
  const pool = st.pool || 3000;
  const pct = (n) => { const v = (n / pool) * 100; return (v >= 1 ? String(Math.round(v * 10) / 10) : String(Math.round(v * 100) / 100)) + "%"; };
  const tiers = (st.tiers || []).map((t) => `<div class="yl-tier"><span>${medals[t.name] || "🎖"} ${esc(t.name)}</span><span class="yl-tier-n">${t.count}本・1枚 ${pct(t.count)}</span><b>${fmt(t.prize)} <small>コイン</small></b></div>`).join("");
  const top = (st.tiers || [])[0];
  const last = st.last ? `<div class="yl-card yl-last"><h3>📣 前回の結果：${esc(st.last.name)}</h3>
      <p class="yl-sub">販売 ${fmt(st.last.tickets)} 枚 ／ 当選 ${fmt(st.last.winnerCount || 0)} 口 ／ 賞金 ${fmt(st.last.paid || 0)} コイン</p>
      <button type="button" class="yw-btn yl-replay" id="ylReplay">🎬 抽選会をもう一度見る</button>
      ${(st.last.numbers || []).map((w) => `<div class="yl-winner"><span>${esc(w.tier)}</span><span>${fmtNo(w.number)}　${w.name ? esc(w.name) + " さん" : "<small>（売れ残り）</small>"}</span></div>`).join("")}
      ${(st.last.myWins || []).length ? `<div class="yl-mywin">🎉 あなたの当選：${st.last.myWins.map((w) => `${esc(w.tier)} ${fmtNo(w.number)}（+${fmt(w.amount)}）`).join("、")}<br>合計 ${fmt(st.last.myWin)} コイン</div>` : ""}</div>` : "";
  const mineNums = (st.myNumbers || []).length ? `<details class="yl-nums"><summary>あなたの番号を見る（${fmt(st.myNumbers.length)}枚）</summary><p>${esc(fmtNumbers(st.myNumbers))}</p></details>` : "";
  ctx.root.innerHTML = `${head}${admin}
    <div class="yl-banner ${e.big ? "big" : ""}">
      ${e.big ? `<div class="yl-bigbadge">🌟 ビッグイベント 🌟</div>` : ""}
      <div class="yl-name">${esc(e.name)}</div>
      <div class="yl-draw">抽選：${fmtDraw(e.drawMs)}（毎週金曜 14:30）</div>
      <div class="yl-count" id="ylCount"></div>
      <div class="yl-pot-label">1等 賞金（全体で1本）</div>
      <div class="yl-pot"><span id="ylPot">${fmt(top ? top.prize : 0)}</span><small>コイン</small></div>
      <div class="yl-carry">1枚 ${e.price} コイン ／ 全${fmt(pool)}枚（残り ${fmt(st.remaining ?? pool)} 枚）</div>
    </div>
    <div class="yl-card"><h3>🏆 賞金</h3>${tiers}<p class="yl-sub">番号は 30組×100番（全${fmt(pool)}通り）。抽選で決まった当選番号と同じ番号の券が当たりです。1等は全体で1本だけ。「前後賞」は1等の前後の番号なので、連番で買うと1等と一緒に当たることも！7等は元返しです。</p></div>
    <div class="yl-card yl-buy">
      <div class="yl-mine">あなたの宝くじ <b>${fmt(st.myTickets)}枚</b>（この回は最大 ${fmt(st.limits?.maxPerRound)} 枚まで）${st.balance == null ? "" : ` ／ 所持 💰 ${fmt(st.balance)}`}</div>
      <div class="yl-modes"><button type="button" class="yl-mode ${buyMode === "seq" ? "on" : ""}" data-mode="seq">連番<small>同じ組の続き番号</small></button><button type="button" class="yl-mode ${buyMode === "random" ? "on" : ""}" data-mode="random">バラ<small>ランダムな番号</small></button></div>
      <div class="yl-stepper"><button type="button" class="yw-ctl" id="ylMinus" aria-label="へらす">－</button><span class="yl-n" id="ylN">0</span><button type="button" class="yw-ctl" id="ylPlus" aria-label="ふやす">＋</button></div>
      <div class="yl-quick">${[1, 5, 10].map((n) => `<button type="button" class="yw-ctl" data-q="${n}">${n}枚</button>`).join("")}<button type="button" class="yw-ctl" data-q="max">最大</button></div>
      <button type="button" class="yl-buybtn" id="ylBuy">買う</button>
      <div class="yl-note" id="ylNote"></div>
      <div class="yl-toast ${lastBought ? "on" : ""}" id="ylToast">${esc(lastBought)}</div>
      ${mineNums}
    </div>
    ${last}`;
  $("#ylBack")?.addEventListener("click", () => { stopLottery(); ctx.onBack(); });
  $("#ylToggle")?.addEventListener("click", togglePublished);
  $("#ylMinus")?.addEventListener("click", () => { buyCount = clampBuy(buyCount - 1); updateBuyUi(); });
  $("#ylPlus")?.addEventListener("click", () => { buyCount = clampBuy(buyCount + 1); updateBuyUi(); });
  ctx.root.querySelectorAll("[data-q]").forEach((b) => b.addEventListener("click", () => { const q = b.getAttribute("data-q"); buyCount = clampBuy(q === "max" ? maxBuyable() : Number(q)); updateBuyUi(); }));
  ctx.root.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    buyMode = b.getAttribute("data-mode");
    ctx.root.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x.getAttribute("data-mode") === buyMode));
  }));
  $("#ylBuy")?.addEventListener("click", buy);
  $("#ylReplay")?.addEventListener("click", () => startShow(st.last));
  updateBuyUi();
  tick();
}

function updateBuyUi() {
  const n = $("#ylN"), btn = $("#ylBuy"), note = $("#ylNote");
  if (!n || !btn || !st?.event) return;
  const cost = buyCount * st.event.price;
  n.textContent = buyCount;
  const open = st.open && nowMs() < st.event.closeMs;
  const can = open && buyCount >= 1 && !busy;
  btn.disabled = !can;
  btn.textContent = buyCount >= 1 ? `買う（${fmt(cost)}コイン）` : "買えません";
  let msg = `1枚 ${st.event.price} コイン。抽選の5分前に締め切ります。`;
  if (!open) msg = "⏰ 今回の販売は締め切りました。次の回は抽選後に発売します。";
  else if (maxBuyable() < 1) msg = (st.limits?.maxPerRound || 0) - (st.myTickets || 0) < 1 ? "この回に持てる枚数の上限に達しました。" : "コインが足りません。";
  if (note) note.textContent = msg;
}

function tick() {
  const el = $("#ylCount");
  if (!el || !st?.event) return;
  const e = st.event, now = nowMs();
  if (now < e.closeMs) el.textContent = `販売締切まで ${fmtRemain(e.closeMs - now)}`;
  else if (now < e.drawMs) el.textContent = `締切済み・抽選まで ${fmtRemain(e.drawMs - now)}`;
  else el.textContent = "🥁 抽選中…まもなく結果発表！";
  if (st.open && now >= e.closeMs) { st.open = false; updateBuyUi(); }
}
function startTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    tick();
    // 抽選時刻を過ぎたら、結果が出るまで6秒おきに読み直す（抽選は通常1分以内に終わる。5分たっても出なければ待つのをやめる）
    if (!st?.event || playing || busy) return;
    if (!waiting && nowMs() >= st.event.drawMs) waiting = { id: st.event.id, until: st.event.drawMs + 5 * 60000 };
    if (waiting && nowMs() > waiting.until) waiting = null;
    if (waiting && Date.now() - lastLoadAt > 6000) load();
  }, 1000);
}

async function togglePublished() {
  const next = !st.published;
  if (!confirm(next ? "宝くじ売り場を公開しますか？（一般ユーザーも買えるようになります）" : "宝くじ売り場を非公開にしますか？（一般ユーザーは使えなくなります）")) return;
  try { await ctx.api("lotterySetPublished", { published: next }); await load(); }
  catch (e) { alert("変更できませんでした（" + (e.code || "エラー") + "）"); }
}

const ERRORS = {
  sales_closed: "販売は抽選の5分前に締め切りました。次の回をお楽しみに！",
  sold_out: "売り切れです（この回の番号は全部売れました）。",
  no_consecutive: "その枚数の連番はもう取れません。枚数を減らすか、「バラ」で買ってください。",
  seated: "ゆうスロに着席中は買えません。先に「やめる」で退出してね。",
  insufficient_coins: "コインが足りません。",
  busy: "混み合っています。もう一度お試しください。",
  not_published: "ただいま準備中です。",
  bad_count: "枚数が正しくありません。"
};
async function buy() {
  if (busy || !st?.event || buyCount < 1) return;
  const cost = buyCount * st.event.price;
  if (cost >= 500 && !confirm(`${buyCount}枚（${fmt(cost)}コイン）で購入しますか？`)) return;
  busy = true; updateBuyUi();
  let msg = "";
  try {
    const r = await ctx.api("lotteryBuy", { count: buyCount, mode: buyMode });
    msg = `🎟 ${buyCount}枚 購入しました！ あなたの番号：${fmtNumbers(r && r.numbers)}`;
    markBought(st.event.id);
    if (ctx.sfx && ctx.sfx.buy) ctx.sfx.buy();
    if (!reduced()) confetti(14);
  } catch (e) {
    msg = e.code === "sold_out" && e.detail?.remaining > 0 ? `売り切れ間近です（残り ${e.detail.remaining} 枚）。` : e.code === "limit_reached" ? `この回に持てるのは最大 ${st.limits?.maxPerRound} 枚までです（あと ${e.detail?.remaining ?? 0} 枚）。` : (ERRORS[e.code] || `購入できませんでした（${e.code || "エラー"}）`);
  }
  busy = false;
  lastBought = msg;
  await load();             // 残高・枚数・番号を最新に（メッセージは再描画後も残す）
}

/* 抽選会ショーを流す条件：
   ・14:30 に開いていて、待っていた回の結果が出たとき → 自動で流す
   ・あとから開いたとき → その回を買った（または当選した）人が、初めて見るときだけ自動で流す。それ以外は「見る」ボタン */
function maybeReveal() {
  const l = st && st.last;
  if (!l || playing) return;
  const live = !!waiting && l.id === waiting.id;
  if (live) waiting = null;
  if (shownShow.has(l.id)) return;
  const bought = hasBought(l.id) || l.myWin > 0;
  if (!live && !bought) return;
  let seen = false;
  try { seen = !!localStorage.getItem("yl_seen_" + l.id); } catch (_) { /* 保存できなくても、この画面を開いている間は1回だけ */ }
  if (seen && !live) return;
  shownShow.add(l.id);
  try { localStorage.setItem("yl_seen_" + l.id, "1"); } catch (_) { /* 何もしない */ }
  startShow(l);
}
function hasBought(id) { try { return !!localStorage.getItem("yl_bought_" + id); } catch (_) { return false; } }
function markBought(id) { try { localStorage.setItem("yl_bought_" + id, "1"); } catch (_) { /* 何もしない */ } }
async function startShow(l) {
  if (playing) return;
  playing = true;
  try { await playLotteryShow(ctx, l, { bought: hasBought(l.id) || l.myWin > 0 }); }
  catch (_) { /* 演出に失敗しても売り場は使える */ }
  playing = false;
  if (active && ctx && st) load();   // 残高（賞金）を最新に（途中で売り場を離れていたら何もしない）
}

const COLORS = ["#ff2d78", "#ff8a00", "#ffe14a", "#17e36a", "#17b6ff", "#b14cff", "#ffffff"];
function confetti(n, host) {
  const box = host || $(".yl-banner") || ctx.root;
  for (let k = 0; k < n; k++) {
    const c = document.createElement("span");
    c.className = "yl-confetti";
    c.style.left = Math.random() * 100 + "%";
    c.style.background = COLORS[k % COLORS.length];
    c.style.animationDelay = (Math.random() * 0.5).toFixed(2) + "s";
    box.appendChild(c);
    setTimeout(() => c.remove(), 2400);
  }
}

function injectStyles() {
  if (stylesDone) return; stylesDone = true;
  const css = `
  .yl-head h2 { margin: 6px 0 4px; font-size: 20px; }
  .yl-card { background: #fff; border-radius: 14px; padding: 14px 16px; margin: 12px 0; box-shadow: 0 4px 16px rgba(0,0,0,.07); }
  .yl-card h3 { margin: 0 0 8px; font-size: 15px; }
  .yl-msg { text-align: center; padding: 26px 16px; } .yl-msg p { color: #666; line-height: 1.8; margin: 8px 0 12px; }
  .yl-sub { color: #777; font-size: 12px; line-height: 1.7; margin: 8px 0 0; }
  .yl-banner { position: relative; overflow: hidden; text-align: center; color: #fff; border-radius: 18px; padding: 20px 14px 18px; margin: 12px 0;
    background: linear-gradient(135deg,#7b2ff7,#f107a3 55%,#ff8a00); box-shadow: 0 8px 26px rgba(160,40,200,.35); }
  .yl-banner.big { background: linear-gradient(120deg,#ff2d78,#ff8a00,#ffe14a,#17e36a,#17b6ff,#b14cff,#ff2d78); background-size: 300% 100%; animation: yl-rainbow 4s linear infinite; box-shadow: 0 10px 34px rgba(255,160,0,.5); }
  @keyframes yl-rainbow { from { background-position: 0% 50%; } to { background-position: 300% 50%; } }
  .yl-bigbadge { display: inline-block; background: #fff; color: #d4143c; font-weight: 900; border-radius: 999px; padding: 3px 14px; font-size: 13px; margin-bottom: 8px; animation: yl-pulse 1s ease-in-out infinite; }
  @keyframes yl-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.08); } }
  .yl-name { font-size: 22px; font-weight: 900; text-shadow: 0 2px 6px rgba(0,0,0,.35); }
  .yl-banner.big .yl-name { font-size: 25px; }
  .yl-draw { font-size: 13px; opacity: .95; margin-top: 4px; }
  .yl-count { display: inline-block; margin-top: 8px; background: rgba(0,0,0,.3); border-radius: 10px; padding: 4px 12px; font-weight: 800; font-variant-numeric: tabular-nums; }
  .yl-pot-label { margin-top: 12px; font-size: 12px; opacity: .9; }
  .yl-pot { font-size: 40px; font-weight: 900; line-height: 1.1; text-shadow: 0 0 14px rgba(255,230,120,.9), 0 3px 8px rgba(0,0,0,.35); font-variant-numeric: tabular-nums; }
  .yl-banner.big .yl-pot { font-size: 46px; }
  .yl-pot small { font-size: 14px; margin-left: 4px; }
  .yl-carry { font-size: 12px; margin-top: 4px; opacity: .95; }
  .yl-tier { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; align-items: center; padding: 7px 0; border-bottom: 1px dashed #e3e3ea; font-size: 14px; }
  .yl-tier:last-of-type { border-bottom: none; } .yl-tier-n { color: #888; font-size: 12px; } .yl-tier b small { font-size: 11px; font-weight: 600; }
  .yl-modes { display: flex; gap: 8px; margin: 10px 0 2px; }
  .yl-mode { flex: 1; border: 2px solid #d9d9e3; background: #f7f7fb; border-radius: 12px; padding: 8px 6px; font-size: 16px; font-weight: 900; color: #556; cursor: pointer; line-height: 1.3; }
  .yl-mode small { display: block; font-size: 10px; font-weight: 600; color: #889; }
  .yl-mode.on { border-color: #ff9a00; background: #fff6dc; color: #8a5a00; }
  .yl-nums { margin-top: 10px; font-size: 13px; color: #445; } .yl-nums summary { cursor: pointer; font-weight: 700; } .yl-nums p { line-height: 1.9; margin: 6px 0 0; word-break: break-all; }
  .yl-mine { font-size: 13px; color: #445; line-height: 1.7; }
  .yl-stepper { display: flex; align-items: center; justify-content: center; gap: 16px; margin: 10px 0 6px; }
  .yl-n { min-width: 70px; text-align: center; font-size: 34px; font-weight: 900; font-variant-numeric: tabular-nums; }
  .yl-quick { display: flex; justify-content: center; gap: 8px; margin-bottom: 10px; }
  .yl-buybtn { width: 100%; border: none; border-radius: 12px; padding: 14px; font-size: 17px; font-weight: 900; color: #3a2a00; cursor: pointer;
    background: linear-gradient(135deg,#ffd700,#ff9a00); box-shadow: 0 4px 14px rgba(255,160,0,.45); }
  .yl-buybtn:disabled { background: #cfcfd6; color: #888; box-shadow: none; cursor: default; }
  .yl-note { text-align: center; font-size: 12px; color: #777; margin-top: 8px; line-height: 1.6; }
  .yl-toast { display: none; text-align: center; margin-top: 8px; padding: 8px 10px; border-radius: 10px; background: #fff6d6; color: #8a5a00; font-weight: 700; font-size: 13px; }
  .yl-toast.on { display: block; }
  .yl-winner { display: grid; grid-template-columns: 54px 1fr auto; gap: 8px; padding: 5px 0; font-size: 13px; border-bottom: 1px dashed #eee; } .yl-winner b { color: #d4143c; }
  .yl-mywin { margin-top: 10px; padding: 9px 12px; border-radius: 10px; background: #fff0f5; color: #d4143c; font-weight: 800; text-align: center; }
  .yl-confetti { position: absolute; top: -12px; width: 9px; height: 14px; border-radius: 2px; pointer-events: none; z-index: 5; animation: yl-fall 2.1s linear forwards; }
  @keyframes yl-fall { 0% { transform: translateY(-10px) rotate(0); opacity: 0; } 10% { opacity: 1; } 100% { transform: translateY(420px) rotate(720deg); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .yl-banner.big, .yl-bigbadge, .yl-confetti { animation: none; } }
  .yl-replay { width: 100%; margin: 8px 0 6px; }
  `;
  const style = document.createElement("style");
  style.id = "yulottery-styles";
  style.textContent = css;
  document.head.appendChild(style);
}
