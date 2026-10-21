/* =========================================================
   🎫 先着ゲーム（確変台の当日分の先着。yukaku.js の「🎫 当日の先着はこちら」から開く全画面）

   画面：先着ページ（参加ボタン＋ランキング）→ 待機画面（カウントダウン・カード番号）→ 0 になったら「先着はこちら」
        → 接続画面 → チケット選択 → 〇〇を選択 → カード番号の入力 → 同意10個 →「チケットを取る」→ 結果
   ・問題（カード番号・接続画面の出方・お題・同意の並び）・タイム・枠の割り当て・ランキングは、すべて通知 Worker（/yuslot の battle*）が決める。
     ここは表示と、押した順番・時刻の記録を送るだけ。
   ・Firebase には触れない。Worker に聞くのは、ページを開いたとき・参加を押したとき・スタート・おしまいのときだけ。
========================================================= */

let deps = null;          // { api, esc, machineName(), onClose }
let ov = null;            // 全画面のカバー
let S = null;             // 画面の状態
let offset = 0;           // サーバーの時計とのずれ
let tick = null;
let stylesDone = false;

const pad = (n) => String(n).padStart(2, "0");
const nowMs = () => Date.now() + offset;
function hm(ms) { const d = new Date(ms + 9 * 3600000); return `${d.getUTCHours()}:${pad(d.getUTCMinutes())}`; }
function md(day) { const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day || ""); return m ? `${Number(m[1])}/${Number(m[2])}` : ""; }
function mdms(ms) { const d = new Date(ms + 9 * 3600000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; }
const sec = (ms) => (Math.max(0, ms) / 1000).toFixed(2);
const ORDER = ["conn0", "select", "conn1", "puzzle", "conn2", "slide", "conn3", "order", "conn4", "card", "conn5", "consent"];
const CONSENTS = [
  "利用規約に同意する", "プライバシーポリシーに同意する", "キャンセル・返金ができないことに同意する", "転売をしないことに同意する", "1人1枚までであることに同意する",
  "ロボットではないことに同意する", "開始時間を守ることに同意する", "ゆうChatを愛していることに同意する", "コインを使いすぎないことに同意する", "本当に購入することに同意する"
];
const CONN_MSG = ["アクセスが集中しています", "ただいま大変混み合っています", "接続がタイムアウトしました", "混雑のため、つながりにくくなっています"];
const ERR = {
  not_open: "まだ始まっていません。", not_published: "ただいま準備中です。", no_event: "まだ確変台の開催前です。", busy: "混み合っています。もう一度お試しください。",
  gone: "この枠は、もう埋まりました。", rule: "この枠は取れません（時間が重なっているか、1日に取れる枠の上限です）。",
  stale: "画面が古くなりました。もう一度はじめます。", bad_proof: "操作が正しく確認できませんでした。もう一度お試しください。", too_fast: "操作が正しく確認できませんでした。もう一度お試しください。", no_game: "ゲームが始まっていません。"
};

export function ticketInit(d) { deps = d; injectStyles(); }
export function ticketClose() {
  if (tick) { clearInterval(tick); tick = null; }
  if (ov) { ov.remove(); ov = null; document.body.classList.remove("yt-lock"); }
  S = null;
  deps && deps.onClose && deps.onClose();
}

export async function ticketOpen() {
  if (ov) return;
  S = { screen: "page", status: null, ranking: null, err: "", busy: false, game: null, result: null, wasWait: false };
  ov = document.createElement("div");
  ov.className = "yt-ov";
  ov.innerHTML = `<div class="yt-box"><div class="yt-main"></div></div>`;
  document.body.appendChild(ov); document.body.classList.add("yt-lock");
  ov.addEventListener("click", onClick);
  ov.addEventListener("pointerdown", onPointerDown);
  ov.addEventListener("gesturestart", (e) => e.preventDefault());                         // iOS Safari：2本指の拡大も止める
  ov.addEventListener("dblclick", (e) => e.preventDefault());
  tick = setInterval(onTick, 100);
  render();
  await loadPage();
}

async function loadPage() {
  const mine = S;
  try {
    const [status, ranking, board] = await Promise.all([deps.api("battleStatus"), deps.api("battleRanking").catch(() => null), deps.api("battleBoard").catch(() => null)]);
    if (S !== mine) return;
    if (typeof status.serverNowMs === "number") offset = status.serverNowMs - Date.now();
    S.status = status; S.ranking = ranking; S.err = "";
    if (board && board.ok) { S.board = board; S.boardAt = Date.now(); }
  } catch (e) { if (S !== mine) return; S.err = ERR[e.code] || `読み込めませんでした（${e.code || "エラー"}）`; }
  render();
}

/* ---------------- 画面の描き分け ---------------- */
function render() {
  if (!ov || !S) return;
  const main = ov.querySelector(".yt-main");
  const esc = deps.esc;
  let html = "";
  if (S.screen === "page") html = pageHtml(esc);
  else if (S.screen === "wait") html = waitHtml();
  else if (S.screen === "game") html = gameHtml(esc);
  else if (S.screen === "result") html = resultHtml(esc);
  main.innerHTML = html;
  ov.dataset.screen = S.screen === "game" ? S.game.stage : S.screen;
  updateLive();
}
const closeBtn = `<button type="button" class="yt-x" data-yt="close" aria-label="閉じる">✕</button>`;

function pageHtml(esc) {
  const st = S.status;
  let body = "";
  if (S.err) body += `<div class="yt-err">${esc(S.err)}</div>`;
  if (!st && !S.err) body += `<div class="yt-sub">読み込み中…</div>`;
  if (st && !st.active) body += `<div class="yt-sub">まだ確変台の開催前です。</div>`;
  if (st && st.active) {
    const T = st.times, now = nowMs();
    const quick = st.slots.map((x) => `<span class="yt-chip">${hm(x.s)}〜${hm(x.e)}${x.mine ? " ⭐" : ""}</span>`).join("");
    body += `<div class="yt-card"><div class="yt-h2">今日の先着チケット（${esc(deps.machineName())}）</div>
      <div class="yt-chips">${quick}</div>
      <div class="yt-sub">${hm(T.goAt)} スタート・1人1枚・早い者勝ち。待機画面は ${hm(T.waitOpen)} から入れます。</div>`;
    if (st.rec && st.rec.done) {
      body += `<div class="yt-done">${st.rec.got ? `🎉 今日の先着：獲得済み（タイム ${sec(st.rec.ms)} 秒）` : `今日の先着は終了しました（タイム ${sec(st.rec.ms)} 秒）`}</div>`;
    } else if (st.allTaken) {
      body += `<div class="yt-done">今日の先着チケットは完売しました。</div>`;
    } else {
      const can = now >= T.waitOpen;
      body += `<button type="button" class="yt-btn big" data-yt="join" ${can && !S.busy ? "" : "disabled"}>${can ? (S.busy ? "準備中…" : "🎫 先着に参加する") : `${hm(T.waitOpen)} から参加できます`}</button>`;
      if (st.rec && !st.rec.done) body += `<div class="yt-sub">※ゲームの途中でやめた人も、続きから参加できます（タイムは進み続けています）。</div>`;
    }
    if (st.slots.length) body += `<button type="button" class="yt-btn sub" data-yt="practice" ${S.busy ? "disabled" : ""}>🎮 練習する（タイム・チケットは本番に関係なし）</button>`;
    body += `</div>`;
  }
  body += boardHtml(esc);
  body += rankingHtml(esc);
  return `<div class="yt-head">${closeBtn}<div class="yt-title">🎫 当日の先着</div></div>${body}`;
}

const KIND = { pre: "前日抽選", lot: "当日抽選", quick: "先着" };
/* 今日の予約状況（枠ごと）。誰が持っているか（NPC かどうか）は出さない。キャンセルが出た枠だけ「取る」ボタン */
function boardHtml(esc) {
  const b = S.board;
  if (!b || !b.active) return "";
  const now = nowMs();
  const rows = b.rows.map((r) => {
    let st;
    if (r.state === "mine") st = `<span class="yt-bs mine">⭐ あなたの枠</span>`;
    else if (r.state === "open") st = `<span class="yt-bs open">🟢 キャンセルが出ました！</span><button type="button" class="yt-claim" data-yt="claim" data-i="${r.i}" ${S.busy ? "disabled" : ""}>🎫 取る</button>`;
    else if (r.state === "quick") st = `<span class="yt-bs quick">${S.status && S.status.times && now < S.status.times.goAt ? `${hm(S.status.times.goAt)} から先着ゲームで` : "先着ゲームで取れます"}</span>`;
    else if (r.state === "ended") st = `<span class="yt-bs ended">終了</span>`;
    else st = `<span class="yt-bs filled">予約が埋まっています</span>`;
    return `<div class="yt-brow ${r.state} ${now >= r.e ? "past" : ""}"><span class="yt-btime">${hm(r.s)}〜${hm(r.e)}</span><span class="yt-bkind">${KIND[r.kind] || ""}</span>${st}</div>`;
  }).join("");
  return `<div class="yt-card"><div class="yt-h2">📋 今日の予約状況 <button type="button" class="yt-mini" data-yt="board-reload">更新</button></div>
    ${S.boardMsg ? `<div class="yt-err">${esc(S.boardMsg)}</div>` : ""}
    <div class="yt-board">${rows || `<div class="yt-sub">まだ、表に出せる枠がありません。</div>`}</div>
    <label class="yt-chk"><input type="checkbox" data-yt="cxnotify" ${b.notify ? "checked" : ""}> 🔔 キャンセルが出たら通知する</label></div>`;
}
async function refreshBoard() {
  if (!S || S.boardBusy) return;
  const mine = S; S.boardBusy = true;
  try {
    const b = await deps.api("battleBoard");
    if (S !== mine) return;
    if (typeof b.serverNowMs === "number") offset = b.serverNowMs - Date.now();
    const changed = JSON.stringify(b.rows) !== JSON.stringify(S.board && S.board.rows);
    if (!S.board || changed) { S.board = { ...b, notify: S.board && S.boardNotifyTouched ? S.board.notify : b.notify }; if (S.screen === "page") render(); }
    S.boardAt = Date.now();
  } catch (_) { /* 表示だけ。次の読み直しを待つ */ }
  if (S === mine) S.boardBusy = false;
}
const MEDAL = ["🥇", "🥈", "🥉"];
function rankTable(esc, rows, withPrize) {
  return `<table class="yt-rank"><thead><tr><th>順位</th><th>名前</th><th>タイム</th><th>${withPrize ? "賞金" : "記録日"}</th></tr></thead><tbody>${rows.map((x) =>
    `<tr class="${x.me ? "me" : ""}"><td>${x.rank <= 3 ? MEDAL[x.rank - 1] : x.rank}</td><td>${esc(x.name)}</td><td>${sec(x.ms)}秒</td><td>${withPrize ? (x.prize ? `${x.prize}コイン` : md(x.day)) : md(x.day)}</td></tr>`).join("")}</tbody></table>`;
}
function rankingHtml(esc) {
  const r = S.ranking, tab = S.tab || "week";
  let h = `<div class="yt-card"><div class="yt-tabs"><button type="button" class="yt-tab ${tab === "week" ? "on" : ""}" data-yt="tab" data-v="week">🏆 今週のランキング</button><button type="button" class="yt-tab ${tab === "all" ? "on" : ""}" data-yt="tab" data-v="all">📈 通算ベスト</button></div>`;
  if (!r) return h + `<div class="yt-sub">読み込み中…</div></div>`;
  if (tab === "week") {
    const w = r.week;
    if (!w) return h + `<div class="yt-sub">今週のランキングを読み込めませんでした。</div></div>`;
    if (r.last) {
      h += `<div class="yt-last"><div class="yt-h2">🎉 先週の結果発表（${mdms(r.last.startMs)}〜${mdms(r.last.endMs - 1)}・参加 ${r.last.total}人）</div>${r.last.top.map((t) =>
        `<div class="yt-last-row ${t.me ? "me" : ""}"><span>${MEDAL[t.rank - 1]} ${esc(t.name)}</span><span>${sec(t.ms)}秒</span><b>${t.prize}コイン</b></div>`).join("")}
        ${r.last.me && r.last.me.prize ? `<div class="yt-me">🎁 おめでとう！ 先週は${r.last.me.rank}位で、${r.last.me.prize}コインをお渡ししました</div>` : ""}</div>`;
    }
    h += `<div class="yt-prize">毎週月曜 7:00 に結果発表！ ${MEDAL.map((m, i) => `${m} ${w.prizes[i]}コイン`).join("　")}</div>
      <div class="yt-sub">今週（次の結果発表：${mdms(w.endMs)}（月）7:00）の自己ベストです。</div>`;
    if (!w.rows.length) h += `<div class="yt-sub">まだ記録がありません。</div>`;
    else {
      h += rankTable(esc, w.rows, true);
      if (w.me && w.me.rank > w.rows.length) h += `<div class="yt-me">あなた：${w.me.rank}位（${sec(w.me.ms)}秒）</div>`;
    }
    h += w.pendingMs ? `<div class="yt-sub">今日の記録（${sec(w.pendingMs)}秒）は 12:00 にランキングへ反映されます。</div>` : `<div class="yt-sub">当日の記録は 12:00 にランキングへ反映されます。</div>`;
    return h + `</div>`;
  }
  h += `<div class="yt-sub">過去の記録も含めた、一人ひとりの自己ベストです（名前つき）。</div>`;
  if (!r.rows.length) h += `<div class="yt-sub">まだ記録がありません。</div>`;
  else {
    h += rankTable(esc, r.rows, false);
    if (r.me && r.me.rank > r.rows.length) h += `<div class="yt-me">あなた：${r.me.rank}位（${sec(r.me.ms)}秒・${md(r.me.day)}）</div>`;
  }
  h += r.pendingMs ? `<div class="yt-sub">今日の記録（${sec(r.pendingMs)}秒）は 12:00 にランキングへ反映されます。</div>` : `<div class="yt-sub">当日の記録は 12:00 にランキングへ反映されます。</div>`;
  return h + `</div>`;
}

/* 待機画面の「0 になる時刻」とカード番号。練習のときは、いまから5秒後（本番と同じ流れを、5秒前から体験できる） */
const waitInfo = () => (S.practice ? { goAt: S.practice.goAt, card: S.practice.card } : { goAt: S.status.times.goAt, card: S.status.card });
function waitHtml() {
  const esc = deps.esc, w = waitInfo(), pr = !!S.practice;
  const ready = nowMs() >= w.goAt;
  return `<div class="yt-head">${closeBtn}<div class="yt-title">${pr ? "🎮 練習：待機中" : "⏳ 待機中"}</div></div>
    ${pr ? `<div class="yt-practice yt-practice-wait">🎮 練習です：タイムはランキングに載りません（チケットも取れません）</div>` : ""}
    <div class="yt-card center"><div class="yt-sub">スタートまで</div>
      <div class="yt-count" id="yt-count">0:00</div>
      <div class="yt-sub">${pr ? "本番と同じ流れで練習できます。0 になると「先着はこちら」ボタンが出ます。" : `${hm(w.goAt)} ちょうどに「先着はこちら」ボタンが出ます。`}<br>押した瞬間からタイムがスタートします！</div>
      ${cardHtml(w.card)}
      <div class="yt-sub">このカード番号は、ゲーム中は画面の上にも出ます。<br>（あとで3桁を入力します）</div>
      <div id="yt-go">${ready ? goBtn() : ""}</div>
      ${S.err ? `<div class="yt-err">${esc(S.err)}</div>` : ""}
    </div>`;
}
const goBtn = () => `<button type="button" class="yt-btn big pulse" data-yt="go" ${S.busy ? "disabled" : ""}>${S.busy ? "接続中…" : "🎫 先着はこちら"}</button>`;
const cardHtml = (num) => `<div class="yt-credit"><div class="yt-credit-top">YUU CARD</div><div class="yt-credit-no">•••• •••• •••• <b>${num}</b></div><div class="yt-credit-bot">あなたのカード番号（3桁）：<b>${num}</b></div></div>`;

/* ----- ゲーム中 ----- */
function targetLabel(g) {
  const s = g.slot != null ? g.slots.find((x) => x.i === g.slot) : null;
  return s ? `${hm(s.s)}〜${hm(s.e)} の確変台チケット × 1枚` : "確変台チケット × 1枚";
}
function gameBar(g) {
  return `<div class="yt-bar"><div class="yt-bar-l"><span class="yt-tgt">🎯 ${deps.esc(targetLabel(g))}</span></div>
    <div class="yt-bar-r"><span class="yt-bar-card">💳 カード番号 <b>${g.card}</b></span><span class="yt-time" id="yt-time">⏱ 0.0秒</span></div>${closeBtn}</div>`;
}
function gameHtml(esc) {
  const g = S.game, st = g.stage;
  let body = "";
  if (st.startsWith("conn")) {
    const n = g.plan.conn[Number(st[4])], done = g.connOk;
    const msg = CONN_MSG[(g.tries + Number(st[4])) % CONN_MSG.length];
    body = `<div class="yt-page conn"><div class="yt-conn-ico">${done ? "✅" : "🌐"}</div>
      <div class="yt-h1">${done ? "接続しました" : esc(msg)}</div>
      <div class="yt-sub">${done ? "" : "しばらくしてからリロードしてください。<br>（つながるまで何度でも押してください）"}</div>
      ${done ? "" : `<button type="button" class="yt-btn big" data-yt="reload" ${g.connBusy ? "disabled" : ""}>${g.connBusy ? "読み込み中…" : "🔄 リロード"}</button>`}</div>`;
    void n;
  } else if (st === "select") {
    const anyOpen = g.slots.some((x) => !g.closed.some((c) => c.i === x.i));
    body = `<div class="yt-page"><div class="yt-h1">どのチケットを買いますか？</div><div class="yt-sub">1人1枚まで。買いたいチケットを選んでください。</div>
      ${g.haveQuick ? `<div class="yt-err">※すでに今日の先着チケットを持っています。ここから先は、タイムだけの挑戦になります。</div>` : ""}
      <div class="yt-tickets">${g.slots.map((x) => {
        const c = g.closed.find((y) => y.i === x.i);
        const dis = !!c && anyOpen && !g.haveQuick;
        return `<button type="button" class="yt-ticket ${g.slot === x.i ? "sel" : ""}" data-yt="slot" data-i="${x.i}" ${dis ? "disabled" : ""}>
          <span class="yt-ticket-name">🌈 ${esc(deps.machineName())}</span><span class="yt-ticket-time">${hm(x.s)}〜${hm(x.e)}</span>
          <span class="yt-ticket-sub">${dis ? (c.why === "taken" ? "売り切れ" : c.why === "started" ? "受付終了" : "選べません") : "× 1枚"}</span></button>`;
      }).join("")}</div>
      <button type="button" class="yt-btn big" data-yt="next-select" ${g.slot == null ? "disabled" : ""}>次へ</button></div>`;
  } else if (st === "puzzle") {
    body = `<div class="yt-page"><div class="yt-sub">ボット対策のため、確認にご協力ください（1つ目）</div><div class="yt-h1">${esc(g.plan.puzzle.label)}</div>
      ${g.wrong ? `<div class="yt-err">違います。もう一度選んでください。</div>` : ""}
      <div class="yt-emojis">${g.perm.map((idx) => `<button type="button" class="yt-emoji ${g.pick === idx ? "sel" : ""}" data-yt="emoji" data-i="${idx}">${g.plan.puzzle.options[idx]}</button>`).join("")}</div>
      <button type="button" class="yt-btn big" data-yt="next-puzzle" ${g.pick == null ? "disabled" : ""}>次へ</button></div>`;
  } else if (st === "slide") {
    const sl = g.plan.slide;
    body = `<div class="yt-page"><div class="yt-sub">ボット対策のため、確認にご協力ください（2つ目）</div><div class="yt-h1">${esc(sl.label)}</div>
      <div class="yt-slide ${g.slideDone ? "done" : ""}" id="yt-slide"><span class="yt-slide-goal">${g.slideDone ? "✅" : sl.goal}</span>
        <span class="yt-slide-handle" data-yt="slide-handle" id="yt-handle" ${g.slideDone ? 'style="left:calc(100% - 64px)"' : ""}>${sl.emoji}</span></div>
      <div class="yt-sub">${g.slideDone ? "✅ 移せました！" : `指でつかんで、右の ${sl.goal} まで動かしてください。`}</div>
      <button type="button" class="yt-btn big" data-yt="next-slide" ${g.slideDone ? "" : "disabled"}>次へ</button></div>`;
  } else if (st === "order") {
    body = `<div class="yt-page"><div class="yt-sub">ボット対策のため、確認にご協力ください（3つ目）</div><div class="yt-h1">数字を小さい順にタップしてください</div>
      ${g.wrong ? `<div class="yt-err">順番が違います。はじめからやり直してください。</div>` : ""}
      <div class="yt-nums">${g.plan.order.map((n) => { const k = g.ordTaps.indexOf(n); return `<button type="button" class="yt-num ${k >= 0 ? "on" : ""}" data-yt="num" data-n="${n}" ${k >= 0 ? "disabled" : ""}>${n}${k >= 0 ? `<small>${k + 1}番目</small>` : ""}</button>`; }).join("")}</div>
      <button type="button" class="yt-btn big" data-yt="next-order" ${g.ordTaps.length === g.plan.order.length ? "" : "disabled"}>次へ</button></div>`;
  } else if (st === "card") {
    const dots = [0, 1, 2].map((i) => `<span class="yt-dig ${g.digits[i] ? "on" : ""}">${g.digits[i] || ""}</span>`).join("");
    body = `<div class="yt-page"><div class="yt-h1">お支払い：カード番号の入力</div><div class="yt-sub">画面の上に出ている「カード番号」（3桁）を入力してください。</div>
      ${g.wrong ? `<div class="yt-err">番号が違います。もう一度入力してください。</div>` : ""}
      <div class="yt-digs">${dots}</div>
      <div class="yt-keys">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" class="yt-key" data-yt="key" data-k="${n}">${n}</button>`).join("")}
        <button type="button" class="yt-key sub" data-yt="key" data-k="back">⌫</button><button type="button" class="yt-key" data-yt="key" data-k="0">0</button>
        <button type="button" class="yt-key ok" data-yt="key" data-k="ok" ${g.digits.length === 3 ? "" : "disabled"}>決定</button></div></div>`;
  } else {
    const all = g.pressed.length === g.plan.consent.length;
    body = `<div class="yt-page"><div class="yt-h1">ご購入前の確認</div><div class="yt-sub">すべての項目に同意すると、購入できます（${g.pressed.length} / ${g.plan.consent.length}）。</div>
      <div class="yt-consents">${g.plan.consent.map((idx) => `<button type="button" class="yt-consent ${g.pressed.includes(idx) ? "on" : ""}" data-yt="consent" data-i="${idx}"><span>${g.pressed.includes(idx) ? "✅" : "⬜"}</span>${esc(CONSENTS[idx])}</button>`).join("")}</div>
      <button type="button" class="yt-btn big pulse" data-yt="buy" ${all && !S.busy ? "" : "disabled"}>${S.busy ? "確認中…" : "🎫 チケットを取る"}</button></div>`;
  }
  return `${gameBar(g)}${g.practice ? `<div class="yt-practice">🎮 練習中：タイムはランキングに載りません（チケットも取れません）</div>` : ""}<div class="yt-stage">${body}</div>`;
}

function resultHtml(esc) {
  const r = S.result, g = S.game;
  const back = `<button type="button" class="yt-btn big" data-yt="to-page">🏆 ランキングを見る</button>`;
  if (r.kind === "cgot") {
    return `<div class="yt-head">${closeBtn}<div class="yt-title">結果</div></div><div class="yt-card center win"><div class="yt-big">🎉</div><div class="yt-h1">キャンセル枠を獲得しました！</div>
      <div class="yt-sub">${hm(r.slot.s)}〜${hm(r.slot.e)} の${esc(deps.machineName())} の枠です。<br>時間になったら、ゆうスロの台で遊べます🌈</div>
      <button type="button" class="yt-btn big" data-yt="to-page">戻る</button></div>`;
  }
  if (r.kind === "csold") {
    return `<div class="yt-head">${closeBtn}<div class="yt-title">結果</div></div><div class="yt-card center lose"><div class="yt-big">😢</div><div class="yt-h1">ご希望のチケットは売り切れました。</div>
      <button type="button" class="yt-btn big" data-yt="to-page">戻る</button></div>`;
  }
  if (r.kind === "got") {
    const s = (g ? g.slots : S.status.slots).find((x) => x.i === r.slot);
    return `<div class="yt-head">${closeBtn}<div class="yt-title">結果</div></div><div class="yt-card center win"><div class="yt-big">🎉</div><div class="yt-h1">チケットを獲得しました！</div>
      <div class="yt-sub">${s ? `${hm(s.s)}〜${hm(s.e)} の` : ""}${esc(deps.machineName())} チケット × 1枚<br>時間になったら、ゆうスロの台で遊べます🌈</div>
      <div class="yt-result-time">タイム <b>${sec(r.ms)}</b> 秒</div><div class="yt-sub">${rankNote()}</div>${back}</div>`;
  }
  if (r.kind === "sold") {
    return `<div class="yt-head">${closeBtn}<div class="yt-title">結果</div></div><div class="yt-card center lose"><div class="yt-big">😢</div><div class="yt-h1">ご希望のチケットは売り切れました。</div>
      <div class="yt-sub">今日の先着チケットは、すべてなくなりました。</div>
      <div class="yt-result-time">タイム <b>${sec(r.ms)}</b> 秒</div><div class="yt-sub">${rankNote()}</div>${back}</div>`;
  }
  if (r.kind === "practice") {
    return `<div class="yt-head">${closeBtn}<div class="yt-title">練習の結果</div></div><div class="yt-card center"><div class="yt-big">🎮</div><div class="yt-h1">練習おつかれさま！</div>
      <div class="yt-result-time">タイム <b>${sec(r.ms)}</b> 秒</div>
      <div class="yt-sub">※練習のタイムは、ランキングには載りません。チケットも取れません。<br>本番は ${hm(S.status.times.goAt)} スタート！ 何回でも練習できます。</div>
      <button type="button" class="yt-btn big pulse" data-yt="practice">🎮 もう一度練習する</button><button type="button" class="yt-btn sub" data-yt="to-page">戻る</button></div>`;
  }
  if (r.kind === "retry") {
    return `<div class="yt-head">${closeBtn}<div class="yt-title">結果</div></div><div class="yt-card center lose"><div class="yt-big">😢</div><div class="yt-h1">ご希望のチケットは売り切れました。</div>
      <div class="yt-sub">${r.reason === "overlap" || r.reason === "day_limit" ? "その枠は選べませんでした。" : ""}まだ他のチケットが残っています！<br>もう一度、はじめから挑戦できます。（タイムは進み続けています）</div>
      <div class="yt-result-time">⏱ <b id="yt-time2">0.00</b> 秒</div>
      <button type="button" class="yt-btn big pulse" data-yt="retry">🎫 もう一度挑戦する</button></div>`;
  }
  return `<div class="yt-head">${closeBtn}<div class="yt-title">結果</div></div><div class="yt-card center"><div class="yt-big">⚠️</div><div class="yt-h1">${esc(ERR[r.code] || `うまくいきませんでした（${r.code || "エラー"}）`)}</div>
    ${r.claim ? `<button type="button" class="yt-btn big" data-yt="to-page">戻る</button>` : `<button type="button" class="yt-btn big" data-yt="restart">もう一度はじめる</button>`}</div>`;
}
const rankNote = () => (nowMs() >= (S.ranking && S.ranking.revealAtMs || 0) && S.ranking ? "ランキングに反映されました。" : "ランキングには 12:00 に反映されます。");

/* ---------------- 1秒に10回：カウントダウン・タイム ---------------- */
function onTick() {
  if (!S || !ov) return;
  if (S.screen === "page" && S.status && S.status.active && !S.busy) {
    const can = nowMs() >= S.status.times.waitOpen;
    if (can !== S.canJoin) { S.canJoin = can; render(); }
  }
  if (S.screen === "page" && S.board && !S.busy && Date.now() - (S.boardAt || 0) > 15000) refreshBoard();     // 表は15秒おきに読み直す（キャンセルが出たら、すぐ取れるように）
  if (S.screen === "wait") {
    const remain = waitInfo().goAt - nowMs();
    if (remain <= 0 && !S.goShown) { S.goShown = true; const el = ov.querySelector("#yt-go"); if (el) el.innerHTML = goBtn(); }
  }
  updateLive();
}
function updateLive() {
  if (!S || !ov) return;
  if (S.screen === "wait") {
    const el = ov.querySelector("#yt-count");
    if (el) { const remain = Math.max(0, waitInfo().goAt - nowMs()); const s = Math.ceil(remain / 1000); el.textContent = remain <= 0 ? "スタート！" : `${Math.floor(s / 60)}:${pad(s % 60)}`; }
  }
  if (S.screen === "game" && S.game) { const el = ov.querySelector("#yt-time"); if (el) el.textContent = `⏱ ${((nowMs() - S.game.st) / 1000).toFixed(1)}秒`; }
  if (S.screen === "result" && S.result && S.result.kind === "retry" && S.game) { const el = ov.querySelector("#yt-time2"); if (el) el.textContent = sec(nowMs() - S.game.st); }
}

/* ---------------- 操作 ---------------- */
function shuffle4() { const a = [0, 1, 2, 3]; for (let i = 3; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const mark = (g) => g.marks.push(Math.round(performance.now() - g.t0));

function newGame(r, prev) {
  return { att: r.att, st: r.st != null ? r.st : prev.st, plan: r.plan, slots: r.slots, closed: r.closed || [], haveQuick: !!r.haveQuick, card: r.card, t0: performance.now(), marks: [],
    stage: "conn0", connOk: false, connBusy: false, tries: 0, slot: null, pick: null, perm: [0, 1, 2, 3], wrong: false, digits: "", pressed: [], slideDone: false, ordTaps: [] };
}
function goStage(name) {
  const g = S.game; if (!g) return;
  g.stage = name; g.wrong = false;
  if (name.startsWith("conn")) { g.connLeft = g.plan.conn[Number(name[4])]; g.connBusy = false; g.connOk = false; if (g.connLeft <= 0) return goStage(ORDER[ORDER.indexOf(name) + 1]); }
  render();
}
function beginGame(r) {
  S.game = newGame(r, S.game || {}); S.screen = "game"; S.busy = false; S.err = "";
  goStage("conn0");
}

async function startGame() {
  if (S.busy) return;
  S.busy = true; S.err = ""; render();
  const mine = S;
  try {
    const r = await deps.api("battleStart");
    if (S !== mine) return;
    if (typeof r.serverNowMs === "number") offset = r.serverNowMs - Date.now();
    if (r.soldOut) { S.busy = false; S.screen = "page"; await loadPage(); if (S === mine) { S.err = ""; } return; }
    if (r.done) { S.busy = false; S.result = r.rec.got ? { kind: "got", slot: r.rec.slot, ms: r.rec.ms } : { kind: "sold", ms: r.rec.ms }; S.screen = "result"; await refreshRanking(); render(); return; }
    beginGame(r);
  } catch (e) {
    if (S !== mine) return;
    S.busy = false; S.err = ERR[e.code] || `うまくいきませんでした（${e.code || "エラー"}）`; render();
  }
}
/* 練習：サーバーが問題だけ作って返す（何も保存しない）。待機画面の5秒前から始まり、0 で「先着はこちら」→本番と同じ流れ。タイムは端末で測るだけで、どこにも送らない */
async function startPractice() {
  if (S.busy) return;
  S.busy = true; S.err = ""; render();
  const mine = S;
  try {
    const r = await deps.api("battlePractice");
    if (S !== mine) return;
    if (typeof r.serverNowMs === "number") offset = r.serverNowMs - Date.now();
    S.practice = { plan: r.plan, card: r.card, goAt: nowMs() + 5000 };
    S.game = null; S.result = null; S.busy = false; S.goShown = false; S.screen = "wait"; render();
  } catch (e) {
    if (S !== mine) return;
    S.busy = false; S.err = ERR[e.code] || `うまくいきませんでした（${e.code || "エラー"}）`; render();
  }
}
function beginPractice() {
  const p = S.practice; if (!p) return;
  const g = newGame({ att: 0, st: nowMs(), plan: p.plan, slots: (S.status && S.status.slots) || [], closed: [], card: p.card }, {});
  g.practice = true;
  S.game = g; S.screen = "game"; S.busy = false;
  goStage("conn0");
}
/* キャンセルの出た枠を取る：先着と同じミニゲーム（全工程）。ランキングには載らない */
async function startClaim(i) {
  if (S.busy) return;
  S.busy = true; S.boardMsg = ""; render();
  const mine = S;
  try {
    const r = await deps.api("claimStart", { slot: i });
    if (S !== mine) return;
    if (typeof r.serverNowMs === "number") offset = r.serverNowMs - Date.now();
    const g = newGame({ att: r.att, st: r.st, plan: r.plan, slots: [r.slot], closed: [], card: r.card }, {});
    g.claim = r.slot.i; g.slot = r.slot.i;
    S.game = g; S.result = null; S.practice = null; S.screen = "game"; S.busy = false;
    goStage("conn0");
  } catch (e) {
    if (S !== mine) return;
    S.busy = false; S.boardMsg = ERR[e.code] || `うまくいきませんでした（${e.code || "エラー"}）`; render();
    refreshBoard();
  }
}
async function refreshRanking() { try { S.ranking = await deps.api("battleRanking"); } catch (_) { /* 表示だけ */ } }

async function buy() {
  const g = S.game; if (!g || S.busy) return;
  mark(g);
  if (g.claim != null) {   // キャンセル枠：ランキングには載らない。取れなければ「売り切れ」
    S.busy = true; render();
    const mine = S;
    try {
      const r = await deps.api("claimFinish", { att: g.att, slot: g.claim, ans: g.plan.puzzle.answer, ord: g.ordTaps, card: String(g.card), t: g.marks });
      if (S !== mine) return;
      S.busy = false; S.result = r.got ? { kind: "cgot", slot: r.slot } : { kind: "csold" }; S.screen = "result"; render();
    } catch (e) {
      if (S !== mine) return;
      S.busy = false; S.result = { kind: "error", code: e.code, claim: true }; S.screen = "result"; render();
    }
    return;
  }
  if (g.practice) { S.result = { kind: "practice", ms: Math.round(nowMs() - g.st) }; S.screen = "result"; render(); return; }
  S.busy = true; render();
  const mine = S;
  try {
    const r = await deps.api("battleFinish", { att: g.att, slot: g.slot, ans: g.plan.puzzle.answer, ord: g.ordTaps, card: String(g.card), t: g.marks });
    if (S !== mine) return;
    if (typeof r.serverNowMs === "number") offset = r.serverNowMs - Date.now();
    S.busy = false;
    if (r.done) { S.result = r.got ? { kind: "got", slot: r.slot, ms: r.ms } : { kind: "sold", ms: r.ms }; await refreshRanking(); if (S !== mine) return; }
    else S.result = { kind: "retry", next: r, reason: r.reason };
    S.screen = "result"; render();
  } catch (e) {
    if (S !== mine) return;
    S.busy = false; S.result = { kind: "error", code: e.code }; S.screen = "result"; render();
  }
}

/* 「〇〇を右に移してください」：指（マウス）でつかんで右のゴールまで動かす。手前で離すと、もとに戻る */
function onPointerDown(ev) {
  const h = ev.target.closest && ev.target.closest('[data-yt="slide-handle"]');
  if (!h || !S || !S.game || S.game.stage !== "slide" || S.game.slideDone) return;
  ev.preventDefault();
  const g = S.game, tr = ov.querySelector("#yt-slide").getBoundingClientRect(), max = tr.width - h.offsetWidth;
  const grab = ev.clientX - h.getBoundingClientRect().left;
  try { h.setPointerCapture(ev.pointerId); } catch (_) { /* 古いブラウザは、そのまま */ }
  h.classList.add("drag");
  const move = (e) => { const x = Math.min(max, Math.max(0, e.clientX - tr.left - grab)); h.style.left = `${x}px`; h._x = x; };
  const up = () => {
    h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); h.removeEventListener("pointercancel", up); h.classList.remove("drag");
    if (!(S && S.game === g && g.stage === "slide")) return;
    if ((h._x || 0) >= max * 0.92) { g.slideDone = true; render(); } else { h.style.left = "0px"; h._x = 0; }
  };
  h.addEventListener("pointermove", move); h.addEventListener("pointerup", up); h.addEventListener("pointercancel", up);
}

async function onClick(ev) {
  const b = ev.target.closest("[data-yt]");
  if (!b || !S || b.disabled) return;
  const act = b.getAttribute("data-yt"), g = S.game;
  if (act === "close") return ticketClose();
  if (act === "join") {
    if (S.busy) return;
    S.busy = true; render();
    const mine = S;
    try {
      const st = await deps.api("battleStatus");
      if (S !== mine) return;
      if (typeof st.serverNowMs === "number") offset = st.serverNowMs - Date.now();
      S.status = st; S.busy = false; S.err = "";
      if (st.rec && st.rec.done) { S.screen = "page"; return render(); }
      if (st.allTaken) { S.screen = "page"; return render(); }
      S.practice = null; S.screen = "wait"; S.goShown = false; render();
    } catch (e) { if (S !== mine) return; S.busy = false; S.err = ERR[e.code] || `うまくいきませんでした（${e.code || "エラー"}）`; render(); }
    return;
  }
  if (act === "go" && S.practice) return beginPractice();
  if (act === "go" || act === "restart") return startGame();
  if (act === "practice") return startPractice();
  if (act === "claim") return startClaim(Number(b.getAttribute("data-i")));
  if (act === "board-reload") { S.boardMsg = ""; await refreshBoard(); render(); return; }
  if (act === "cxnotify") {
    const on = b.checked; S.boardNotifyTouched = true; if (S.board) S.board.notify = on;
    try { const r = await deps.api("kakuSetNotify", { prefs: { cancel: on } }); if (S.board) S.board.notify = r.prefs.cancel === true; }
    catch (_) { if (S.board) S.board.notify = !on; S.boardMsg = "通知の設定を保存できませんでした。"; render(); }
    return;
  }
  if (act === "tab") { S.tab = b.getAttribute("data-v") === "all" ? "all" : "week"; render(); return; }
  if (act === "to-page") { S.screen = "page"; S.practice = null; S.game = null; S.result = null; S.busy = false; await loadPage(); return; }
  if (act === "retry") { beginGame({ ...S.result.next, st: g.st }); return; }
  if (!g) return;
  if (act === "reload") {
    if (g.connBusy) return;
    g.connBusy = true; g.tries++; render();
    const stage = g.stage;
    setTimeout(() => {
      if (S && S.game === g && g.stage === stage) {
        g.connBusy = false; g.connLeft--;
        if (g.connLeft <= 0) { g.connOk = true; render(); setTimeout(() => { if (S && S.game === g && g.stage === stage) goStage(ORDER[ORDER.indexOf(stage) + 1]); }, 300); }
        else render();
      }
    }, 500);
    return;
  }
  if (act === "slot") { g.slot = Number(b.getAttribute("data-i")); render(); return; }
  if (act === "next-select") { if (g.slot == null) return; mark(g); goStage("conn1"); return; }
  if (act === "emoji") { g.pick = Number(b.getAttribute("data-i")); g.wrong = false; render(); return; }
  if (act === "next-puzzle") {
    if (g.pick == null) return;
    if (g.pick !== g.plan.puzzle.answer) { g.wrong = true; g.pick = null; g.perm = shuffle4(); render(); return; }
    mark(g); goStage("conn2"); return;
  }
  if (act === "next-slide") { if (!g.slideDone) return; mark(g); goStage("conn3"); return; }
  if (act === "num") {
    const n = Number(b.getAttribute("data-n")), want = [...g.plan.order].sort((x, y) => x - y)[g.ordTaps.length];
    if (n === want) { g.ordTaps.push(n); g.wrong = false; } else { g.ordTaps = []; g.wrong = true; }
    render(); return;
  }
  if (act === "next-order") { if (g.ordTaps.length !== g.plan.order.length) return; mark(g); goStage("conn4"); return; }
  if (act === "key") {
    const k = b.getAttribute("data-k");
    if (k === "back") g.digits = g.digits.slice(0, -1);
    else if (k === "ok") {
      if (g.digits.length !== 3) return;
      if (g.digits !== String(g.card)) { g.wrong = true; g.digits = ""; render(); return; }
      mark(g); goStage("conn5"); return;
    } else if (g.digits.length < 3) { g.digits += k; g.wrong = false; }
    render(); return;
  }
  if (act === "consent") {
    const i = Number(b.getAttribute("data-i"));
    if (!g.pressed.includes(i)) g.pressed.push(i);
    if (g.pressed.length === g.plan.consent.length && g.marks.length === 5) mark(g);
    render(); return;
  }
  if (act === "buy") return buy();
}

/* ---------------- 見た目 ---------------- */
function injectStyles() {
  if (stylesDone) return; stylesDone = true;
  const css = `
  body.yt-lock { overflow: hidden; }
  /* 連打しても、画面が拡大されない（ダブルタップのズームを止める）。文字や絵文字が選択されてしまうのも防ぐ */
  .yt-ov, .yt-ov * { touch-action: manipulation; -webkit-tap-highlight-color: transparent; -webkit-touch-callout: none; }
  .yt-ov { -webkit-user-select: none; user-select: none; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
  .yt-ov .yt-slide-handle { touch-action: none; }
  .yt-ov { position: fixed; inset: 0; z-index: 9000; overflow-y: auto; -webkit-overflow-scrolling: touch; color: #fff; background: radial-gradient(circle at 20% 0%, #5b1fa8 0, #25104d 45%, #120a2b 100%); font-family: inherit; }
  .yt-box { max-width: 520px; margin: 0 auto; padding: 12px 14px 40px; min-height: 100%; box-sizing: border-box; }
  .yt-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; } .yt-title { font-weight: 900; font-size: 18px; text-shadow: 0 0 12px #ff5fb0; }
  .yt-x { flex: none; width: 36px; height: 36px; border-radius: 50%; border: 1px solid rgba(255,255,255,.4); background: rgba(255,255,255,.12); color: #fff; font-size: 16px; font-weight: 900; cursor: pointer; }
  .yt-card { margin: 10px 0; padding: 14px; border-radius: 16px; background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.18); box-shadow: 0 6px 22px rgba(0,0,0,.25); }
  .yt-card.center { text-align: center; } .yt-h2 { font-weight: 900; font-size: 15px; margin-bottom: 6px; } .yt-h1 { font-weight: 900; font-size: 19px; line-height: 1.5; margin: 8px 0; }
  .yt-sub { font-size: 12px; line-height: 1.7; opacity: .92; margin: 6px 0; } .yt-err { margin: 8px 0; padding: 8px 10px; border-radius: 10px; background: #fff0d2; color: #8a3b00; font-weight: 800; font-size: 13px; }
  .yt-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; } .yt-chip { padding: 5px 12px; border-radius: 999px; background: rgba(255,225,74,.22); font-weight: 900; font-size: 13px; }
  .yt-done { margin: 10px 0 2px; padding: 10px; border-radius: 12px; background: rgba(23,227,106,.22); font-weight: 900; font-size: 14px; }
  .yt-btn { display: block; width: 100%; margin: 12px 0 4px; border: none; border-radius: 14px; padding: 13px 10px; font-size: 15px; font-weight: 900; color: #3a2a00; cursor: pointer; background: linear-gradient(135deg,#ffd700,#ff9a00); box-shadow: 0 4px 14px rgba(255,160,0,.5); font-family: inherit; }
  .yt-btn.big { padding: 17px 10px; font-size: 18px; } .yt-btn:disabled { background: rgba(255,255,255,.25); color: rgba(255,255,255,.8); box-shadow: none; cursor: default; }
  .yt-btn.pulse:not(:disabled) { animation: yt-pulse 1.1s ease-in-out infinite; } @keyframes yt-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.04); } }
  .yt-rank { width: 100%; border-collapse: collapse; font-size: 13px; } .yt-rank th { text-align: left; font-size: 11px; opacity: .8; padding: 4px 4px; } .yt-rank td { padding: 6px 4px; border-top: 1px solid rgba(255,255,255,.14); } .yt-rank td:nth-child(3) { font-weight: 900; font-variant-numeric: tabular-nums; }
  .yt-rank tr.me td { background: rgba(255,225,74,.22); font-weight: 900; } .yt-me { margin-top: 8px; padding: 8px 10px; border-radius: 10px; background: rgba(255,225,74,.22); font-weight: 900; font-size: 13px; }
  .yt-count { font-size: 56px; font-weight: 900; letter-spacing: .04em; text-shadow: 0 0 18px #ff5fb0; font-variant-numeric: tabular-nums; margin: 4px 0; }
  .yt-credit { margin: 12px auto; max-width: 320px; padding: 14px 16px; border-radius: 16px; text-align: left; color: #1e1b4b; background: linear-gradient(135deg,#fde68a,#f9a8d4 55%,#a5b4fc); box-shadow: 0 8px 24px rgba(0,0,0,.4); }
  .yt-credit-top { font-weight: 900; letter-spacing: .2em; font-size: 12px; } .yt-credit-no { font-size: 21px; font-weight: 900; letter-spacing: .08em; margin: 14px 0 10px; font-variant-numeric: tabular-nums; } .yt-credit-no b { font-size: 30px; color: #be123c; }
  .yt-credit-bot { font-size: 12px; font-weight: 800; } .yt-credit-bot b { font-size: 18px; color: #be123c; }
  .yt-bar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 8px; margin: -12px -14px 10px; padding: 10px 14px; background: rgba(18,10,43,.96); border-bottom: 2px solid #ff5fb0; backdrop-filter: blur(4px); }
  .yt-bar-l { flex: 1 1 auto; min-width: 0; } .yt-tgt { display: block; font-size: 12px; font-weight: 900; line-height: 1.4; } .yt-bar-r { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-size: 12px; font-weight: 800; }
  .yt-bar-card { padding: 2px 8px; border-radius: 8px; background: #fde68a; color: #7f1d1d; } .yt-bar-card b { font-size: 16px; letter-spacing: .1em; } .yt-time { font-variant-numeric: tabular-nums; }
  .yt-stage { padding-top: 6px; } .yt-page { text-align: center; } .yt-conn-ico { font-size: 56px; margin-top: 30px; }
  .yt-tickets { display: flex; flex-direction: column; gap: 10px; margin: 14px 0; } .yt-ticket { display: flex; flex-direction: column; gap: 3px; padding: 14px; border-radius: 16px; border: 3px solid transparent; text-align: center; cursor: pointer; font-family: inherit; color: #3b0764; background: linear-gradient(135deg,#fff,#fbcfe8); }
  .yt-ticket.sel { border-color: #ffd700; box-shadow: 0 0 0 3px rgba(255,215,0,.5), 0 6px 18px rgba(0,0,0,.35); } .yt-ticket:disabled { opacity: .45; cursor: default; } .yt-ticket-name { font-weight: 900; font-size: 14px; } .yt-ticket-time { font-weight: 900; font-size: 26px; } .yt-ticket-sub { font-size: 12px; font-weight: 800; }
  .yt-emojis { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 14px 0; } .yt-emoji { aspect-ratio: 1; border-radius: 18px; border: 4px solid transparent; background: #fff; font-size: 64px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; font-family: inherit; }
  .yt-emoji.sel { border-color: #ff2d78; box-shadow: 0 0 0 3px rgba(255,45,120,.4); }
  .yt-digs { display: flex; justify-content: center; gap: 10px; margin: 14px 0; } .yt-dig { width: 58px; height: 70px; border-radius: 12px; background: #fff; color: #1e1b4b; font-size: 38px; font-weight: 900; display: flex; align-items: center; justify-content: center; border: 3px solid #c4b5fd; } .yt-dig.on { border-color: #ff2d78; }
  .yt-keys { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; max-width: 320px; margin: 0 auto; } .yt-key { padding: 16px 0; border-radius: 12px; border: none; font-size: 24px; font-weight: 900; background: #fff; color: #1e1b4b; cursor: pointer; font-family: inherit; } .yt-key.sub { background: #e5e7eb; } .yt-key.ok { background: linear-gradient(135deg,#ffd700,#ff9a00); font-size: 18px; } .yt-key:disabled { opacity: .4; }
  .yt-consents { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; } .yt-consent { display: flex; align-items: center; gap: 8px; text-align: left; padding: 10px 12px; border-radius: 12px; border: 2px solid rgba(255,255,255,.25); background: rgba(255,255,255,.1); color: #fff; font-size: 13px; font-weight: 800; cursor: pointer; font-family: inherit; }
  .yt-consent.on { background: rgba(23,227,106,.28); border-color: #17e36a; }
  .yt-btn.sub { margin-top: 10px; padding: 11px 10px; font-size: 13px; color: #fff; background: rgba(255,255,255,.16); box-shadow: none; border: 1px solid rgba(255,255,255,.35); }
  .yt-practice { margin: 0 -14px; padding: 6px 14px; text-align: center; font-size: 12px; font-weight: 900; color: #3a2a00; background: #ffe14a; }
  .yt-tabs { display: flex; gap: 6px; margin-bottom: 10px; } .yt-tab { flex: 1; padding: 9px 4px; border-radius: 10px; border: 1px solid rgba(255,255,255,.3); background: rgba(255,255,255,.08); color: #fff; font-weight: 800; font-size: 12.5px; cursor: pointer; font-family: inherit; } .yt-tab.on { background: linear-gradient(135deg,#ffd700,#ff9a00); color: #3a2a00; border-color: transparent; }
  .yt-prize { margin: 6px 0; padding: 9px 10px; border-radius: 12px; background: rgba(255,225,74,.2); font-size: 12.5px; font-weight: 900; line-height: 1.8; text-align: center; }
  .yt-last { margin: 6px 0 10px; padding: 10px; border-radius: 12px; background: rgba(255,45,120,.16); border: 1px solid rgba(255,255,255,.2); }
  .yt-last-row { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; align-items: center; padding: 5px 0; font-size: 13px; border-top: 1px solid rgba(255,255,255,.14); } .yt-last-row b { color: #ffe14a; } .yt-last-row.me { font-weight: 900; }
  .yt-practice-wait { margin: 0 0 10px; border-radius: 10px; }
  .yt-slide { position: relative; height: 72px; margin: 26px 0 12px; border-radius: 999px; background: rgba(255,255,255,.16); border: 2px dashed rgba(255,255,255,.4); } .yt-slide.done { background: rgba(23,227,106,.28); border-color: #17e36a; }
  .yt-slide-goal { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); font-size: 36px; }
  .yt-slide-handle { position: absolute; left: 0; top: 2px; width: 64px; height: 64px; border-radius: 50%; background: #fff; display: flex; align-items: center; justify-content: center; font-size: 38px; cursor: grab; touch-action: none; user-select: none; box-shadow: 0 3px 10px rgba(0,0,0,.4); transition: left .15s ease; } .yt-slide-handle.drag { transition: none; cursor: grabbing; }
  .yt-nums { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 14px 0; } .yt-num { padding: 22px 0; border-radius: 18px; border: 4px solid transparent; background: #fff; color: #1e1b4b; font-size: 44px; font-weight: 900; cursor: pointer; display: flex; flex-direction: column; align-items: center; font-family: inherit; } .yt-num small { font-size: 12px; color: #be123c; } .yt-num.on { background: #dcfce7; border-color: #17e36a; opacity: .85; }
  .yt-mini { margin-left: 8px; padding: 3px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,.4); background: rgba(255,255,255,.12); color: #fff; font-size: 11px; font-weight: 800; cursor: pointer; font-family: inherit; }
  .yt-board { display: flex; flex-direction: column; gap: 4px; margin: 6px 0; } .yt-brow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 10px; background: rgba(255,255,255,.08); font-size: 13px; }
  .yt-brow.past { opacity: .5; } .yt-brow.mine { background: rgba(255,225,74,.22); } .yt-brow.open { background: rgba(23,227,106,.24); border: 1px solid #17e36a; }
  .yt-btime { font-weight: 900; min-width: 88px; font-variant-numeric: tabular-nums; } .yt-bkind { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: rgba(255,255,255,.16); font-weight: 800; }
  .yt-bs { font-weight: 800; flex: 1 1 auto; text-align: right; } .yt-bs.filled, .yt-bs.ended { opacity: .8; font-weight: 700; } .yt-bs.open { color: #b8ffd0; text-align: left; }
  .yt-claim { margin-left: auto; padding: 8px 16px; border: none; border-radius: 12px; font-weight: 900; font-size: 13px; color: #3a2a00; background: linear-gradient(135deg,#ffd700,#ff9a00); cursor: pointer; font-family: inherit; } .yt-claim:disabled { opacity: .5; }
  .yt-chk { display: block; margin-top: 8px; font-size: 13px; font-weight: 800; }
  .yt-big { font-size: 64px; } .yt-card.win { background: linear-gradient(135deg, rgba(255,215,0,.28), rgba(255,45,120,.22)); border-color: #ffd700; } .yt-card.lose { border-color: rgba(255,255,255,.3); }
  .yt-result-time { margin: 10px 0; font-size: 16px; font-weight: 900; } .yt-result-time b { font-size: 34px; color: #ffe14a; font-variant-numeric: tabular-nums; }
  @media (prefers-reduced-motion: reduce) { .yt-btn.pulse:not(:disabled) { animation: none; } }
  `;
  const style = document.createElement("style"); style.id = "yuticket-styles"; style.textContent = css; document.head.appendChild(style);
}
