/* =========================================================
   🎲 ヨット（ゆうワールドのお店）：1人用
   ・サイコロの目・点数の計算・ランキングは、すべて Worker（yachtState/yachtStart/yachtRoll/yachtScore/yachtRanking）が決める。
     このファイルは、画面（点数表・サイコロ・ランキング）を描いて、「どれをキープするか」「どの役に記録するか」を送るだけ。
   ・ゆうワールド（yuworld.js）から renderYacht({ root, api, esc, onBack }) で開く。
========================================================= */
import { load3D, DiceStage } from "./yuyacht3d.js?v=20261023-3d1";

const CATS = [
  { name: "エース", mark: "⚀" }, { name: "デュース", mark: "⚁" }, { name: "トレイ", mark: "⚂" },
  { name: "フォー", mark: "⚃" }, { name: "ファイブ", mark: "⚄" }, { name: "シックス", mark: "⚅" },
  { name: "チョイス", mark: "∑" }, { name: "フォーダイス", mark: "⁘" }, { name: "フルハウス", mark: "🏠" },
  { name: "S.ストレート", mark: "↗" }, { name: "B.ストレート", mark: "⇗" }, { name: "ヨット", mark: "★" }
];
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

let ctx = null, g = null, held = [false, false, false, false, false], sel = -1, busy = false, phase = "idle", shownKey = "", stylesDone = false, ranking = null, active = false;
const gKey = () => `${g.gid}:${g.turn}:${g.roll}`;
const isShown = () => shownKey === gKey();
const $ = (s) => ctx && ctx.root.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 立体のサイコロ（6面の立方体を、値に合わせて回す。見た目だけ：目は Worker が決めたものを描くだけ） */
const ROT = { 1: [0, 0], 2: [-90, 0], 3: [0, -90], 4: [0, 90], 5: [90, 0], 6: [0, 180] };
const SHAKE_MS = 850, POUR_MS = 1000, IN_MS = 300;
function cubeHtml(v, extra = "") {
  const faces = [1, 2, 3, 4, 5, 6].map((f) => `<i class="yy-face f${f}">${Array.from({ length: 9 }, (_, k) => `<b${PIPS[f].includes(k) ? ' class="on"' : ""}></b>`).join("")}</i>`).join("");
  return `<span class="yy-3d ${extra}" style="--rx:${ROT[v][0]}deg;--ry:${ROT[v][1]}deg;--rz:${(v * 23 % 30) - 15}deg"><span class="yy-cube">${faces}</span></span>`;
}
/* サイコロのトレイ：上の段＝キープしたサイコロ、赤いフェルト＝転がった目、右下のカップ（振るときはカップに集めて振り、そこから転がす）
   o.phase：idle（止まっている）／in（カップへ戻る）／shake（カップを振っている）／pour（カップから転がり出る）  o.shown：いまの目を見せてよいか
   o.tumble：その場で転がして見せる（相手の番で目が変わったとき）  o.canHold：キープの切り替えができるか  o.canRoll：カップを押して振れるか */
/* 3D 表示用のトレイ：サイコロそのものは canvas（yuyacht3d.js）が描く。ここは、マスの位置・タップする当たり判定・目の数字・カップだけ */
function trayGlHtml(dice, hold, o, hl) {
  const seeDice = o.phase === "pour" || o.phase === "in" || (o.phase === "idle" && o.shown);
  const rack = Array.from({ length: 5 }, (_, i) => `<div class="yy-slot${hold[i] && hl[i] ? " hit" : ""}">${hold[i] ? `<button type="button" class="yy-hitbox" data-hold="${i}" ${o.canHold ? "" : "disabled"} aria-label="キープをはずす"></button><span class="yy-num">${dice[i]}</span>` : ""}</div>`).join("");
  const spots = [0, 1, 2, 3, 4].map((i) => {
    if (hold[i] || !seeDice) return `<div class="yy-spot"></div>`;
    return `<div class="yy-spot${hl[i] && o.phase === "idle" ? " hit" : ""}"><button type="button" class="yy-hitbox" data-hold="${i}" ${o.canHold ? "" : "disabled"} aria-label="キープする"></button>${o.phase === "idle" ? `<span class="yy-num">${dice[i]}</span>` : ""}</div>`;
  }).join("");
  const cupCls = o.phase === "shake" ? "shake" : o.phase === "pour" ? "pour" : o.canRoll && !o.shown ? "ready" : "";
  const cup = `<div class="yy-spot yy-cupspot"><button type="button" class="yy-cup ${cupCls}" id="yyCup" aria-label="カップを振る" ${o.canRoll ? "" : "disabled"}><span class="yy-cup-rim"></span><span class="yy-cup-body"></span></button></div>`;
  return `<div class="yy-tray yy-gl-on"><div class="yy-rack">${rack}</div><div class="yy-floor">${spots}${cup}</div></div>`;
}
/* 選んだ役に「当たっている」サイコロ（その役の点になっている目）。見やすくするための表示だけ：点数の計算は Worker */
function hitDice(cat, dice) {
  const no = [false, false, false, false, false];
  if (cat == null || cat < 0) return no;
  const c = [0, 0, 0, 0, 0, 0, 0];
  dice.forEach((d) => { c[d]++; });
  if (cat <= 5) return dice.map((d) => d === cat + 1);
  if (cat === 6) return dice.map(() => true);
  if (cat === 7) { const v = c.findIndex((n) => n >= 4); return v < 0 ? no : dice.map((d) => d === v); }
  if (cat === 8) { const k = c.filter((n) => n > 0).sort(); return k.length === 2 && k[0] === 2 && k[1] === 3 ? dice.map(() => true) : no; }
  if (cat === 9) {
    for (const start of [3, 2, 1]) { const run = [start, start + 1, start + 2, start + 3]; if (run.every((v) => c[v] > 0)) { const used = new Set(); return dice.map((d) => { if (run.includes(d) && !used.has(d)) { used.add(d); return true; } return false; }); } }
    return no;
  }
  if (cat === 10) return [1, 2, 3, 4, 5].every((v) => c[v] > 0) || [2, 3, 4, 5, 6].every((v) => c[v] > 0) ? dice.map(() => true) : no;
  if (cat === 11) return c.some((n) => n === 5) ? dice.map(() => true) : no;
  return no;
}
function trayHtml(dice, hold, o) {
  const hl = o.hl || [false, false, false, false, false];
  if (glOn) return trayGlHtml(dice, hold, o, hl);
  const rack = Array.from({ length: 5 }, (_, i) => `<div class="yy-slot${hold[i] && hl[i] ? " hit" : ""}">${hold[i] ? `<button type="button" class="yy-dbtn" data-hold="${i}" ${o.canHold ? "" : "disabled"}>${cubeHtml(dice[i])}</button><span class="yy-num">${dice[i]}</span>` : ""}</div>`).join("");
  const seeDice = o.phase === "pour" || o.phase === "in" || (o.phase === "idle" && o.shown);
  const spots = [0, 1, 2, 3, 4].map((i) => {
    if (hold[i] || !seeDice) return `<div class="yy-spot"></div>`;
    const cls = o.phase === "pour" ? "pour" : o.phase === "in" ? "in" : "";
    const jx = ((i * 29 + dice[i] * 7) % 13) - 6, jy = ((i * 17 + dice[i] * 5) % 11) - 5;
    return `<div class="yy-spot"><div class="yy-dwrap ${cls}${hl[i] && o.phase === "idle" ? " hit" : ""}" style="--c:${i % 3};--r:${Math.floor(i / 3)};--dl:${(i * 60) % 240}ms;left:${jx}%;top:${jy}%"><button type="button" class="yy-dbtn" data-hold="${i}" ${o.canHold ? "" : "disabled"}>${cubeHtml(dice[i], o.phase === "pour" || o.tumble ? "tumble" : "")}</button>${o.phase === "idle" ? `<span class="yy-num">${dice[i]}</span>` : ""}</div></div>`;
  }).join("");
  const cupCls = o.phase === "shake" ? "shake" : o.phase === "pour" ? "pour" : o.canRoll && !o.shown ? "ready" : "";
  const cup = `<div class="yy-spot yy-cupspot"><button type="button" class="yy-cup ${cupCls}" id="yyCup" aria-label="カップを振る" ${o.canRoll ? "" : "disabled"}><span class="yy-cup-rim"></span><span class="yy-cup-body"></span></button></div>`;
  return `<div class="yy-tray"><div class="yy-rack">${rack}</div><div class="yy-floor">${spots}${cup}</div></div>`;
}
/* 3D サイコロ（three.js）。読み込めない・WebGL が使えない端末では、CSS の立体サイコロのまま */
let stage = null, glOn = false, glTried = false;
function initGL() {
  if (glTried) return; glTried = true;
  load3D().then((ok) => {
    if (!ok) return;
    try { stage = new DiceStage(); glOn = true; } catch (_) { stage = null; glOn = false; return; }
    if (active && g && !g.done && phase === "idle") drawGame();
    else if (rm.y && rm.boardEl && document.body.contains(rm.boardEl) && rm.phase === "idle") drawRoom();
  });
}
function syncGL(rootEl, o) {
  if (!glOn || !stage) return;
  const tray = rootEl.querySelector(".yy-tray");
  if (!tray) return;
  try { stage.mount(tray); stage.sync(o); } catch (_) { /* 描けなかったときは、そのまま（DOM の表示は残る） */ }
}
const md = (ms) => { const d = new Date(ms + 9 * 3600000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const mdhm = (ms) => { const d = new Date(ms + 9 * 3600000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };

export function renderYacht(c) {
  initGL();
  ctx = c; active = true; g = null; sel = -1; busy = false; phase = "idle"; shownKey = ""; ranking = null;
  injectStyles();
  head("読み込み中…");
  return loadStart();
}
export function stopYacht() { active = false; }

function back() { stopYacht(); ctx.onBack(); }
function head(msg) {
  ctx.root.innerHTML = `<div class="yy-head"><button type="button" class="yw-back" id="yyBack">← お店の一覧</button><h2>🎲 ヨット</h2></div><div class="yy-card yy-msg">${ctx.esc(msg)}</div>`;
  $("#yyBack")?.addEventListener("click", back);
}
function fail(code) {
  const text = code === "not_published" ? "ヨットはまだ公開されていません。" : "読み込みに失敗しました。通信環境をご確認のうえ、もう一度お試しください。";
  ctx.root.innerHTML = `<div class="yy-head"><button type="button" class="yw-back" id="yyBack">← お店の一覧</button><h2>🎲 ヨット</h2></div>
    <div class="yy-card yy-msg"><b>${ctx.esc(text)}</b>${code === "not_published" ? "" : `<p><button type="button" class="yw-btn" id="yyRetry">もう一度</button></p>`}</div>`;
  $("#yyBack")?.addEventListener("click", back);
  $("#yyRetry")?.addEventListener("click", () => { head("読み込み中…"); loadStart(); });
}

/* ---------- スタート画面（ランキングつき） ---------- */
async function loadStart() {
  try {
    const [st, rk] = await Promise.all([ctx.api("yachtState"), ctx.api("yachtRanking")]);
    if (!active) return;
    ranking = rk;
    if (st.game && !st.game.done) { g = st.game; shownKey = g.roll > 1 ? gKey() : ""; }
    drawStart(st.game);
  } catch (e) { if (active) fail(e && e.code); }
}
function rankingHtml() {
  const rk = ranking;
  if (!rk) return "";
  const medal = ["🥇", "🥈", "🥉"];
  const rows = rk.week.rows.length
    ? rk.week.rows.slice(0, 10).map((r) => `<div class="yy-rk${r.mine ? " mine" : ""}"><span>${medal[r.rank - 1] || r.rank + "位"}</span><span class="n">${ctx.esc(r.name)}</span><b>${r.score}点</b>${r.prize ? `<em>${r.prize}コイン</em>` : ""}</div>`).join("")
    : `<div class="yy-empty">まだ記録がありません。いちばんのりを目指そう！</div>`;
  const me = rk.me && rk.me.best ? `<div class="yy-me">あなたの今週のハイスコア：<b>${rk.me.best}点</b>（${rk.me.rank}位）</div>` : `<div class="yy-me">あなたの今週のハイスコア：まだありません</div>`;
  const last = rk.last && rk.last.top.length
    ? `<h4>先週の結果（${md(rk.last.startMs)}〜${md(rk.last.endMs - 1)}）</h4>${rk.last.top.map((t) => `<div class="yy-rk${t.mine ? " mine" : ""}"><span>${medal[t.rank - 1]}</span><span class="n">${ctx.esc(t.name)}</span><b>${t.score}点</b><em>${t.prize}コイン</em></div>`).join("")}`
    : "";
  return `<div class="yy-card"><h3>🏆 今週のハイスコアランキング</h3>
    <p class="yy-sub">1位 ${rk.prizes[0]}・2位 ${rk.prizes[1]}・3位 ${rk.prizes[2]} コイン。毎週金曜 15:10 に結果発表（${mdhm(rk.week.startMs)} 〜 ${mdhm(rk.week.endMs)}）。</p>
    ${me}${rows}${last}</div>`;
}
function drawStart(game) {
  ctx.root.innerHTML = `<div class="yy-head"><button type="button" class="yw-back" id="yyBack">← お店の一覧</button><h2>🎲 ヨット</h2><p>サイコロを振って役を作り、12ターンの合計点を競います。</p></div>
    <div class="yy-card yy-mode"><div class="yy-mode-name">1人用</div>
      <p class="yy-sub">1ターンに最大3回まで振れます。残したい目はキープして、12個の役をひとつずつ埋めよう。得点は週間ランキングに載ります。</p>
      <button type="button" class="yw-btn yy-go" id="yyPlay">${game ? `続きから遊ぶ（ターン ${game.turn}/12）` : "遊ぶ"}</button>
      ${game ? `<button type="button" class="yw-btn yw-btn-sub yy-go" id="yyRestart">あきらめて新しく始める</button>` : ""}</div>
    <div class="yy-card yy-mode"><div class="yy-mode-name">2人用</div>
      <p class="yy-sub">友達とルームで対戦。交互にサイコロを振って、12ターンの合計点が高いほうが勝ち。1ターンの持ち時間は60秒です。</p>
      <button type="button" class="yw-btn yy-go" id="yyRooms">対戦ルームへ</button></div>
    ${rankingHtml()}
    <div class="yy-card"><h3>役と点数</h3><div class="yy-rules">
      <div><b>エース〜シックス</b>その目の合計</div><div><b>チョイス</b>5個の合計</div>
      <div><b>フォーダイス</b>同じ目4個以上で5個の合計</div><div><b>フルハウス</b>3個＋2個で5個の合計</div>
      <div><b>S.ストレート</b>4つ連続で15点</div><div><b>B.ストレート</b>5つ連続で30点</div>
      <div><b>ヨット</b>5個とも同じ目で50点</div><div><b>ボーナス</b>エース〜シックスの合計が63点以上で＋35点</div></div></div>`;
  $("#yyBack")?.addEventListener("click", back);
  $("#yyPlay")?.addEventListener("click", () => start(false));
  $("#yyRooms")?.addEventListener("click", () => { if (typeof ctx.openRooms === "function") ctx.openRooms(); });
  $("#yyRestart")?.addEventListener("click", () => { if (confirm("今のゲームをやめて、新しく始めますか？（今のゲームの点数は残りません）")) start(true); });
}
async function start(restart) {
  if (busy) return; busy = true;
  try {
    const r = await ctx.api("yachtStart", restart ? { restart: true } : {});
    g = r; held = [false, false, false, false, false]; sel = -1; phase = "idle"; shownKey = g.roll > 1 ? gKey() : "";
    busy = false; drawGame();
  } catch (e) { busy = false; alert("始められませんでした（" + ((e && e.code) || "エラー") + "）"); }
}

/* ---------- ゲーム画面 ---------- */
function cellHtml(i) {
  const filled = g.card[i] >= 0;
  const cand = !filled && !g.done && isShown() ? g.opts[i] : -1;
  const cls = filled ? "filled" : cand >= 0 ? `cand${sel === i ? " sel" : ""}${cand === 0 ? " zero" : " pos"}` : "";
  const text = filled ? g.card[i] : cand >= 0 ? cand : "";
  return `<tr class="yy-row"><th><span class="yy-mark">${CATS[i].mark}</span>${CATS[i].name}</th><td class="yy-cell ${cls}" data-cat="${i}">${text}</td></tr>`;
}
function sheetHtml() {
  const upperText = `${g.upper}/63`;
  return `<table class="yy-sheet"><thead><tr><th class="yy-turn">ターン <b>${Math.min(g.turn, 12)}</b>/12</th><th class="yy-me-h">🙂</th></tr></thead><tbody>
    ${[0, 1, 2, 3, 4, 5].map(cellHtml).join("")}
    <tr class="yy-sub-row"><th>小計</th><td>${upperText}</td></tr>
    <tr class="yy-sub-row${g.bonus ? " got" : ""}"><th>ボーナス +35</th><td>${g.bonus ? "+35" : ""}</td></tr>
    ${cellHtml(6)}<tr class="yy-gap"><td colspan="2"></td></tr>
    ${[7, 8, 9, 10, 11].map(cellHtml).join("")}
    <tr class="yy-total"><th>総合得点</th><td>${g.total}</td></tr></tbody></table>`;
}
function drawGame() {
  if (!active) return;
  if (g.done) return drawResult();
  const shown = isShown(), idle = phase === "idle" && !busy;
  const left = shown ? 3 - g.roll : 3;
  const selName = sel >= 0 ? CATS[sel].name : "";
  const canHold = idle && shown && g.roll < 3;
  const canRoll = idle && left > 0;
  ctx.root.innerHTML = `<div class="yy-head yy-head-game"><button type="button" class="yw-back" id="yyBack">← 一覧へ</button><span class="yy-left">🎲 あと${left}回</span></div>
    <div class="yy-game"><div class="yy-left-pane">${sheetHtml()}</div>
      <div class="yy-play"><div class="yy-wood">${trayHtml(g.dice, held, { phase, shown, canHold, canRoll, hl: shown ? hitDice(sel, g.dice) : null })}</div>
        <p class="yy-hint">${sel >= 0 ? `「${ctx.esc(selName)}」に記録します` : !shown ? "カップをタップして、サイコロを振ろう" : left > 0 ? "残したいサイコロをタップでキープ → 「振り直す」。点数表の役をタップして記録" : "もう振れません。点数表の役をタップして記録しよう"}</p>
        <div class="yy-btns">
          <button type="button" class="yw-btn yy-roll" id="yyRoll" ${canRoll ? "" : "disabled"}>${!shown ? "🥤 カップを振る" : left > 0 ? `🥤 振り直す（あと${left}回）` : "もう振れません"}</button>
          <button type="button" class="yw-btn yy-rec" id="yyRec" ${sel >= 0 && idle && shown ? "" : "disabled"}>${sel >= 0 ? `記録する（${g.opts[sel]}点）` : "役を選んで記録"}</button>
        </div></div></div>`;
  syncGL(ctx.root, { dice: g.dice, hold: held, phase, shown, hl: shown ? hitDice(sel, g.dice) : null, anim: phase === "pour" ? "pour" : phase === "in" ? "in" : "", animKey: `${gKey()}:${phase}` });
  $("#yyBack")?.addEventListener("click", () => { loadStart(); });
  ctx.root.querySelectorAll("[data-hold]").forEach((b) => b.addEventListener("click", () => { if (!canHold) return; const i = Number(b.dataset.hold); held[i] = !held[i]; drawGame(); }));
  ctx.root.querySelectorAll(".yy-cell.cand").forEach((td) => td.addEventListener("click", () => { if (!idle || !shown) return; sel = Number(td.dataset.cat); drawGame(); }));
  $("#yyRoll")?.addEventListener("click", doRoll);
  $("#yyCup")?.addEventListener("click", doRoll);
  $("#yyRec")?.addEventListener("click", doScore);
}
/* カップを振る：最初の1回は、すでにサーバーが決めた目をカップから転がして見せるだけ。振り直しは、キープしない目をカップに戻して振り、サーバーが決めた新しい目を転がす */
async function doRoll() {
  if (busy || phase !== "idle") return;
  sel = -1; busy = true;
  if (!isShown()) {
    phase = "shake"; drawGame(); await sleep(SHAKE_MS);
    shownKey = gKey(); phase = "pour"; drawGame(); await sleep(POUR_MS);
    phase = "idle"; busy = false; drawGame(); return;
  }
  if (g.roll >= 3) { busy = false; return; }
  phase = "in"; drawGame(); await sleep(IN_MS);
  phase = "shake"; drawGame();
  const t0 = Date.now();
  let r;
  try { r = await ctx.api("yachtRoll", { gid: g.gid, hold: held }); }
  catch (e) { phase = "idle"; busy = false; return errorBack(e); }
  await sleep(Math.max(0, SHAKE_MS - (Date.now() - t0)));
  g = r; shownKey = gKey(); phase = "pour"; drawGame(); await sleep(POUR_MS);
  phase = "idle"; busy = false; drawGame();
}
async function doScore() {
  if (busy || phase !== "idle" || sel < 0 || !isShown()) return;
  busy = true;
  const cat = sel;
  try {
    const r = await ctx.api("yachtScore", { gid: g.gid, cat });
    g = r; held = [false, false, false, false, false]; sel = -1; shownKey = "";
    if (r.finished) { try { ranking = await ctx.api("yachtRanking"); } catch (_) {} }
    busy = false; drawGame();
  } catch (e) { busy = false; errorBack(e); }
}
function errorBack(e) {
  const code = e && e.code;
  if (code === "stale" || code === "no_game") { alert("ゲームの状態が変わっていたので、読み込み直します。"); loadStart(); return; }
  if (code === "busy") { alert("通信が重なりました。もう一度お試しください。"); drawGame(); return; }
  alert("うまくいきませんでした（" + (code || "エラー") + "）。もう一度お試しください。"); drawGame();
}

/* ---------- 結果 ---------- */
function drawResult() {
  const w = g.week;
  const medal = w && w.rank >= 1 && w.rank <= 3 ? ["🥇", "🥈", "🥉"][w.rank - 1] : "";
  const line = w
    ? (w.improved ? `<p class="yy-new">今週のハイスコアを更新！ 現在 <b>${w.rank}位</b> ${medal}</p>` : `<p class="yy-sub">今週のハイスコアは <b>${w.best}点</b>（${w.rank}位）のままです。</p>`)
    : "";
  ctx.root.innerHTML = `<div class="yy-head"><h2>🎲 ヨット</h2></div>
    <div class="yy-game"><div class="yy-left-pane">${sheetHtml()}</div>
      <div class="yy-card yy-result"><div class="yy-result-title">ゲーム終了！</div>
        <div class="yy-score"><b>${g.total}</b>点</div>
        <p class="yy-sub">エース〜シックスの小計 ${g.upper}点${g.bonus ? "（ボーナス +35点）" : "（あと" + (63 - g.upper) + "点でボーナスでした）"}</p>
        ${line}
        <div class="yy-btns"><button type="button" class="yw-btn yy-go" id="yyAgain">もう一度遊ぶ</button><button type="button" class="yw-btn yw-btn-sub yy-go" id="yyTop">ランキングを見る</button></div></div></div>`;
  $("#yyAgain")?.addEventListener("click", () => start(false));
  $("#yyTop")?.addEventListener("click", () => { loadStart(); });
}

/* =========================================================
   2人用（ゲームルーム）：script.js の renderCurrentGame から、ルームが更新されるたびに呼ばれる
   ・サイコロの目・点数・手番は、Worker が gameRooms/{roomId} の yacht に書く（ブラウザは「ふる」「記録する」を頼むだけ）。
   ・相手の画面には、ルームの監視（onSnapshot）でそのまま届く。持ち時間は1ターン60秒（過ぎたら Worker が自動で記録する）。
========================================================= */
const rm = { roomId: "", gid: "", key: "", held: [false, false, false, false, false], sel: -1, phase: "idle", shownKey: "", lastDice: "", busy: false, y: null, offset: 0, tm: null, started: "", sentKey: "", error: "" };
const roomKey = (y) => `${y.gid}:${y.round}:${y.cur}:${y.roll}`;

export function renderYachtRoom(boardEl, room, c) {
  initGL();
  injectStyles();
  rm.api = c.api; rm.uid = c.uid; rm.esc = c.esc; rm.boardEl = boardEl; rm.room = room;
  if (rm.roomId !== room.id) { Object.assign(rm, { roomId: room.id, gid: "", key: "", held: [false, false, false, false, false], sel: -1, phase: "idle", shownKey: "", lastDice: "", busy: false, y: null, started: "", sentKey: "", error: "" }); }
  const uids = Array.isArray(room.memberUids) ? room.memberUids : [];
  const members = Array.isArray(room.members) ? room.members : [];
  if (room.status !== "playing" || uids.length < 2) {
    stopRoomTimer(); rm.y = null;
    boardEl.innerHTML = `<div class="yy-card yy-msg"><b>対戦相手を待っています…</b><p class="yy-sub">2人そろうと、自動でゲームが始まります。上の「友達を招待」から誘うか、ルーム一覧から参加してもらおう。</p></div>`;
    return;
  }
  const y = room.yacht;
  const sameOrder = y && Array.isArray(y.order) && y.order[0] === uids[0] && y.order[1] === uids[1];
  if (!sameOrder) {
    stopRoomTimer(); rm.y = null;
    const k = uids.join(",");
    if (rm.started !== k) { rm.started = k; roomStart(false); }
    boardEl.innerHTML = rm.error ? roomErrorHtml() : `<div class="yy-card yy-msg">ゲームを準備しています…</div>`;
    return;
  }
  if (!rm.y || y.at >= rm.y.at || y.gid !== rm.y.gid) {
    rm.y = y;
    rm.offset = y.at - Date.now();
    if (y.gid !== rm.gid) { rm.gid = y.gid; rm.key = ""; rm.sentKey = ""; }
    const key = `${y.round}:${y.cur}`;
    if (key !== rm.key) { rm.key = key; rm.held = [false, false, false, false, false]; rm.sel = -1; rm.phase = "idle"; rm.shownKey = y.roll > 1 ? roomKey(y) : ""; }
  }
  if (rm.phase !== "idle" || rm.busy) return;   // 自分の「振る」の演出の途中は描き直さない（終わったときに描く）
  drawRoom();
}
function roomErrorHtml() {
  const msg = rm.error === "not_published" ? "ヨットは準備中のため、まだ遊べません。" : "ゲームを始められませんでした。通信環境をご確認のうえ、ルームを開き直してください。";
  return `<div class="yy-card yy-msg"><b>${rm.esc(msg)}</b></div>`;
}
async function roomStart(rematch) {
  try { const r = await rm.api("yachtRoomStart", { roomId: rm.roomId, ...(rematch ? { rematch: true } : {}) }); if (r.yacht) { rm.y = r.yacht; rm.offset = r.yacht.at - Date.now(); drawRoom(); } rm.error = ""; }
  catch (e) { rm.error = (e && e.code) || "error"; if (rm.boardEl && !rm.y) rm.boardEl.innerHTML = roomErrorHtml(); }
}
function stopRoomTimer() { if (rm.tm) { clearInterval(rm.tm); rm.tm = null; } }
const roomNow = () => Date.now() + rm.offset;
function myIndex() { return rm.y ? rm.y.order.indexOf(rm.uid) : -1; }

/* いまの目を見せてよいか（自分の番は、カップを振って転がしたあと。相手の番は、いつでも） */
const roomShown = (y, mineTurn) => !mineTurn || rm.shownKey === roomKey(y);
function roomCellHtml(i, who, y, me) {
  const card = who === 0 ? y.c0 : y.c1;
  const filled = card[i] >= 0;
  const mineTurn = !y.done && y.cur === me;
  const showCand = !filled && !y.done && y.cur === who && y.opts && y.opts[i] >= 0 && roomShown(y, y.cur === me);
  const clickable = showCand && who === me && mineTurn;
  const cls = filled ? "filled" : showCand ? `cand${clickable ? "" : " other"}${rm.sel === i && who === me ? " sel" : ""}${y.opts[i] === 0 ? " zero" : " pos"}` : "";
  return `<td class="yy-cell ${cls}" ${clickable ? `data-cat="${i}"` : ""}>${filled ? card[i] : showCand ? y.opts[i] : ""}</td>`;
}
function roomSheetHtml(y, me) {
  const t = [yachtTotalsClient(y.c0), yachtTotalsClient(y.c1)];
  const rowCat = (i) => `<tr class="yy-row"><th><span class="yy-mark">${CATS[i].mark}</span>${CATS[i].name}</th>${roomCellHtml(i, 0, y, me)}${roomCellHtml(i, 1, y, me)}</tr>`;
  const sub = (label, a, b, cls = "") => `<tr class="yy-sub-row ${cls}"><th>${label}</th><td>${a}</td><td>${b}</td></tr>`;
  const head = [0, 1].map((w) => `<th class="yy-me-h${y.cur === w && !y.done ? " turn" : ""}${me === w ? " me" : ""}">${rm.esc(String(y.names[w] || "").slice(0, 6))}</th>`).join("");
  return `<table class="yy-sheet yy-sheet2"><thead><tr><th class="yy-turn">ターン <b>${Math.min(y.round, 12)}</b>/12</th>${head}</tr></thead><tbody>
    ${[0, 1, 2, 3, 4, 5].map(rowCat).join("")}
    ${sub("小計", `${t[0].upper}/63`, `${t[1].upper}/63`)}
    ${sub("ボーナス +35", t[0].bonus ? "+35" : "", t[1].bonus ? "+35" : "", "")}
    ${rowCat(6)}<tr class="yy-gap"><td colspan="3"></td></tr>
    ${[7, 8, 9, 10, 11].map(rowCat).join("")}
    <tr class="yy-total"><th>総合得点</th><td>${t[0].total}</td><td>${t[1].total}</td></tr></tbody></table>`;
}
/* 画面に出す小計・ボーナス・合計（Worker の yachtTotals と同じ計算。ゲームの結果そのものは Worker が決める） */
function yachtTotalsClient(card) {
  const upper = card.slice(0, 6).reduce((a, v) => a + (v > 0 ? v : 0), 0);
  const bonus = upper >= 63 ? 35 : 0;
  return { upper, bonus, total: upper + bonus + card.slice(6).reduce((a, v) => a + (v > 0 ? v : 0), 0) };
}
function resultHtml(y, me) {
  const t = [yachtTotalsClient(y.c0), yachtTotalsClient(y.c1)];
  const title = y.winner === 2 ? "引き分け！" : y.winner === me ? "あなたの勝ち！🎉" : "あなたの負け…";
  const sub = y.reason === "timeout" ? `<p class="yy-sub">${rm.esc(String(y.names[1 - y.winner] || "相手"))}さんが続けて時間切れになったため、ゲームを終了しました。</p>` : "";
  return `<div class="yy-card yy-result"><div class="yy-result-title">${title}</div>
    <div class="yy-vs"><span>${rm.esc(String(y.names[0]))}<b>${t[0].total}</b></span><span>${rm.esc(String(y.names[1]))}<b>${t[1].total}</b></span></div>${sub}
    <div class="yy-btns"><button type="button" class="yw-btn yy-go" id="yrAgain">もう一度対戦する</button></div></div>`;
}
function drawRoom() {
  const el = rm.boardEl, y = rm.y;
  if (!el || !y || !document.body.contains(el)) { stopRoomTimer(); return; }
  const me = myIndex();
  if (me < 0) { el.innerHTML = `<div class="yy-card yy-msg">観戦中です</div>`; return; }
  const mineTurn = !y.done && y.cur === me;
  const shown = roomShown(y, mineTurn), idle = rm.phase === "idle" && !rm.busy;
  const left = shown ? 3 - y.roll : 3;
  const dk = roomKey(y);
  const tumble = !mineTurn && !y.done && rm.lastDice !== "" && rm.lastDice !== dk;   // 相手が振った目を、その場で転がして見せる
  rm.lastDice = dk;
  const canHold = mineTurn && idle && shown && y.roll < 3, canRoll = mineTurn && idle && left > 0;
  const turnName = rm.esc(String(y.names[y.cur] || ""));
  const status = y.done ? "" : mineTurn
    ? `<div class="yy-turnbar mine">あなたの番です <span id="yrTimer" class="yy-timer"></span></div>`
    : `<div class="yy-turnbar">${turnName}さんの番です <span id="yrTimer" class="yy-timer"></span></div>`;
  const play = y.done ? resultHtml(y, me) : `<div class="yy-play"><div class="yy-wood">${trayHtml(y.dice, mineTurn ? rm.held : [false, false, false, false, false], { phase: mineTurn ? rm.phase : "idle", shown, canHold, canRoll, tumble, hl: mineTurn && shown ? hitDice(rm.sel, y.dice) : null })}</div>
      <p class="yy-hint">${mineTurn ? (rm.sel >= 0 ? `「${rm.esc(CATS[rm.sel].name)}」に記録します` : !shown ? "カップをタップして、サイコロを振ろう" : left > 0 ? "残したいサイコロをタップでキープ → 「振り直す」。点数表の役をタップして記録" : "もう振れません。点数表の役をタップして記録しよう") : "相手の操作を待っています"}</p>
      ${mineTurn ? `<div class="yy-btns"><button type="button" class="yw-btn yy-roll" id="yrRoll" ${canRoll ? "" : "disabled"}>${!shown ? "🥤 カップを振る" : left > 0 ? `🥤 振り直す（あと${left}回）` : "もう振れません"}</button>
        <button type="button" class="yw-btn yy-rec" id="yrRec" ${rm.sel >= 0 && idle && shown ? "" : "disabled"}>${rm.sel >= 0 ? `記録する（${y.opts[rm.sel]}点）` : "役を選んで記録"}</button></div>` : ""}</div>`;
  el.innerHTML = `${status}<div class="yy-game yy-room"><div class="yy-left-pane">${roomSheetHtml(y, me)}</div>${play}</div>`;
  if (!y.done) syncGL(el, { dice: y.dice, hold: mineTurn ? rm.held : [false, false, false, false, false], phase: mineTurn ? rm.phase : "idle", shown, hl: mineTurn && shown ? hitDice(rm.sel, y.dice) : null, anim: mineTurn ? (rm.phase === "pour" ? "pour" : rm.phase === "in" ? "in" : "") : (tumble ? "pour" : ""), animKey: `${dk}:${mineTurn ? rm.phase : "idle"}:${tumble ? 1 : 0}` });
  el.querySelectorAll("[data-hold]").forEach((b) => b.addEventListener("click", () => { if (!canHold) return; const i = Number(b.dataset.hold); rm.held[i] = !rm.held[i]; drawRoom(); }));
  el.querySelectorAll(".yy-cell.cand[data-cat]").forEach((td) => td.addEventListener("click", () => { if (!idle || !shown) return; rm.sel = Number(td.dataset.cat); drawRoom(); }));
  el.querySelector("#yrRoll")?.addEventListener("click", roomRoll);
  el.querySelector("#yyCup")?.addEventListener("click", roomRoll);
  el.querySelector("#yrRec")?.addEventListener("click", roomScore);
  el.querySelector("#yrAgain")?.addEventListener("click", () => roomStart(true));
  startRoomTimer();
}
function startRoomTimer() {
  stopRoomTimer();
  const y = rm.y;
  if (!y || y.done) return;
  const tick = () => {
    if (!rm.boardEl || !document.body.contains(rm.boardEl) || !rm.y || rm.y.done) { stopRoomTimer(); return; }
    const left = Math.max(0, Math.ceil((rm.y.deadline - roomNow()) / 1000));
    const t = rm.boardEl.querySelector("#yrTimer");
    if (t) { t.textContent = `残り ${left}秒`; t.classList.toggle("warn", left <= 10); }
    // 時間切れ：番の人の画面がすぐ、相手の画面は少し待ってから Worker に頼む（Worker が時刻を確かめて、二重には処理しない）
    const over = roomNow() - rm.y.deadline;
    const mine = rm.y.order[rm.y.cur] === rm.uid;
    const key = `${rm.y.gid}:${rm.y.round}:${rm.y.cur}`;
    if (over >= (mine ? 600 : 3500) && rm.sentKey !== key) {
      rm.sentKey = key;
      rm.api("yachtRoomTimeout", { roomId: rm.roomId, gid: rm.y.gid, round: rm.y.round, turn: rm.y.cur }).then((r) => { if (r && r.yacht) { rm.y = r.yacht; rm.offset = r.yacht.at - Date.now(); drawRoom(); } }).catch(() => { rm.sentKey = ""; });
    }
  };
  tick(); rm.tm = setInterval(tick, 1000);
}
async function roomRoll() {
  const y = rm.y; if (!y || rm.busy || rm.phase !== "idle" || y.done || y.order[y.cur] !== rm.uid) return;
  rm.sel = -1; rm.busy = true;
  if (rm.shownKey !== roomKey(y)) {   // 最初の1回：サーバーが決めた目を、カップから転がして見せるだけ
    rm.phase = "shake"; drawRoom(); await sleep(SHAKE_MS);
    rm.shownKey = roomKey(rm.y); rm.phase = "pour"; drawRoom(); await sleep(POUR_MS);
    rm.phase = "idle"; rm.busy = false; drawRoom(); return;
  }
  if (y.roll >= 3) { rm.busy = false; return; }
  rm.phase = "in"; drawRoom(); await sleep(IN_MS);
  rm.phase = "shake"; drawRoom();
  const t0 = Date.now();
  let r;
  try { r = await rm.api("yachtRoomRoll", { roomId: rm.roomId, gid: y.gid, hold: rm.held }); }
  catch (e) { rm.phase = "idle"; rm.busy = false; roomError(e); drawRoom(); return; }
  await sleep(Math.max(0, SHAKE_MS - (Date.now() - t0)));
  rm.y = r.yacht; rm.offset = r.yacht.at - Date.now(); rm.shownKey = roomKey(rm.y);
  rm.phase = "pour"; drawRoom(); await sleep(POUR_MS);
  rm.phase = "idle"; rm.busy = false; drawRoom();
}
async function roomScore() {
  const y = rm.y; if (!y || rm.busy || rm.phase !== "idle" || rm.sel < 0 || rm.shownKey !== roomKey(y)) return;
  rm.busy = true;
  try {
    const r = await rm.api("yachtRoomScore", { roomId: rm.roomId, gid: y.gid, cat: rm.sel });
    rm.y = r.yacht; rm.offset = r.yacht.at - Date.now(); rm.sel = -1;
    const key = `${rm.y.round}:${rm.y.cur}`; if (key !== rm.key) { rm.key = key; rm.held = [false, false, false, false, false]; rm.shownKey = rm.y.roll > 1 ? roomKey(rm.y) : ""; }
  } catch (e) { roomError(e); }
  rm.busy = false; drawRoom();
}
function roomError(e) {
  const code = e && e.code;
  if (code === "timeout") return;   // 時間切れ：タイマーが Worker に頼む
  if (code === "not_your_turn" || code === "stale" || code === "no_game") return;   // 手番が進んでいた：ルームの更新で画面が直る
  if (code === "busy") { alert("通信が重なりました。もう一度お試しください。"); return; }
  alert("うまくいきませんでした（" + (code || "エラー") + "）。もう一度お試しください。");
}

function injectStyles() {
  if (stylesDone) return; stylesDone = true;
  const css = `
  .yy-head h2 { margin: 6px 0 4px; font-size: 20px; } .yy-head p { margin: 0 0 8px; color: #666; font-size: 13px; }
  .yy-head-game { display: flex; justify-content: space-between; align-items: center; }
  .yy-left { font-weight: 800; color: #14507a; }
  .yy-card { background: #fff; border-radius: 14px; padding: 14px 16px; margin: 12px 0; box-shadow: 0 4px 16px rgba(0,0,0,.07); }
  .yy-card h3 { margin: 0 0 8px; font-size: 15px; } .yy-card h4 { margin: 12px 0 6px; font-size: 13px; color: #555; }
  .yy-msg { text-align: center; padding: 26px 16px; }
  .yy-sub { color: #777; font-size: 12px; line-height: 1.7; margin: 6px 0; }
  .yy-mode-name { font-weight: 800; font-size: 18px; } .yy-go { display: block; width: 100%; margin-top: 10px; padding: 12px; font-size: 15px; }
  .yy-rk { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
  .yy-rk .n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .yy-rk em { font-style: normal; color: #b45309; font-size: 12px; }
  .yy-rk.mine { background: #fff8e1; border-radius: 8px; } .yy-empty { color: #888; font-size: 13px; padding: 10px 0; text-align: center; }
  .yy-me { font-size: 13px; margin: 6px 0 8px; } .yy-rules { display: grid; gap: 6px; font-size: 12.5px; color: #555; line-height: 1.6; } .yy-rules b { display: inline-block; min-width: 108px; color: #222; }
  .yy-game { display: grid; gap: 8px; grid-template-columns: minmax(150px, 41%) 1fr; align-items: start; }
  .yy-game.yy-room { grid-template-columns: minmax(196px, 52%) 1fr; }
  @media (min-width: 720px) { .yy-game { grid-template-columns: 240px 1fr; gap: 14px; } }
  .yy-root, .yy-game, .yy-game * { touch-action: manipulation; -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; }
  .yy-sheet { width: 100%; border-collapse: collapse; background: #fbf7ea; border: 2px solid #3b3f46; font-size: 11.5px; }
  .yy-sheet th { text-align: left; padding: 4px 4px; font-weight: 600; background: #f3edd8; border-bottom: 1px solid #d9d2b8; white-space: nowrap; }
  .yy-sheet td { text-align: right; padding: 4px 6px; border-bottom: 1px solid #d9d2b8; border-left: 1px solid #d9d2b8; width: 38px; font-weight: 700; }
  .yy-sheet thead th { background: #3b3f46; color: #fff; text-align: center; } .yy-turn b { font-size: 18px; } .yy-me-h { font-size: 22px; background: #ffe9ea !important; color: #000; }
  .yy-mark { display: inline-block; width: 1.2em; text-align: center; margin-right: 2px; }
  .yy-cell { background: #ffe56a; } .yy-cell.filled { background: #fff; } .yy-cell.cand { cursor: pointer; color: #8a6d00; } .yy-cell.cand.zero { color: #b9a14a; background: #fbeeb0; font-weight: 500; }
  .yy-cell.cand.pos { background: #ffd23a; color: #1d1d1d; font-weight: 900; box-shadow: inset 0 0 0 2px #e0902f; }
  .yy-cell.cand.sel { background: #ff9f1a; color: #fff; outline: 2px solid #c25e00; outline-offset: -2px; }
  .yy-sub-row th, .yy-sub-row td { background: #8a8d92; color: #fff; font-size: 12px; } .yy-sub-row.got td { background: #e0902f; }
  .yy-gap td { height: 6px; padding: 0; background: #3b3f46; border: none; }
  .yy-total th, .yy-total td { background: #3b3f46; color: #fff; font-size: 16px; }
  .yy-wood { background: linear-gradient(135deg, #b9803f, #8c5a24); border-radius: 14px; padding: 8px; box-shadow: inset 0 0 24px rgba(0,0,0,.25); }
  .yy-tray { background: #3b3f46; border-radius: 12px; padding: 6px; box-shadow: 0 6px 18px rgba(0,0,0,.35); }
  .yy-rack { display: grid; grid-template-columns: repeat(5, 1fr); gap: 3px; background: #2a2d33; border-radius: 8px; padding: 3px; margin-bottom: 6px; }
  .yy-slot { aspect-ratio: 1; background: #1f2126; border-radius: 5px; display: flex; align-items: center; justify-content: center; }
  .yy-floor { position: relative; display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; background: radial-gradient(circle at 50% 40%, #a42a2a, #6e1414); box-shadow: inset 0 0 14px rgba(0,0,0,.45); border-radius: 10px; padding: 6px 2px; min-height: 130px; align-content: center; }
  .yy-spot { height: 76px; min-width: 0; display: flex; align-items: center; justify-content: center; position: relative; }
  .yy-room .yy-spot { height: 68px; }
  .yy-dbtn { border: none; background: none; padding: 0; cursor: pointer; line-height: 0; } .yy-dbtn:disabled { cursor: default; }
  /* 立体のサイコロ：6面の立方体（preserve-3d）を、値に合わせて回す。斜めから見た角度（rotateX/Y のつけ足し）で、上と横の面も見える */
  .yy-3d { --s: 36px; position: relative; display: block; width: var(--s); height: var(--s); perspective: 340px; }
  .yy-slot .yy-3d { --s: 22px; }
  .yy-slot { position: relative; } .yy-spot .yy-dwrap { display: flex; flex-direction: column; align-items: center; }
  /* いまの目の数字（サイコロの下に大きく）。選んだ役に当たっているサイコロは、金色の枠と数字で光る */
  .yy-num { display: inline-block; margin-top: 13px; min-width: 1.5em; text-align: center; font-weight: 900; font-size: 12px; line-height: 1.5; border-radius: 999px; background: rgba(0,0,0,.45); color: #fff; }
  .yy-slot .yy-num { position: absolute; right: 1px; top: 1px; margin: 0; min-width: 1.4em; font-size: 10px; line-height: 1.4; z-index: 2; }
  .yy-dwrap.hit .yy-3d, .yy-slot.hit .yy-3d { filter: drop-shadow(0 0 5px #ffd400) drop-shadow(0 0 3px #ffd400); }
  .yy-dwrap.hit .yy-num, .yy-slot.hit .yy-num { background: #ffd400; color: #3a2a00; box-shadow: 0 0 8px #ffd400; }
  .yy-slot.hit { box-shadow: 0 0 0 2px #ffd400 inset; }
  .yy-room .yy-3d { --s: 29px; } .yy-room .yy-slot .yy-3d { --s: 18px; }
  @media (min-width: 720px) { .yy-3d, .yy-room .yy-3d { --s: 84px; } .yy-slot .yy-3d, .yy-room .yy-slot .yy-3d { --s: 52px; } .yy-sheet { font-size: 14px; } .yy-sheet td { width: 64px; } .yy-floor { min-height: 330px; } .yy-spot, .yy-room .yy-spot { height: 150px; } .yy-num { font-size: 15px; } .yy-play { max-width: 560px; } .yy-slot .yy-num { font-size: 13px; } }
  .yy-tray { position: relative; }
  .yy-gl { position: absolute; left: 0; top: 0; pointer-events: none; z-index: 1; }
  .yy-hitbox { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: none; background: none; cursor: pointer; z-index: 2; } .yy-hitbox:disabled { cursor: default; }
  .yy-gl-on .yy-spot .yy-num, .yy-gl-on .yy-slot .yy-num { position: absolute; left: 50%; bottom: 2px; right: auto; top: auto; transform: translateX(-50%); margin: 0; z-index: 2; }
  .yy-gl-on .yy-slot .yy-num { bottom: -3px; }
  .yy-gl-on .yy-spot.hit .yy-num, .yy-gl-on .yy-slot.hit .yy-num { background: #ffd400; color: #3a2a00; box-shadow: 0 0 8px #ffd400; }
  .yy-gl-on .yy-slot.hit { box-shadow: 0 0 0 2px #ffd400 inset; }
  .yy-cupspot { z-index: 3; }
  .yy-3d::before { content: ""; position: absolute; left: 6%; right: -8%; bottom: -10%; height: 26%; border-radius: 50%; background: radial-gradient(ellipse at center, rgba(0,0,0,.55), rgba(0,0,0,0) 70%); filter: blur(1.5px); }
  .yy-cube { position: relative; display: block; width: 100%; height: 100%; transform-style: preserve-3d; transform: rotateX(-16deg) rotateY(-20deg) rotateZ(var(--rz, 0deg)) rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg)); }
  .yy-face { position: absolute; inset: 0; display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(3, 1fr); box-sizing: border-box; padding: 11%; border-radius: 18%;
    background: radial-gradient(circle at 30% 25%, #ffffff 0%, #f1f1f3 55%, #d4d4d9 100%); box-shadow: inset 0 0 calc(var(--s) * .12) rgba(0,0,0,.28), inset 0 calc(var(--s) * -.04) 0 rgba(0,0,0,.08); backface-visibility: hidden; }
  .yy-face b { display: block; border-radius: 50%; margin: 7%; }
  .yy-face b.on { background: radial-gradient(circle at 35% 30%, #5a5a5a, #0a0a0a 70%); box-shadow: inset 0 calc(var(--s) * .02) calc(var(--s) * .03) rgba(255,255,255,.25); }
  .yy-face.f1 b.on { background: radial-gradient(circle at 35% 30%, #ff6b6b, #b30f0f 70%); margin: 0; }
  .yy-face.f1 { transform: translateZ(calc(var(--s) / 2)); }
  .yy-face.f6 { transform: rotateY(180deg) translateZ(calc(var(--s) / 2)); }
  .yy-face.f3 { transform: rotateY(90deg) translateZ(calc(var(--s) / 2)); }
  .yy-face.f4 { transform: rotateY(-90deg) translateZ(calc(var(--s) / 2)); }
  .yy-face.f2 { transform: rotateX(90deg) translateZ(calc(var(--s) / 2)); }
  .yy-face.f5 { transform: rotateX(-90deg) translateZ(calc(var(--s) / 2)); }
  .yy-dwrap { position: relative; }
  /* カップから転がり出る（位置：カップのあるマスから自分のマスへ。サイコロはその間ずっと回りながら止まる） */
  .yy-dwrap.pour { animation: yy-pour .95s cubic-bezier(.25,.8,.35,1) var(--dl, 0ms) both; }
  .yy-dwrap.pour .yy-3d { animation: yy-hop .95s ease-out var(--dl, 0ms) both; }
  .yy-dwrap.in { animation: yy-in .28s ease-in both; }
  @keyframes yy-pour { 0% { translate: calc((2 - var(--c)) * 100%) calc((1 - var(--r)) * 100%); scale: .35; opacity: 0; } 12% { opacity: 1; } 72% { translate: calc((2 - var(--c)) * -9%) calc((1 - var(--r)) * -6%); scale: 1.06; } 100% { translate: 0 0; scale: 1; opacity: 1; } }
  @keyframes yy-hop { 0%, 100% { transform: translateY(0); } 30% { transform: translateY(-22%); } 55% { transform: translateY(0); } 72% { transform: translateY(-7%); } 86% { transform: translateY(0); } }
  @keyframes yy-in { 0% { translate: 0 0; scale: 1; opacity: 1; } 100% { translate: calc((2 - var(--c)) * 100%) calc((1 - var(--r)) * 100%); scale: .3; opacity: 0; } }
  .yy-3d.tumble .yy-cube { animation: yy-tumble .95s cubic-bezier(.2,.75,.3,1) both; }
  @keyframes yy-tumble {
    from { transform: rotateX(-16deg) rotateY(-20deg) rotateZ(var(--rz, 0deg)) rotateX(calc(var(--rx, 0deg) + 540deg)) rotateY(calc(var(--ry, 0deg) + 450deg)); }
    to { transform: rotateX(-16deg) rotateY(-20deg) rotateZ(var(--rz, 0deg)) rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg)); } }
  /* ダイスカップ（黒い革のカップ。赤い縫い目）：サイコロを入れて振り、傾けて転がす */
  .yy-cupspot { align-items: flex-end; }
  .yy-cup { position: relative; display: block; width: 86%; height: 92%; max-width: 62px; padding: 0; border: none; background: none; cursor: pointer; transform-origin: 50% 90%; filter: drop-shadow(0 5px 4px rgba(0,0,0,.5)); }
  .yy-cup:disabled { cursor: default; }
  .yy-cup-body { position: absolute; left: 0; right: 0; top: 12%; bottom: 0; clip-path: polygon(10% 0, 90% 0, 100% 100%, 0 100%); border-radius: 0 0 14% 14%;
    background: linear-gradient(90deg, #0c0c0d, #3b3b3f 40%, #1a1a1c 62%, #09090a); }
  .yy-cup-body::before { content: ""; position: absolute; left: 14%; right: 14%; top: 22%; border-top: 2px dashed #d24; opacity: .9; }
  .yy-cup-body::after { content: ""; position: absolute; left: 6%; right: 6%; bottom: 14%; border-top: 2px dashed #d24; opacity: .7; }
  .yy-cup-rim { position: absolute; left: 6%; right: 6%; top: 4%; height: 18%; border-radius: 50%; background: radial-gradient(ellipse at center, #8a1515 35%, #17171a 38%); z-index: 1; box-shadow: 0 1px 0 rgba(255,255,255,.12); }
  .yy-cup.ready { animation: yy-ready 1.4s ease-in-out infinite; }
  @keyframes yy-ready { 0%, 100% { transform: rotate(0deg); } 20% { transform: rotate(-5deg); } 40% { transform: rotate(5deg); } 60% { transform: rotate(0deg); } }
  .yy-cup.shake { animation: yy-cupshake .17s linear infinite; }
  @keyframes yy-cupshake { 0% { transform: translate(0, 0) rotate(-8deg); } 25% { transform: translate(-6px, -9px) rotate(6deg); } 50% { transform: translate(4px, 0) rotate(-6deg); } 75% { transform: translate(-3px, -7px) rotate(8deg); } 100% { transform: translate(0, 0) rotate(-8deg); } }
  .yy-cup.pour { animation: yy-cuppour 1s ease-in-out both; }
  @keyframes yy-cuppour { 0% { transform: translate(0, 0) rotate(0deg); } 22% { transform: translate(-14px, -10px) rotate(-92deg); } 62% { transform: translate(-14px, -10px) rotate(-92deg); } 100% { transform: translate(0, 0) rotate(0deg); } }
  .yy-hint { text-align: center; color: #555; font-size: 11.5px; line-height: 1.5; margin: 8px 0 0; }
  .yy-btns { display: grid; gap: 8px; margin-top: 10px; } .yy-roll, .yy-rec { padding: 10px 6px; font-size: 13.5px; line-height: 1.35; } .yy-rec { background: #e0902f; } .yw-btn:disabled { opacity: .45; cursor: default; }
  .yy-result { text-align: center; } .yy-result-title { font-size: 18px; font-weight: 800; } .yy-score { font-size: 20px; margin: 10px 0; } .yy-score b { font-size: 54px; color: #14507a; }
  .yy-new { color: #b45309; font-weight: 800; font-size: 15px; }
  .yy-sheet2 td { width: 34px; padding: 4px 4px; } .yy-sheet2 .yy-me-h { font-size: 11px; padding: 4px 2px; text-align: center; color: #000; }
  .yy-sheet2 .yy-me-h.turn { background: #ffe56a !important; } .yy-sheet2 .yy-me-h.me { text-decoration: underline; }
  .yy-cell.cand.other { cursor: default; opacity: .65; }
  .yy-turnbar { text-align: center; background: #3b3f46; color: #fff; border-radius: 10px; padding: 8px; font-weight: 800; margin-bottom: 8px; font-size: 14px; } .yy-turnbar.mine { background: #e0902f; }
  .yy-timer { margin-left: 8px; font-weight: 700; font-size: 13px; } .yy-timer.warn { color: #ff6b6b; }
  .yy-vs { display: flex; justify-content: space-around; gap: 8px; margin: 12px 0; font-size: 13px; } .yy-vs span { display: flex; flex-direction: column; align-items: center; } .yy-vs b { font-size: 34px; color: #14507a; }
  @media (prefers-reduced-motion: reduce) { .yy-3d.tumble .yy-cube, .yy-dwrap.pour, .yy-dwrap.pour .yy-3d, .yy-dwrap.in, .yy-cup.shake, .yy-cup.pour, .yy-cup.ready { animation: none !important; } }
  `;
  const el = document.createElement("style"); el.id = "yy-style"; el.textContent = css; document.head.appendChild(el);
}
