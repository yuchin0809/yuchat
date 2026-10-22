/* =========================================================
   🎲 ヨット（ゆうワールドのお店）：1人用
   ・サイコロの目・点数の計算・ランキングは、すべて Worker（yachtState/yachtStart/yachtRoll/yachtScore/yachtRanking）が決める。
     このファイルは、画面（点数表・サイコロ・ランキング）を描いて、「どれをキープするか」「どの役に記録するか」を送るだけ。
   ・ゆうワールド（yuworld.js）から renderYacht({ root, api, esc, onBack }) で開く。
========================================================= */
const CATS = [
  { name: "エース", mark: "⚀" }, { name: "デュース", mark: "⚁" }, { name: "トレイ", mark: "⚂" },
  { name: "フォー", mark: "⚃" }, { name: "ファイブ", mark: "⚄" }, { name: "シックス", mark: "⚅" },
  { name: "チョイス", mark: "∑" }, { name: "フォーダイス", mark: "⁘" }, { name: "フルハウス", mark: "🏠" },
  { name: "S.ストレート", mark: "↗" }, { name: "B.ストレート", mark: "⇗" }, { name: "ヨット", mark: "★" }
];
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const ROLL_MS = 650;

let ctx = null, g = null, held = [false, false, false, false, false], sel = -1, busy = false, rolling = false, stylesDone = false, ranking = null, active = false;
const $ = (s) => ctx && ctx.root.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dieHtml = (v, cls = "") => `<span class="yy-die ${cls}" data-v="${v}">${Array.from({ length: 9 }, (_, i) => `<i class="${(PIPS[v] || []).includes(i) ? "on" : ""}"></i>`).join("")}</span>`;
const md = (ms) => { const d = new Date(ms + 9 * 3600000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const mdhm = (ms) => { const d = new Date(ms + 9 * 3600000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };

export function renderYacht(c) {
  ctx = c; active = true; g = null; sel = -1; busy = false; rolling = false; ranking = null;
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
    if (st.game && !st.game.done) { g = st.game; }
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
    g = r; held = [false, false, false, false, false]; sel = -1;
    drawGame();
  } catch (e) { alert("始められませんでした（" + ((e && e.code) || "エラー") + "）"); }
  busy = false;
}

/* ---------- ゲーム画面 ---------- */
function cellHtml(i) {
  const filled = g.card[i] >= 0;
  const cand = !filled && !g.done ? g.opts[i] : -1;
  const cls = filled ? "filled" : cand >= 0 ? `cand${sel === i ? " sel" : ""}${cand === 0 ? " zero" : ""}` : "";
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
function trayHtml() {
  const canHold = !g.done && g.roll >= 1 && g.roll < 3 && !rolling;
  const rack = Array.from({ length: 5 }, (_, i) => `<div class="yy-slot">${held[i] ? `<button type="button" class="yy-dbtn" data-hold="${i}">${dieHtml(g.dice[i], "held")}</button>` : ""}</div>`).join("");
  const floor = g.dice.map((v, i) => held[i] ? `<div class="yy-spot"></div>` : `<div class="yy-spot"><button type="button" class="yy-dbtn${rolling ? " rolling" : ""}" data-hold="${i}" style="--r:${(i * 37 + g.roll * 53) % 40 - 20}deg" ${canHold ? "" : "disabled"}>${dieHtml(g.dice[i])}</button></div>`).join("");
  return `<div class="yy-tray"><div class="yy-rack">${rack}</div><div class="yy-floor">${floor}</div></div>`;
}
function drawGame() {
  if (!active) return;
  if (g.done) return drawResult();
  const left = 3 - g.roll;
  const selName = sel >= 0 ? CATS[sel].name : "";
  ctx.root.innerHTML = `<div class="yy-head yy-head-game"><button type="button" class="yw-back" id="yyBack">← 一覧へ</button><span class="yy-left">🎲 あと${left}回</span></div>
    <div class="yy-game"><div class="yy-left-pane">${sheetHtml()}</div>
      <div class="yy-play"><div class="yy-wood">${trayHtml()}</div>
        <p class="yy-hint">${sel >= 0 ? `「${ctx.esc(selName)}」に記録します` : left > 0 ? "残したいサイコロをタップでキープ → 「ふる」。点数表の役をタップして記録" : "もう振れません。点数表の役をタップして記録しよう"}</p>
        <div class="yy-btns">
          <button type="button" class="yw-btn yy-roll" id="yyRoll" ${left > 0 && !rolling && !busy ? "" : "disabled"}>🎲 ふる${left > 0 ? `（あと${left}回）` : ""}</button>
          <button type="button" class="yw-btn yy-rec" id="yyRec" ${sel >= 0 && !rolling && !busy ? "" : "disabled"}>${sel >= 0 ? `記録する（${g.opts[sel]}点）` : "役を選んで記録"}</button>
        </div></div></div>`;
  $("#yyBack")?.addEventListener("click", () => { loadStart(); });
  ctx.root.querySelectorAll("[data-hold]").forEach((b) => b.addEventListener("click", () => { if (rolling || busy) return; const i = Number(b.dataset.hold); if (g.roll >= 3) return; held[i] = !held[i]; drawGame(); }));
  ctx.root.querySelectorAll(".yy-cell.cand").forEach((td) => td.addEventListener("click", () => { if (rolling || busy) return; sel = Number(td.dataset.cat); drawGame(); }));
  $("#yyRoll")?.addEventListener("click", doRoll);
  $("#yyRec")?.addEventListener("click", doScore);
}
async function doRoll() {
  if (busy || rolling || g.roll >= 3) return;
  busy = true; rolling = true; sel = -1; drawGame();
  const t0 = Date.now();
  try {
    const r = await ctx.api("yachtRoll", { gid: g.gid, hold: held });
    await sleep(Math.max(0, ROLL_MS - (Date.now() - t0)));
    g = r;
  } catch (e) { await sleep(300); rolling = false; busy = false; return errorBack(e); }
  rolling = false; busy = false; drawGame();
}
async function doScore() {
  if (busy || rolling || sel < 0) return;
  busy = true;
  const cat = sel;
  try {
    const r = await ctx.api("yachtScore", { gid: g.gid, cat });
    g = r; held = [false, false, false, false, false]; sel = -1;
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
const rm = { roomId: "", gid: "", key: "", held: [false, false, false, false, false], sel: -1, rolling: false, busy: false, y: null, offset: 0, seenAt: 0, tm: null, started: "", sentKey: "", error: "", loading: false };

export function renderYachtRoom(boardEl, room, c) {
  injectStyles();
  rm.api = c.api; rm.uid = c.uid; rm.esc = c.esc; rm.boardEl = boardEl; rm.room = room;
  if (rm.roomId !== room.id) { Object.assign(rm, { roomId: room.id, gid: "", key: "", held: [false, false, false, false, false], sel: -1, rolling: false, busy: false, y: null, started: "", sentKey: "", error: "" }); }
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
    if (key !== rm.key) { rm.key = key; rm.held = [false, false, false, false, false]; rm.sel = -1; rm.rolling = false; }
  }
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

function roomCellHtml(i, who, y, me) {
  const card = who === 0 ? y.c0 : y.c1;
  const filled = card[i] >= 0;
  const mineTurn = !y.done && y.cur === me;
  const showCand = !filled && !y.done && y.cur === who && y.opts && y.opts[i] >= 0;
  const clickable = showCand && who === me && mineTurn;
  const cls = filled ? "filled" : showCand ? `cand${clickable ? "" : " other"}${rm.sel === i && who === me ? " sel" : ""}${y.opts[i] === 0 ? " zero" : ""}` : "";
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
function roomTrayHtml(y, mineTurn) {
  const canHold = mineTurn && y.roll < 3 && !rm.rolling && !rm.busy;
  const held = mineTurn ? rm.held : [false, false, false, false, false];
  const rack = Array.from({ length: 5 }, (_, i) => `<div class="yy-slot">${held[i] ? `<button type="button" class="yy-dbtn" data-hold="${i}">${dieHtml(y.dice[i], "held")}</button>` : ""}</div>`).join("");
  const floor = y.dice.map((v, i) => held[i] ? `<div class="yy-spot"></div>` : `<div class="yy-spot"><button type="button" class="yy-dbtn${rm.rolling && mineTurn ? " rolling" : ""}" data-hold="${i}" style="--r:${(i * 37 + y.roll * 53) % 40 - 20}deg" ${canHold ? "" : "disabled"}>${dieHtml(v)}</button></div>`).join("");
  return `<div class="yy-tray"><div class="yy-rack">${rack}</div><div class="yy-floor">${floor}</div></div>`;
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
  const left = 3 - y.roll;
  const turnName = rm.esc(String(y.names[y.cur] || ""));
  const status = y.done ? "" : mineTurn
    ? `<div class="yy-turnbar mine">あなたの番です <span id="yrTimer" class="yy-timer"></span></div>`
    : `<div class="yy-turnbar">${turnName}さんの番です <span id="yrTimer" class="yy-timer"></span></div>`;
  const play = y.done ? resultHtml(y, me) : `<div class="yy-play"><div class="yy-wood">${roomTrayHtml(y, mineTurn)}</div>
      <p class="yy-hint">${mineTurn ? (rm.sel >= 0 ? `「${rm.esc(CATS[rm.sel].name)}」に記録します` : left > 0 ? "残したいサイコロをタップでキープ → 「ふる」。点数表の役をタップして記録" : "もう振れません。点数表の役をタップして記録しよう") : "相手の操作を待っています"}</p>
      ${mineTurn ? `<div class="yy-btns"><button type="button" class="yw-btn yy-roll" id="yrRoll" ${left > 0 && !rm.rolling && !rm.busy ? "" : "disabled"}>🎲 ふる${left > 0 ? `（あと${left}回）` : ""}</button>
        <button type="button" class="yw-btn yy-rec" id="yrRec" ${rm.sel >= 0 && !rm.rolling && !rm.busy ? "" : "disabled"}>${rm.sel >= 0 ? `記録する（${y.opts[rm.sel]}点）` : "役を選んで記録"}</button></div>` : ""}</div>`;
  el.innerHTML = `${status}<div class="yy-game yy-room"><div class="yy-left-pane">${roomSheetHtml(y, me)}</div>${play}</div>`;
  el.querySelectorAll("[data-hold]").forEach((b) => b.addEventListener("click", () => { if (!mineTurn || rm.rolling || rm.busy || y.roll >= 3) return; const i = Number(b.dataset.hold); rm.held[i] = !rm.held[i]; drawRoom(); }));
  el.querySelectorAll(".yy-cell.cand[data-cat]").forEach((td) => td.addEventListener("click", () => { if (rm.rolling || rm.busy) return; rm.sel = Number(td.dataset.cat); drawRoom(); }));
  el.querySelector("#yrRoll")?.addEventListener("click", roomRoll);
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
  const y = rm.y; if (!y || rm.busy || rm.rolling || y.roll >= 3) return;
  rm.busy = true; rm.rolling = true; rm.sel = -1; drawRoom();
  const t0 = Date.now();
  try {
    const r = await rm.api("yachtRoomRoll", { roomId: rm.roomId, gid: y.gid, hold: rm.held });
    await sleep(Math.max(0, ROLL_MS - (Date.now() - t0)));
    rm.y = r.yacht; rm.offset = r.yacht.at - Date.now();
  } catch (e) { await sleep(300); roomError(e); }
  rm.rolling = false; rm.busy = false; drawRoom();
}
async function roomScore() {
  const y = rm.y; if (!y || rm.busy || rm.rolling || rm.sel < 0) return;
  rm.busy = true;
  try {
    const r = await rm.api("yachtRoomScore", { roomId: rm.roomId, gid: y.gid, cat: rm.sel });
    rm.y = r.yacht; rm.offset = r.yacht.at - Date.now(); rm.sel = -1;
    const key = `${rm.y.round}:${rm.y.cur}`; if (key !== rm.key) { rm.key = key; rm.held = [false, false, false, false, false]; }
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
  .yy-cell { background: #ffe56a; } .yy-cell.filled { background: #fff; } .yy-cell.cand { cursor: pointer; color: #8a6d00; } .yy-cell.cand.zero { color: #b9a14a; }
  .yy-cell.cand.sel { background: #ff9f1a; color: #fff; outline: 2px solid #c25e00; outline-offset: -2px; }
  .yy-sub-row th, .yy-sub-row td { background: #8a8d92; color: #fff; font-size: 12px; } .yy-sub-row.got td { background: #e0902f; }
  .yy-gap td { height: 6px; padding: 0; background: #3b3f46; border: none; }
  .yy-total th, .yy-total td { background: #3b3f46; color: #fff; font-size: 16px; }
  .yy-wood { background: linear-gradient(135deg, #b9803f, #8c5a24); border-radius: 14px; padding: 8px; box-shadow: inset 0 0 24px rgba(0,0,0,.25); }
  .yy-tray { background: #3b3f46; border-radius: 12px; padding: 6px; box-shadow: 0 6px 18px rgba(0,0,0,.35); }
  .yy-rack { display: grid; grid-template-columns: repeat(5, 1fr); gap: 3px; background: #2a2d33; border-radius: 8px; padding: 3px; margin-bottom: 6px; }
  .yy-slot { aspect-ratio: 1; background: #1f2126; border-radius: 5px; display: flex; align-items: center; justify-content: center; }
  .yy-floor { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; background: radial-gradient(circle at 50% 40%, #a42a2a, #6e1414); border-radius: 10px; padding: 8px 4px; min-height: 130px; align-content: center; }
  .yy-spot { aspect-ratio: 1; display: flex; align-items: center; justify-content: center; }
  .yy-dbtn { border: none; background: none; padding: 0; cursor: pointer; width: 100%; max-width: 56px; transform: rotate(var(--r, 0deg)); } .yy-dbtn:disabled { cursor: default; }
  .yy-dbtn.rolling { animation: yy-shake .13s linear infinite; }
  @keyframes yy-shake { 0% { transform: translate(0, 0) rotate(0deg); } 25% { transform: translate(5px, -6px) rotate(40deg); } 50% { transform: translate(-6px, 4px) rotate(-30deg); } 75% { transform: translate(4px, 6px) rotate(70deg); } 100% { transform: translate(0, 0) rotate(0deg); } }
  .yy-die { display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(3, 1fr); aspect-ratio: 1; width: 100%; background: #fafafa; border-radius: 22%; box-shadow: inset 0 -3px 0 rgba(0,0,0,.12), 0 3px 5px rgba(0,0,0,.35); padding: 12%; box-sizing: border-box; }
  .yy-die i { display: block; border-radius: 50%; margin: 16%; } .yy-die i.on { background: #222; } .yy-die[data-v="1"] i.on { background: #d62828; }
  .yy-dbtn .held, .yy-slot .yy-die { width: 100%; }
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
  @media (prefers-reduced-motion: reduce) { .yy-dbtn.rolling { animation: none; } }
  `;
  const el = document.createElement("style"); el.id = "yy-style"; el.textContent = css; document.head.appendChild(el);
}
