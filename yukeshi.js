/* =========================================================
   消しバト（ゆうワールドのお店）：消しゴムの改造（第1段階）
   ・パーツの種類・値段・強さの計算・コインの引き落としは、すべて Worker（keshiState / keshiBuy / keshiEquip）が行う。
     このファイルは、画面（3Dの消しゴム・強さ・パーツの一覧）を描いて、「買う」「付ける」を頼むだけ。
   ・ゆうワールド（yuworld.js）から renderKeshi({ root, api, esc, openRooms, leagueFirst, onBack }) で開く。
========================================================= */
import { keshiStatsView, keshiPunchView, keshiLeaguePhase, eraserIcon } from "./yukeshi-core.js?v=20261024-mart2";
import { createEraserStage, SLEEVE_COLORS } from "./yukeshi3d.js?v=20261024-mart2";

const SLOT_NAMES = { body: "本体", edge: "ふち", sole: "そこ", weight: "おもり" };
const STAT_NAMES = [["m", "重さ"], ["s", "すべり"], ["b", "反発"], ["z", "大きさ"]];
let ctx = null, st = null, table = null, sel = { tab: "body", picks: {} }, busy = false, stage = null, stylesDone = false, token = 0, practice = null;
const $ = (s) => ctx && ctx.root.querySelector(s);

export function stopKeshi() { token++; if (stage) { try { stage.dispose(); } catch (_) {} stage = null; } if (practice) practice.stopPractice(); }

export function renderKeshi(c) {
  stopKeshi();
  ctx = c; st = null; table = null; busy = false; sel = { tab: "body", picks: {} };
  injectStyles();
  const my = token;
  ctx.root.innerHTML = `<div class="yk2-head"><button type="button" class="yw-back" id="ykBack">← お店の一覧</button><h2>${eraserIcon("ker-inline")} 消しバト</h2></div><div class="yk2-card yk2-msg">読み込み中…</div>`;
  $("#ykBack")?.addEventListener("click", back);
  return load(my);
}
function back() { stopKeshi(); ctx.onBack(); }

async function load(my) {
  try {
    const r = await ctx.api("keshiState");
    if (my !== token) return;
    st = r; table = r.table; sel = { tab: "body", picks: { ...st.eq } };
    drawShell();
    if (ctx.leagueFirst) { ctx.leagueFirst = false; openLeague(); }   // ゆうワールドの最強決定戦の札から来たときは、そのままリーグの画面を開く
  } catch (e) { if (my === token) fail(e && e.code); }
}
function fail(code) {
  const text = code === "not_published" ? "消しバトはまだ公開されていません。" : "読み込みに失敗しました。通信環境をご確認のうえ、もう一度お試しください。";
  ctx.root.innerHTML = `<div class="yk2-head"><button type="button" class="yw-back" id="ykBack">← お店の一覧</button><h2>${eraserIcon("ker-inline")} 消しバト</h2></div>
    <div class="yk2-card yk2-msg"><b>${ctx.esc(text)}</b>${code === "not_published" ? "" : `<p><button type="button" class="yw-btn" id="ykRetry">もう一度</button></p>`}</div>`;
  $("#ykBack")?.addEventListener("click", back);
  $("#ykRetry")?.addEventListener("click", () => renderKeshi(ctx));
}

/* 🏆 最強決定戦の大きなバナー（開催の状態・賞金・エントリー済みかが、ひと目で分かる）。状態は、日付と、ショップを開いたときに受け取った情報だけで作る（追加の通信なし） */
function leagueBanner() {
  const lg = st.league || { entered: false, prizes: [0, 0, 0], sets: [[10, 30], [12, 40], [15, 0]], firstMs: 0 };
  const now = Date.now(), p = keshiLeaguePhase(now, lg.firstMs || 0);
  const md = (ms) => { const d = new Date(ms + 9 * 3600000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
  const times = lg.sets.map(([h, m]) => `${h}:${String(m).padStart(2, "0")}`).join("・");
  const ribbon = p.phase === "live" ? `第${p.no}回 開催中！` : `第${p.no}回 ${md(p.startMs)}（月）スタート！`;
  const line = p.phase === "live" ? `金曜 15:10 まで、毎日 ${times} に5試合ずつ自動で対戦`
    : p.phase === "before" ? `開幕まで あと${p.days}日。いまエントリーすると、第1回の最初から参加できます`
    : `次の週は ${md(p.startMs)}（月）から。エントリーしておくと、毎週自動で参加できます`;
  const pr = (lg.prizes || []).map((v, i) => `<span><i>${["🥇", "🥈", "🥉"][i]}</i>${Number(v).toLocaleString("ja-JP")}<small>コイン</small></span>`).join("");
  return `<button type="button" class="kl-banner${p.phase === "live" ? " live" : ""}" id="ykLeague">
    <span class="kl-shine" aria-hidden="true"></span>
    <span class="kl-ribbon">🏆 ${ribbon}</span>
    <span class="kl-title">最強決定戦<small>〜消しバトリーグ〜</small></span>
    <span class="kl-line">${line}</span>
    <span class="kl-prizes">${pr}</span>
    <span class="kl-cta${lg.entered ? " done" : ""}">${lg.entered ? "✅ エントリー済み　順位・試合を見る ▶" : "👉 いますぐエントリーする ▶"}</span>
  </button>`;
}

/* 画面の枠は1回だけ作る（3Dの消しゴムを作り直さないため）。パーツの一覧などは、変わるたびに中身だけ描き直す */
function drawShell() {
  const my = token;
  ctx.root.innerHTML = `<div class="yk2-head"><button type="button" class="yw-back" id="ykBack">← お店の一覧</button><h2>${eraserIcon("ker-inline")} 消しバト</h2><div class="yk2-coins" id="ykCoins"></div></div>
    ${leagueBanner()}
    <button type="button" class="yk2-league-btn yk2-vs-btn" id="ykVs"><span>🥊</span><b>2人対戦</b><em>友達と1対1</em></button>
    <button type="button" class="yk2-league-btn yk2-prac-btn" id="ykPractice"><span>🎯</span><b>試し打ち</b><em>いま選んでいる組み合わせで</em></button>
    <p class="yk2-note">パーツを買って、自分だけの最強の消しゴムを作ろう！ パーツは、いくつか選んでまとめて買えます。</p>
    <div class="yk2-stagebox"><div class="yk2-stage" id="ykStage"><div class="yk2-fallback">${eraserIcon("ker-big")}</div></div><div class="yk2-rating" id="ykRating"></div></div>
    <div class="yk2-card"><div class="yk2-stats" id="ykStats"></div></div>
    <div class="yk2-tabs" id="ykTabs"></div>
    <div class="yk2-card"><div class="yk2-parts" id="ykParts"></div><div id="ykAct"></div></div>`;
  $("#ykBack")?.addEventListener("click", back);
  $("#ykLeague")?.addEventListener("click", openLeague);
  $("#ykPractice")?.addEventListener("click", openPractice);
  $("#ykVs")?.addEventListener("click", () => { if (typeof ctx.openRooms === "function") { stopKeshi(); ctx.openRooms(); } });
  draw();
  createEraserStage($("#ykStage")).then((s) => {
    if (!s) return;
    if (my !== token) { s.dispose(); return; }
    stage = s; $("#ykStage")?.querySelector(".yk2-fallback")?.remove(); updateStage();
  }).catch(() => {});
}
const previewEq = () => ({ ...st.eq, ...sel.picks });
/* 選んでいる変更（付けているものと違う枠）と、その中で買うもの・合計 */
function plan() {
  const slots = Object.keys(SLOT_NAMES).filter((slot) => sel.picks[slot] !== st.eq[slot]);
  const part = (slot) => table.parts[slot].find((x) => x.id === sel.picks[slot]);
  const toBuy = slots.filter((slot) => !st.have[slot].includes(sel.picks[slot]));
  return { slots, toBuy, part, total: toBuy.reduce((a, slot) => a + part(slot).price, 0) };
}
async function openPractice() {
  if (busy) return;
  const pl = plan(), eq = previewEq(), color = st.color, my = token;
  stopKeshi();
  try { practice = practice || await import("./yukeshi-practice.js?v=20261024-mart2"); }
  catch (_) { alert("試し打ちを開けませんでした。通信環境をご確認のうえ、もう一度お試しください。"); drawShell(); return; }
  if (token !== my + 1) return;
  practice.renderPractice({ root: ctx.root, esc: ctx.esc, table, eq, color, title: pl.slots.length ? `選んでいるパーツ：${pl.slots.map((slot) => pl.part(slot).name).join("・")}（まだ買っていないものも試せます）` : "いま付けているパーツ", onBack: () => drawShell() });
}
function updateStage() { if (stage) stage.set(previewEq(), st.color); }
const sign = (n) => (n > 0 ? "+" + n : String(n));
function effectText(p) { const t = STAT_NAMES.filter(([k]) => p[k]).map(([k, label]) => `${label}${sign(p[k])}`); return t.length ? t.join(" ") : "変化なし"; }

function draw() {
  const eq = previewEq(), cur = keshiStatsView(table, st.eq), pre = keshiStatsView(table, eq);
  $("#ykCoins").textContent = `🪙 ${st.coins.toLocaleString("ja-JP")}`;
  $("#ykRating").innerHTML = `総合力 <b>${pre.rating}</b>${pre.rating !== cur.rating ? `<span class="${pre.rating > cur.rating ? "up" : "down"}">${pre.rating > cur.rating ? "▲" : "▼"}${Math.abs(pre.rating - cur.rating)}</span>` : ""}`;
  $("#ykStats").innerHTML = STAT_NAMES.map(([k, label]) => {
    const diff = pre[k] - cur[k];
    return `<div class="yk2-stat"><span class="n">${label}</span><span class="bar"><i style="width:${Math.max(4, Math.min(100, pre[k]))}%"></i></span><b>${pre[k]}</b><em class="${diff > 0 ? "up" : diff < 0 ? "down" : ""}">${diff ? (diff > 0 ? "▲" : "▼") + Math.abs(diff) : ""}</em></div>`;
  }).join("") + (() => {
    /* 2人対戦での強さ（初期装備の消しゴム＝×1.0）。買って付けたら、どれだけ強くなるかが分かる */
    const a = keshiPunchView(table, st.eq), b = keshiPunchView(table, eq);
    const row = (label, k) => { const d = Math.round((b[k] - a[k]) * 10) / 10; return `<div class="yk2-stat yk2-battle"><span class="n">${label}</span><span class="bar"><i style="width:${Math.max(6, Math.min(100, 16 + b[k] * 18))}%"></i></span><b>×${b[k].toFixed(1)}</b><em class="${d > 0 ? "up" : d < 0 ? "down" : ""}">${d ? (d > 0 ? "▲" : "▼") + Math.abs(d).toFixed(1) : ""}</em></div>`; };
    return `<div class="yk2-battle-head">⚔ 2人対戦での強さ<small>初期装備の消しゴムを ×1.0 としたときの、ふっとばす力と、ふんばる力</small></div>${row("攻撃力", "atk")}${row("守り", "def")}`;
  })();
  const pl = st ? plan() : null;
  $("#ykTabs").innerHTML = [...Object.entries(SLOT_NAMES), ["color", "カバーの色"]].map(([k, label]) => `<button type="button" class="yk2-tab${sel.tab === k ? " on" : ""}" data-tab="${k}">${label}${pl.slots.includes(k) ? " ●" : ""}</button>`).join("");
  if (sel.tab === "color") {
    $("#ykParts").innerHTML = `<div class="yk2-colors">${SLEEVE_COLORS.map((c, i) => `<button type="button" class="yk2-color${st.color === i ? " on" : ""}" data-color="${i}" style="background:${c}" aria-label="${ctx.esc(table.colors[i])}"><span>${ctx.esc(table.colors[i])}</span></button>`).join("")}</div>`;
    $("#ykAct").innerHTML = `<p class="yk2-desc">カバーの色は、いくつでも無料で変えられます。強さには関係しません。</p>`;
  } else {
    const slot = sel.tab, have = st.have[slot];
    $("#ykParts").innerHTML = table.parts[slot].map((p) => {
      const owned = have.includes(p.id), on = st.eq[slot] === p.id;
      return `<button type="button" class="yk2-part${sel.picks[slot] === p.id ? " sel" : ""}${on ? " eq" : ""}" data-part="${p.id}"><span class="nm">${ctx.esc(p.name)}</span><span class="fx">${effectText(p)}</span><span class="pr">${on ? "装備中" : owned ? "持っている" : `🪙 ${p.price.toLocaleString("ja-JP")}`}</span></button>`;
    }).join("");
    const p = table.parts[slot].find((x) => x.id === sel.picks[slot]) || table.parts[slot][0];
    const sum = pl.slots.length ? `<div class="yk2-sum"><b>選んでいる変更</b>${pl.slots.map((k) => { const q = pl.part(k), own = st.have[k].includes(q.id); return `<div><span>${SLOT_NAMES[k]}：${ctx.esc(q.name)}</span><em>${own ? "持っている" : `🪙 ${q.price.toLocaleString("ja-JP")}`}</em></div>`; }).join("")}${pl.toBuy.length ? `<div class="tot"><span>買うものの合計</span><em>🪙 ${pl.total.toLocaleString("ja-JP")}</em></div>` : ""}<button type="button" class="yk2-resetpick" id="ykResetPick">選びなおす</button></div>` : "";
    let btn;
    if (!pl.slots.length) btn = `<button type="button" class="yw-btn yk2-go" disabled>この組み合わせで装備中</button>`;
    else if (!pl.toBuy.length) btn = `<button type="button" class="yw-btn yk2-go" id="ykApply" ${busy ? "disabled" : ""}>選んだパーツを付ける</button>`;
    else if (st.coins < pl.total) btn = `<button type="button" class="yw-btn yk2-go" disabled>コインが足りません（合計 🪙 ${pl.total.toLocaleString("ja-JP")}）</button>`;
    else btn = `<button type="button" class="yw-btn yk2-go yk2-buy" id="ykApply" ${busy ? "disabled" : ""}>${pl.toBuy.length > 1 ? `${pl.toBuy.length}個まとめて買って付ける` : "買って付ける"}（🪙 ${pl.total.toLocaleString("ja-JP")}）</button>`;
    $("#ykAct").innerHTML = `<p class="yk2-desc"><b>${ctx.esc(p.name)}</b>：${ctx.esc(p.desc)}（${effectText(p)}）</p>${sum}${btn}`;
  }
  ctx.root.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { sel.tab = b.dataset.tab; draw(); updateStage(); }));
  ctx.root.querySelectorAll("[data-part]").forEach((b) => b.addEventListener("click", () => { sel.picks[sel.tab] = b.dataset.part; draw(); updateStage(); }));
  $("#ykResetPick")?.addEventListener("click", () => { sel.picks = { ...st.eq }; draw(); updateStage(); });
  ctx.root.querySelectorAll("[data-color]").forEach((b) => b.addEventListener("click", () => setColor(Number(b.dataset.color))));
  $("#ykApply")?.addEventListener("click", apply);
}
async function call(action, payload) {
  if (busy) return null;
  busy = true; draw();
  try { const r = await ctx.api(action, payload); st = { ...st, ...r }; return r; }
  catch (e) { errorMsg(e && e.code); return null; }
  finally { busy = false; draw(); updateStage(); }
}
/* カバーの色を変える（無料。強さには関係しない） */
async function setColor(i) { if (busy || st.color === i) return; await call("keshiEquip", { color: i }); }
/* 選んでいるパーツをまとめて付ける。買うものがあれば、合計を確かめてから、まとめて買う */
async function apply() {
  const pl = plan(); if (!pl.slots.length) return;
  if (!pl.toBuy.length) { await call("keshiEquip", { eq: Object.fromEntries(pl.slots.map((slot) => [slot, sel.picks[slot]])) }); return; }
  const lines = pl.toBuy.map((slot) => `・${SLOT_NAMES[slot]}：${pl.part(slot).name}（${pl.part(slot).price.toLocaleString("ja-JP")} コイン）`).join("\n");
  if (!confirm(`次の${pl.toBuy.length}個を、合計 ${pl.total.toLocaleString("ja-JP")} コインで買って、消しゴムに付けますか？\n${lines}`)) return;
  const r = await call("keshiBuyMany", { items: pl.slots.map((slot) => ({ slot, part: sel.picks[slot] })) });
  if (r && r.bought) { ctx.root.querySelector("#ykCoins")?.classList.add("pop"); setTimeout(() => ctx.root.querySelector("#ykCoins")?.classList.remove("pop"), 600); }
}
function errorMsg(code) {
  const m = { insufficient_coins: "コインが足りません。", seated: "ゆうスロの席に着いているあいだは買えません。席を立ってから、もう一度お試しください。", busy: "通信が重なりました。もう一度お試しください。", already_owned: "そのパーツはすでに持っています。", not_published: "消しバトは、ただいま非公開になりました。" };
  alert(m[code] || "うまくいきませんでした（" + (code || "エラー") + "）。もう一度お試しください。");
  if (code === "busy" || code === "already_owned") load(token);
}

/* =========================================================
   🏆 最強決定戦（リーグ戦）：エントリーの画面（試合・順位・賞金は、あとの段階で追加）
   ・一度エントリーすると、毎週自動で参加扱い。月曜〜金曜の毎日、10:30・12:40・15:00 に5試合ずつ自動で対戦する予定（第1回は 10/26）。
========================================================= */
const DAY_LABELS = ["月", "火", "水", "木", "金"];
const mdJa = (ms) => { const d = new Date(ms + 9 * 3600000); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`; };
const hmJa = (h, m) => `${h}:${String(m).padStart(2, "0")}`;
let L = null;

async function openLeague() {
  const my = token;
  stopKeshi(); token = my + 1; const t = token;
  ctx.root.innerHTML = `<div class="yk2-head"><button type="button" class="yw-back" id="ylBack">← 消しゴムの改造へ</button><h2>🏆 最強決定戦</h2></div><div class="yk2-card yk2-msg">読み込み中…</div>`;
  $("#ylBack")?.addEventListener("click", () => renderKeshi(ctx));
  try { const r = await ctx.api("keshiLeagueState"); if (t !== token) return; L = r; drawLeague(); }
  catch (e) { if (t !== token) return; ctx.root.querySelector(".yk2-msg").innerHTML = `<b>${ctx.esc(e && e.code === "not_published" ? "消しバトはまだ公開されていません。" : "読み込みに失敗しました。もう一度お試しください。")}</b>`; }
}
function sheet(title, html) {
  const el = document.createElement("div"); el.className = "yl2-sheet";
  el.innerHTML = `<div class="yl2-sheet-box"><h3>${ctx.esc(title)}</h3><div class="yl2-sheet-body">${html}</div><button type="button" class="yw-btn yk2-go" data-close>閉じる</button></div>`;
  el.addEventListener("click", (e) => { if (e.target === el || e.target.hasAttribute("data-close")) el.remove(); });
  ctx.root.appendChild(el);
}
function drawLeague() {
  const w = L.week, pr = L.prizes, me = L.me;
  const first = L.sets.map(([h, m]) => hmJa(h, m)).join("・");
  const num = (v) => (v ? String(v) : "—");
  const days = DAY_LABELS.map((d, i) => `<div class="yl2-day"><span>${d}</span><b>${me ? num(me.days[i].rank) : "—"}</b></div>`).join("");
  const recent = me ? me.recent : [];
  const matches = [0, 1, 2, 3, 4].map((i) => { const m = recent[i]; return `<div class="yl2-match${m && !m.rest ? (m.win ? " win" : " lose") : ""}"><span>第${i + 1}戦</span>${m ? (m.rest ? `<em>休み</em>` : `<em>${m.win ? "勝利" : "敗北"}</em><i>${ctx.esc(m.score)}</i><small>${ctx.esc(m.opp)}</small>`) : `<em>—</em>`}</div>`; }).join("");
  const rows = DAY_LABELS.map((d, i) => { const x = me && me.days[i]; const has = x && x.w + x.l > 0; return `<div class="yl2-row"><span>${mdJa(w.days[i]).replace("月", "/").replace("日", "")}（${d}）</span><span>${has ? `${x.w}勝 ${x.l}敗` : "—"}</span><span>${x && x.rank ? x.rank + "位" : "—"}</span></div>`; }).join("");
  const lastSet = L.lastSetMs ? `${mdJa(L.lastSetMs)}（${"日月火水木金土"[new Date(L.lastSetMs + 9 * 3600000).getUTCDay()]}）${hmJa(new Date(L.lastSetMs + 9 * 3600000).getUTCHours(), new Date(L.lastSetMs + 9 * 3600000).getUTCMinutes())}` : "";
  const soon = L.started
    ? `第${w.no}回 開催中！毎日 ${first} に5試合ずつ、自動で対戦します。${lastSet ? `最新の試合：<b>${lastSet}</b>` : ""}${me ? "" : "<br>まだ試合をしていません（エントリーすると、次のセットから参加します）。"}`
    : `第${w.no}回は <b>${mdJa(w.setsMs[0])}（月）${hmJa(...L.sets[0])}</b> からスタート！試合は自動で行われ、勝敗だけが表示されます。`;
  const lastCard = L.last
    ? `<div class="yl2-last"><b>先週（第${Math.max(1, w.no - 1)}回）の結果発表</b>${L.last.top.map((t) => `<div class="${t.mine ? "mine" : ""}"><span>${["🥇", "🥈", "🥉"][t.rank - 1]} ${ctx.esc(t.name)}</span><span>${t.w}勝${t.l}敗</span><em>${t.prize.toLocaleString("ja-JP")}コイン</em></div>`).join("")}${L.last.me ? `<p>あなたは <b>${L.last.me.rank}位</b>（${L.last.me.w}勝${L.last.me.l}敗）でした。</p>` : ""}</div>`
    : "";
  const entry = L.entered
    ? `<div class="yl2-entry on"><div class="st">✅ エントリー済み</div><p>毎週、自動で参加扱いになります。参加者：${L.count}人</p><button type="button" class="yl2-quit" id="ylQuit">エントリーをやめる</button></div>`
    : `<div class="yl2-entry"><div class="st">リーグ戦にエントリーしよう！</div><p>一度エントリーすると、毎週自動で参加扱いになります（いつでもやめられます）。参加者：${L.count}人</p><button type="button" class="yw-btn yk2-go yl2-join" id="ylJoin">エントリーする</button></div>`;
  ctx.root.innerHTML = `<div class="yk2-head"><button type="button" class="yw-back" id="ylBack">← 消しゴムの改造へ</button></div>
    <div class="yl2-banner"><div class="yl2-title">最強決定戦<small>〜消しバトリーグ〜</small></div>
      <div class="yl2-btns"><button type="button" id="ylHelp">説明</button><button type="button" id="ylPrize">報酬</button></div>
      <div class="yl2-rank">現在の順位 <b>${me ? me.rank : "—"}</b> 位</div></div>
    <div class="yl2-period">開催期間：${mdJa(w.startMs)}〜${mdJa(w.days[4])}</div>
    <div class="yl2-days">${days}</div>
    <div class="yl2-soon">${soon}</div>
    ${lastCard}${entry}
    <div class="yl2-actions"><button type="button" id="ylPrize2">🏅 報酬</button><button type="button" id="ylRanking">👑 ランキング</button><button type="button" id="ylOrder">${eraserIcon("ker-inline")} 消しゴム変更</button></div>
    <div class="yl2-sec">最新試合結果<span>${lastSet && me ? lastSet : ""}</span></div><div class="yl2-matches">${matches}</div>
    <div class="yl2-sec">通算戦績<span>${me ? `${me.w}勝 ${me.l}敗` : "0勝 0敗"}</span></div><div class="yl2-table"><div class="yl2-row head"><span>日付</span><span>勝敗</span><span>順位</span></div>${rows}</div>`;
  const help = () => sheet("最強決定戦のルール", `<ol class="yl2-rules"><li>自分の消しゴム1個で戦います。パーツを買って組み合わせて、最強の消しゴムを作ろう。</li>
    <li>一度エントリーすると、毎週自動で参加扱いになります。</li>
    <li>月曜〜金曜の毎日、${first} に5試合ずつ（1日15試合）、自動で対戦します。</li>
    <li>1試合は3本勝負（2本先取）。結果だけが表示されます。強い消しゴムが有利ですが、毎回勝てるとは限りません。</li>
    <li>対戦相手は、最初はランダム。そのあとは、勝ち負けの数が近い人になります。</li>
    <li>月〜金の勝ち数でランキングが決まり、金曜 15:10 に結果発表。</li></ol>`);
  const prize = () => sheet("報酬", `<p>金曜 15:10 の結果発表で、ランキングの上位3名にゆうコインをお渡しします。</p><div class="yl2-prizes"><div>🥇 1位<b>${pr[0].toLocaleString("ja-JP")}</b>コイン</div><div>🥈 2位<b>${pr[1].toLocaleString("ja-JP")}</b>コイン</div><div>🥉 3位<b>${pr[2].toLocaleString("ja-JP")}</b>コイン</div></div>`);
  const ranking = () => sheet("ランキング", L.top.length
    ? `<p>今週の勝ち数の順位です（参加 ${L.total} 人）。</p><div class="yl2-rk">${L.top.map((t) => `<div class="${t.mine ? "mine" : ""}"><span>${t.rank <= 3 ? ["🥇", "🥈", "🥉"][t.rank - 1] : t.rank + "位"}</span><span class="n">${ctx.esc(t.name)}</span><b>${t.w}勝${t.l}敗</b></div>`).join("")}</div>`
    : `<p>ランキングは、試合が始まってから表示されます。${L.started ? "" : `（第${w.no}回：${mdJa(w.setsMs[0])}（月）から）`}</p><p>いまのエントリー：${L.count}人</p>`);
  $("#ylBack")?.addEventListener("click", () => renderKeshi(ctx));
  $("#ylOrder")?.addEventListener("click", () => renderKeshi(ctx));
  $("#ylHelp")?.addEventListener("click", help);
  $("#ylPrize")?.addEventListener("click", prize); $("#ylPrize2")?.addEventListener("click", prize);
  $("#ylRanking")?.addEventListener("click", ranking);
  $("#ylJoin")?.addEventListener("click", () => setEntry(true));
  $("#ylQuit")?.addEventListener("click", () => { if (confirm("エントリーをやめますか？（あとでまたエントリーできます）")) setEntry(false); });
}
async function setEntry(enter) {
  if (busy) return; busy = true;
  try { L = await ctx.api("keshiLeagueEntry", { enter }); drawLeague(); }
  catch (e) { alert("うまくいきませんでした（" + ((e && e.code) || "エラー") + "）。もう一度お試しください。"); }
  finally { busy = false; }
}

function injectStyles() {
  if (stylesDone) return; stylesDone = true;
  const css = `
  .yk2-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; } .yk2-head h2 { margin: 6px 0 4px; font-size: 20px; flex: 1; }
  .yk2-coins { font-weight: 800; background: #fff6d8; border: 1px solid #f0dc9a; border-radius: 999px; padding: 4px 12px; font-size: 14px; transition: transform .3s; } .yk2-coins.pop { transform: scale(1.18); }
  .yk2-note { color: #666; font-size: 12.5px; line-height: 1.7; margin: 4px 0 10px; }
  .yk2-card { background: #fff; border-radius: 14px; padding: 12px 14px; margin: 10px 0; box-shadow: 0 4px 16px rgba(0,0,0,.07); } .yk2-msg { text-align: center; padding: 26px 16px; }
  .yk2-stagebox { position: relative; border-radius: 16px; overflow: hidden; background: linear-gradient(135deg, #c8964b, #8a5a1f); box-shadow: inset 0 0 30px rgba(0,0,0,.3); }
  .yk2-stage { position: relative; height: 240px; display: flex; align-items: center; justify-content: center; } .yk2-gl { display: block; position: absolute; left: 0; top: 0; }
  .yk2-fallback { font-size: 80px; } .ker-big { width: 150px; height: 105px; } .ker-inline { width: 1.5em; height: 1.05em; vertical-align: -0.15em; } .yl2-actions .ker-inline { vertical-align: -0.2em; }
  .yk2-rating { position: absolute; right: 10px; top: 10px; background: rgba(0,0,0,.55); color: #fff; border-radius: 10px; padding: 4px 10px; font-size: 13px; } .yk2-rating b { font-size: 22px; margin: 0 4px; }
  .up { color: #2fbf55; font-size: 12px; font-style: normal; font-weight: 800; } .down { color: #ff6b5e; font-size: 12px; font-style: normal; font-weight: 800; }
  .yk2-stat { display: grid; grid-template-columns: 52px 1fr 30px 38px; gap: 8px; align-items: center; font-size: 13px; padding: 3px 0; }
  .yk2-stat .bar { height: 10px; background: #ece7da; border-radius: 6px; overflow: hidden; } .yk2-stat .bar i { display: block; height: 100%; background: linear-gradient(90deg, #5ac17a, #e0b32f 70%, #e0642f); border-radius: 6px; transition: width .25s; } .yk2-stat b { text-align: right; }
  .yk2-tabs { display: flex; gap: 6px; overflow-x: auto; padding: 2px 0; -webkit-overflow-scrolling: touch; }
  .yk2-tab { flex: 0 0 auto; border: none; background: #e9e4f6; color: #443; font-weight: 700; border-radius: 999px; padding: 8px 14px; font-size: 13px; cursor: pointer; } .yk2-tab.on { background: #4a7; color: #fff; }
  .yk2-parts { display: grid; gap: 8px; }
  .yk2-part { display: grid; grid-template-columns: 1fr auto; grid-template-areas: "nm pr" "fx fx"; gap: 2px 8px; text-align: left; border: 2px solid #eee; background: #fafafa; border-radius: 12px; padding: 9px 12px; cursor: pointer; }
  .yk2-part.sel { border-color: #e0902f; background: #fff8e8; } .yk2-part.eq { box-shadow: inset 0 0 0 2px #4a7; }
  .yk2-part .nm { grid-area: nm; font-weight: 800; font-size: 14px; } .yk2-part .pr { grid-area: pr; font-weight: 800; font-size: 13px; color: #b45309; } .yk2-part.eq .pr { color: #2c8a52; } .yk2-part .fx { grid-area: fx; font-size: 12px; color: #777; }
  .yk2-desc { font-size: 12.5px; color: #555; line-height: 1.7; margin: 10px 0 8px; } .yk2-go { display: block; width: 100%; padding: 12px; font-size: 15px; } .yk2-buy { background: #e0902f; } .yw-btn:disabled { opacity: .5; cursor: default; }
  .yk2-colors { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; } .yk2-color { height: 54px; border: 3px solid transparent; border-radius: 12px; color: #fff; font-weight: 800; font-size: 11px; text-shadow: 0 1px 2px rgba(0,0,0,.6); cursor: pointer; } .yk2-color.on { border-color: #222; box-shadow: 0 0 0 2px #fff inset; }
  .yk2-league-btn { display: flex; align-items: center; gap: 10px; width: 100%; margin: 10px 0 2px; padding: 12px 14px; border: none; border-radius: 14px; cursor: pointer; text-align: left; color: #ffe9a8; background: linear-gradient(135deg, #1b2347, #3b2a6b); box-shadow: 0 4px 14px rgba(40,20,90,.35); }
  .yk2-battle-head { margin: 10px 0 2px; padding-top: 8px; border-top: 1px dashed #d9d2b8; font-size: 12.5px; font-weight: 800; color: #14507a; } .yk2-battle-head small { display: block; font-weight: 500; color: #888; font-size: 11px; margin-top: 1px; }
  .yk2-battle .bar i { background: linear-gradient(90deg, #4aa0e0, #7a5ad6 70%, #d6409a); } .yk2-battle b { font-size: 13px; } .yk2-stat.yk2-battle { grid-template-columns: 52px 1fr 44px 38px; }
  .kl-banner { position: relative; overflow: hidden; display: grid; gap: 4px; width: 100%; margin: 10px 0 4px; padding: 14px 14px 12px; border: 2px solid #e8b84a; border-radius: 16px; cursor: pointer; text-align: left; color: #fff; background: radial-gradient(circle at 15% 0%, #5a45b0, #1b1840 70%); box-shadow: 0 6px 20px rgba(40,20,110,.45), 0 0 0 3px rgba(232,184,74,.25); font-family: inherit; }
  .kl-banner.live { animation: kl-glow 2.2s ease-in-out infinite; }
  @keyframes kl-glow { 0%, 100% { box-shadow: 0 6px 20px rgba(40,20,110,.45), 0 0 0 3px rgba(232,184,74,.25); } 50% { box-shadow: 0 6px 26px rgba(120,80,255,.6), 0 0 0 6px rgba(255,214,102,.5); } }
  .kl-shine { position: absolute; top: 0; bottom: 0; width: 60px; left: -80px; background: linear-gradient(100deg, transparent, rgba(255,255,255,.35), transparent); transform: skewX(-18deg); animation: kl-shine 3.6s ease-in-out infinite; pointer-events: none; }
  @keyframes kl-shine { 0% { left: -80px; } 45%, 100% { left: 120%; } }
  .kl-ribbon { justify-self: start; background: linear-gradient(#ffe9a0, #f0b92e); color: #5a3800; font-weight: 900; font-size: 12.5px; border-radius: 999px; padding: 3px 12px; box-shadow: 0 2px 0 #9a6a00; }
  .kl-title { font-size: 28px; font-weight: 900; letter-spacing: 2px; color: #ffe08a; text-shadow: 0 2px 0 #7a4b00, 0 0 14px rgba(255,200,80,.55); line-height: 1.15; } .kl-title small { display: block; font-size: 12px; letter-spacing: 1px; color: #fff; text-shadow: none; opacity: .85; margin-top: 2px; }
  .kl-line { font-size: 12.5px; line-height: 1.6; color: #e9e4ff; }
  .kl-prizes { display: flex; flex-wrap: wrap; gap: 6px 10px; } .kl-prizes span { background: rgba(0,0,0,.4); border: 1px solid rgba(255,214,102,.6); border-radius: 10px; padding: 3px 10px; font-weight: 900; font-size: 16px; color: #ffe08a; } .kl-prizes i { font-style: normal; margin-right: 3px; } .kl-prizes small { font-size: 10.5px; margin-left: 2px; color: #fff; font-weight: 600; }
  .kl-cta { margin-top: 4px; text-align: center; background: linear-gradient(#ffb347, #e0701f); color: #fff; font-weight: 900; font-size: 15px; border-radius: 12px; padding: 10px; box-shadow: 0 3px 0 #9a4b10; animation: kl-pulse 1.6s ease-in-out infinite; } .kl-cta.done { background: linear-gradient(#52c07a, #2a8a52); box-shadow: 0 3px 0 #1c6038; animation: none; }
  @keyframes kl-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.03); } }
  @media (prefers-reduced-motion: reduce) { .kl-banner.live, .kl-shine, .kl-cta { animation: none !important; } }
  .yk2-prac-btn { margin-top: 8px; background: linear-gradient(135deg, #5b3a1a, #a8651f); box-shadow: 0 4px 14px rgba(120,70,20,.35); } .yk2-prac-btn em { background: #14507a; }
  .yk2-sum { background: #fff8e8; border: 1px solid #f0dc9a; border-radius: 10px; padding: 8px 10px; margin: 0 0 10px; font-size: 12.5px; } .yk2-sum > b { display: block; margin-bottom: 4px; } .yk2-sum div { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; } .yk2-sum em { font-style: normal; font-weight: 800; color: #b45309; } .yk2-sum .tot { border-top: 1px dashed #d9c27a; margin-top: 4px; padding-top: 5px; font-weight: 800; }
  .yk2-resetpick { margin-top: 6px; border: none; background: none; color: #14507a; font-size: 12px; text-decoration: underline; cursor: pointer; padding: 2px 0; }
  .yk2-vs-btn { margin-top: 8px; background: linear-gradient(135deg, #14507a, #2a8fc9); box-shadow: 0 4px 14px rgba(20,80,122,.35); } .yk2-vs-btn em { background: #2fa85a; }
  .yk2-league-btn span { font-size: 24px; } .yk2-league-btn b { flex: 1; font-size: 15px; } .yk2-league-btn em { font-style: normal; font-size: 11px; background: #e0902f; color: #fff; border-radius: 999px; padding: 2px 8px; }
  .yl2-banner { position: relative; border-radius: 14px; padding: 14px 14px 12px; color: #fff; background: radial-gradient(circle at 20% 10%, #4a3a8c, #1b1840 70%); box-shadow: inset 0 0 0 2px #d4a93a, 0 4px 14px rgba(20,10,60,.4); }
  .yl2-title { font-size: 26px; font-weight: 900; letter-spacing: 2px; color: #ffe08a; text-shadow: 0 2px 0 #7a4b00, 0 0 12px rgba(255,200,80,.5); } .yl2-title small { display: block; font-size: 12px; letter-spacing: 1px; color: #f4e7c0; text-shadow: none; margin-top: 2px; }
  .yl2-btns { position: absolute; right: 10px; top: 10px; display: grid; gap: 6px; } .yl2-btns button { border: 2px solid #d4a93a; background: linear-gradient(#fff6d8, #f0cf6a); color: #5a3800; font-weight: 800; border-radius: 10px; padding: 5px 14px; font-size: 13px; cursor: pointer; }
  .yl2-rank { margin-top: 10px; font-size: 13px; background: rgba(0,0,0,.45); border-radius: 999px; display: inline-block; padding: 3px 14px; } .yl2-rank b { font-size: 20px; color: #ffe08a; margin: 0 4px; }
  .yl2-period { text-align: center; background: #14122e; color: #f3e9c7; font-size: 13px; padding: 6px; margin-top: 10px; border-radius: 8px 8px 0 0; }
  .yl2-days { display: grid; grid-template-columns: repeat(5, 1fr); background: linear-gradient(#26224f, #14122e); border-radius: 0 0 10px 10px; }
  .yl2-day { text-align: center; padding: 6px 2px 10px; color: #cfc8ee; border-right: 1px solid rgba(255,255,255,.08); } .yl2-day:last-child { border-right: none; } .yl2-day span { display: block; font-size: 12px; } .yl2-day b { font-size: 17px; color: #ffe08a; }
  .yl2-soon { margin: 10px 0; font-size: 12.5px; line-height: 1.7; color: #555; background: #fff8e8; border-radius: 10px; padding: 8px 12px; }
  .yl2-entry { background: #fff; border-radius: 14px; padding: 14px; box-shadow: 0 4px 16px rgba(0,0,0,.07); } .yl2-entry .st { font-weight: 900; font-size: 16px; } .yl2-entry p { font-size: 12.5px; color: #666; line-height: 1.7; margin: 6px 0 10px; }
  .yl2-entry.on { background: #eefaf1; } .yl2-join { background: linear-gradient(#5fc47e, #2f9a58); font-size: 17px; }
  .yl2-quit { border: none; background: none; color: #888; text-decoration: underline; font-size: 12px; cursor: pointer; padding: 4px 0; }
  .yl2-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 12px 0; } .yl2-actions button { border: 2px solid #d4a93a; border-radius: 10px; background: linear-gradient(#3d3770, #1f1b46); color: #ffe9a8; font-weight: 800; font-size: 12.5px; padding: 10px 4px; cursor: pointer; }
  .yl2-sec { display: flex; justify-content: space-between; background: #14122e; color: #f3e9c7; font-weight: 800; font-size: 13px; padding: 6px 12px; border-radius: 8px 8px 0 0; } .yl2-sec span { font-weight: 600; color: #ffe08a; }
  .yl2-matches { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; background: #1c1938; padding: 8px; border-radius: 0 0 10px 10px; } .yl2-match { background: #0e0c22; border-radius: 8px; padding: 6px 2px; text-align: center; color: #cfc8ee; font-size: 11px; } .yl2-match em { display: block; font-style: normal; font-size: 18px; color: #6e68a0; margin-top: 4px; }
  .yl2-table { background: #fff; border-radius: 0 0 10px 10px; overflow: hidden; margin-bottom: 14px; } .yl2-row { display: grid; grid-template-columns: 1.4fr 1fr 1fr; padding: 8px 12px; font-size: 13px; border-bottom: 1px solid #eee; color: #333; } .yl2-row.head { background: #ece7da; font-weight: 800; font-size: 12px; } .yl2-row span:nth-child(n+2) { text-align: right; color: #888; }
  .yl2-match.win { box-shadow: inset 0 0 0 2px #ffd166; } .yl2-match.win em { color: #ffd166; } .yl2-match.lose em { color: #8f95c8; } .yl2-match i { display: block; font-style: normal; font-size: 15px; font-weight: 800; color: #fff; margin-top: 2px; } .yl2-match small { display: block; font-size: 9px; color: #8f95c8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .yl2-last { background: linear-gradient(135deg, #fff6d8, #ffe9a8); border-radius: 14px; padding: 12px 14px; margin: 10px 0; font-size: 13px; } .yl2-last > b { display: block; margin-bottom: 6px; } .yl2-last div { display: flex; gap: 8px; padding: 4px 0; align-items: center; } .yl2-last div span:first-child { flex: 1; font-weight: 700; } .yl2-last div.mine { background: rgba(255,255,255,.7); border-radius: 8px; padding: 4px 6px; } .yl2-last em { font-style: normal; color: #b45309; font-weight: 800; } .yl2-last p { margin: 6px 0 0; }
  .yl2-rk { display: grid; gap: 2px; } .yl2-rk div { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-bottom: 1px solid #f0f0f0; font-size: 14px; } .yl2-rk .n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .yl2-rk div.mine { background: #fff8e1; border-radius: 8px; }
  .yl2-sheet { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 18px; } .yl2-sheet-box { background: #fff; border-radius: 16px; padding: 16px; max-width: 420px; width: 100%; max-height: 80vh; overflow: auto; } .yl2-sheet-box h3 { margin: 0 0 10px; }
  .yl2-rules { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.8; color: #444; } .yl2-sheet-body p { font-size: 13px; line-height: 1.8; color: #444; }
  .yl2-prizes { display: grid; gap: 8px; margin: 10px 0 14px; } .yl2-prizes div { background: #fff8e8; border-radius: 10px; padding: 10px 14px; font-weight: 800; display: flex; justify-content: space-between; align-items: center; } .yl2-prizes b { font-size: 20px; color: #b45309; margin-left: auto; margin-right: 4px; }
  .yk2-stage, .yk2-parts, .yk2-tabs { touch-action: manipulation; -webkit-user-select: none; user-select: none; }
  `;
  const el = document.createElement("style"); el.id = "yk2-style"; el.textContent = css; document.head.appendChild(el);
}
