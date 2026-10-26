/* =========================================================
   🌈 ゆうスロ「確変台」のパネル（yuworld.js のロビー＝台の一覧の上に出す）

   ・今日の確変台と全18枠、当日分の抽選申込・先着、明日の確変台の申込、通知の設定をまとめた「チケット売り場」。
   ・抽選・先着・枠の判定・当選はすべて通知 Worker（/yuslot の kaku* アクション）が決める。ここは表示と、申込ボタンを押して頼むだけ。
   ・Firebase には触れない。Worker に聞くのは、ロビーを開いたときと30秒おき、ボタンを押したときだけ。
========================================================= */

import { ticketInit, ticketOpen } from "./yuticket.js?v=20261023-ticket7";

let deps = null;          // { api, esc, machines(id→{name,emoji}), onChange }
let data = null;          // 直近の kakuStatus
let prefs = null;         // 通知の設定
let offset = 0;
let timer = null;          // 定期的な読み直し
let running = false;       // ロビーを開いている間だけ true（離れたらタイマーを止める）
let boundaryTimer = null;  // 「次の節目の時刻ちょうど」に画面を切り替えるタイマー
let busy = false;
let msg = "";
let stylesDone = false;
const openState = { notify: false };
const mv = { open: false, info: null };   // ⏰ 当たった枠の時間を変える（前日の抽選の30分枠）。ボタンを押したときだけ Worker に聞く
const tk = { open: false, info: null };   // 🎟 確変チケット（ゆう番くじの C賞・D賞・ラストワン賞）を使う画面。ボタンを押したときだけ Worker に聞く   // 開いている「詳細」を、自動で描き直しても閉じないように覚える

const pad = (n) => String(n).padStart(2, "0");
const nowMs = () => Date.now() + offset;
function hm(ms) { const d = new Date(ms + 9 * 3600000); return `${d.getUTCHours()}:${pad(d.getUTCMinutes())}`; }
function md(ms) { const d = new Date(ms + 9 * 3600000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; }
const KIND = { pre: "前日抽選", lot: "当日抽選", quick: "先着" };

export function kakuInit(d) {
  deps = d; injectStyles();
  document.addEventListener("visibilitychange", () => { if (!document.hidden && running && data) refreshKaku(); });   // 戻ったら、すぐ読み直す
  // 🎫 先着ゲーム（全画面）。閉じたら、売り場の表示（獲得した枠など）を読み直す
  ticketInit({ api: d.api, esc: d.esc, machineName: () => { const m = data && data.today && d.machines[data.today.machine]; return m ? m.name : "確変台"; }, onClose: () => refreshKaku() });
}
export function stopKaku() { running = false; if (timer) { clearTimeout(timer); timer = null; } if (boundaryTimer) { clearTimeout(boundaryTimer); boundaryTimer = null; } }
export function startKaku() { stopKaku(); running = true; pollLoop(); }
/* 先着の受付中（11:45〜枠が始まるまで）は、売り切れの表示を早く更新するため10秒おき、ふだんは30秒おきに読み直す */
function pollDelay() {
  const t = data && data.today;
  if (t) { const now = nowMs(); if (now >= t.times.quickOpen && t.slots.some((x) => x.kind === "quick" && !x.taken && now < x.s)) return 10000; }
  return 30000;
}
async function pollLoop() { if (!document.hidden) await refreshKaku(); if (running) timer = setTimeout(pollLoop, pollDelay()); }   // 画面が裏にあるあいだは読み直さない

/* 申込・先着の開始や締切の「時刻ちょうど」に、画面を切り替える（ボタンが出る・押せる）。
   サーバーは時刻ちょうどから受け付けるので、画面もその瞬間に合わせる（30秒おきの読み直しを待たない） */
function scheduleBoundary() {
  if (boundaryTimer) { clearTimeout(boundaryTimer); boundaryTimer = null; }
  if (!data || !running) return;
  const now = nowMs(), cand = [];
  const t = data.today, tm = data.tomorrow;
  if (t) { const T = t.times; if (t.cur) cand.push(t.cur.e); cand.push(T.sameOpen, T.sameClose, T.quickOpen, T.playStart, T.playEnd, ...t.slots.filter((x) => x.kind === "quick").map((x) => x.s)); }
  if (tm) { cand.push(tm.times.preOpen, tm.times.preClose); }
  const next = cand.filter((x) => x > now).sort((a, b) => a - b)[0];
  if (!next) return;
  boundaryTimer = setTimeout(() => { deps.onChange && deps.onChange(); refreshKaku(); }, Math.min(next - now + 20, 2147000000));
}

export async function refreshKaku() {
  try {
    data = await deps.api("kakuStatus");
    if (typeof data.serverNowMs === "number") offset = data.serverNowMs - Date.now();
  } catch (_) { /* 取れなくても、台の一覧は使える */ }
  if (tk.open) await loadTickets();
  scheduleBoundary();
  deps.onChange && deps.onChange();
}

/* ⏰ 当たった30分枠の時間を変える：いまの枠と、移れる（NPC がとっている）枠の一覧 */
function moveHtml(today) {
  const mine = today.slots.filter((x) => x.mine && x.mv);
  if (!mine.length) return "";
  const done = mine.filter((x) => x.mv === 2), can = mine.filter((x) => x.mv === 1 && nowMs() < x.s - 11 * 60000);
  let h = `<div class="yk-mv">`;
  if (done.length) h += `<div class="yk-sub">⏰ 時間を変更ずみ：${done.map((x) => `${hm(x.s)}〜${hm(x.e)}`).join("、")}（1回だけ変えられます）</div>`;
  if (!can.length) return h + `</div>`;
  if (!mv.open) return h + `<button type="button" class="yk-btn small" data-kk="mv-open">⏰ 当たった枠の時間を変える</button></div>`;
  h += `<div class="yk-sec">⏰ 当たった枠の時間を変える</div>`;
  const day = mv.info && mv.info.days.find((d) => d.day === today.day);
  if (!mv.info) h += `<div class="yk-sub">読み込み中…</div>`;
  else if (!day || !day.moves.length) h += `<div class="yk-sub">いま変えられる枠はありません。</div>`;
  else {
    h += `<div class="yk-sub">NPC（ダミーの参加者）がとっている30分枠と入れ替えられます（プレイヤーがとっている枠は選べません）。始まる11分前までに、1当選につき1回だけ。</div>`;
    day.moves.forEach((m) => {
      h += `<div class="yk-sub">いまの枠：<b>${hm(m.from.s)}〜${hm(m.from.e)}</b> → 移る先を選ぶ</div>`;
      h += m.to.length ? `<div class="yk-tkgrid">${m.to.map((x) => `<button type="button" class="yk-tkbtn" data-kk="mv-do" data-day="${day.day}" data-from="${m.from.i}" data-to="${x.i}">${hm(x.s)}〜${hm(x.e)}</button>`).join("")}</div>` : `<div class="yk-sub">移れる枠がありません（NPC の枠が空いていません）。</div>`;
    });
  }
  return h + `<button type="button" class="yk-btn small" data-kk="mv-open">閉じる</button></div>`;
}
/* 🎟 チケットの残りと、使える枠の一覧を読む（開いているあいだだけ。台の一覧を読み直すたびに） */
async function loadTickets() {
  try { tk.info = await deps.api("kakuTicketInfo"); } catch (_) { /* 取れなければ、前の表示のまま */ }
}
function ticketHtml() {
  const esc = deps.esc, info = tk.info;
  if (!tk.open) return `<button type="button" class="yk-btn" data-kk="tk-open">🎟 ゆう番くじのチケットを使う</button>`;
  let h = `<div class="yk-tk"><div class="yk-sec">🎟 確変チケット</div>`;
  if (!info) return h + `<div class="yk-sub">読み込み中…</div><button type="button" class="yk-btn small" data-kk="tk-open">閉じる</button></div>`;
  if (!info.left) {
    h += `<div class="yk-sub">いまチケットはありません。ゆう番くじの C賞・D賞・ラストワン賞で当たると、もらえます。</div>`;
  } else {
    const until = info.tickets.map((x) => x.until).filter(Boolean).sort((a, b) => a - b)[0];
    h += `<div class="yk-ok">🎟 残り ${info.left} 回${until ? `（いちばん近い期限：${md(until)}）` : ""}</div>
      <div class="yk-sub">1回で、30分の確変の枠を1つ、確定でもらえます（1日に取れる枠は最大3つまで）。</div>`;
    const r = info.reserve;
    h += `<div class="yk-sec">① 明日の枠を予約する</div>`;
    if (r && r.open) {
      h += `<div class="yk-sub">明日（${md(r.slots[0].s)}）の前日抽選の枠から、好きな枠を選べます（今日の ${hm(r.closeMs)} まで）。予約した枠は、抽選に出ません。</div><div class="yk-tkgrid">${r.slots.map((x) => x.state === "free"
        ? `<button type="button" class="yk-tkbtn" data-kk="tk-use" data-mode="reserve" data-day="${r.day}" data-slot="${x.i}">${hm(x.s)}〜${hm(x.e)}</button>`
        : `<span class="yk-tkbtn off">${hm(x.s)}〜${hm(x.e)}<em>${x.state === "mine" ? "⭐予約済み" : "予約済み"}</em></span>`).join("")}</div>`;
    } else if (r) h += `<div class="yk-sub">予約できるのは、今日の ${hm(r.openMs)}〜${hm(r.closeMs)} です。</div>`;
    else h += `<div class="yk-sub">明日の枠の予約は、もう終わりました（前日の 12:00〜21:00）。</div>`;
    h += `<div class="yk-sec">② NPC がとった枠を取る</div>`;
    if (info.take.length) {
      h += `<div class="yk-sub">抽選のあと、NPC（ダミーの参加者）がとった30分枠を、始まる11分前まで取れます。</div><div class="yk-tkgrid">${info.take.map((x) => `<button type="button" class="yk-tkbtn" data-kk="tk-use" data-mode="take" data-day="${x.day}" data-slot="${x.i}">${md(x.s)} ${hm(x.s)}〜${hm(x.e)}</button>`).join("")}</div>`;
    } else h += `<div class="yk-sub">いま取れる NPC の枠はありません（前日の抽選のあと、21:00以降に出ます）。</div>`;
    h += `<div class="yk-sec">③ 今日の10分枠（当日分）を使う</div>`;
    const same = info.same || [];
    if (same.length) {
      const KINDJA = { lot: "抽選", quick: "先着" };
      h += `<div class="yk-sub">当日の抽選の枠は、抽選（10:45）の前なら予約、あとなら NPC がとった枠を取れます。先着の枠は、まだ誰もとっていなければ、ゲームを待たずに取れます（始まる11分前まで）。</div><div class="yk-tkgrid">${same.map((x) => x.state === "free"
        ? `<button type="button" class="yk-tkbtn" data-kk="tk-use" data-mode="${x.mode}" data-day="${x.day}" data-slot="${x.i}">${hm(x.s)}〜${hm(x.e)}<em>${KINDJA[x.kind]}・${x.mode === "reserve" ? "予約" : "取る"}</em></button>`
        : `<span class="yk-tkbtn off">${hm(x.s)}〜${hm(x.e)}<em>${KINDJA[x.kind]}・${x.state === "mine" ? "⭐あなたの枠" : "取られています"}</em></span>`).join("")}</div>`;
    } else h += `<div class="yk-sub">いま使える今日の10分枠はありません（当日分は 7:00 から出ます）。</div>`;
  }
  return h + `<button type="button" class="yk-btn small" data-kk="tk-open">閉じる</button></div>`;
}

/* 台のカードの飾りと、「枠の持ち主だけ」の案内に使う */
export function kakuMachineInfo(machineId) {
  const t = data && data.today;
  if (!t || t.machine !== machineId) return null;
  const now = nowMs(), tm = t.times;
  const inWindow = now >= tm.playStart && now < tm.playEnd;
  // いまの枠を使っているのが「NPC／ほかのプレイヤー／自分／いない」のどれか（サーバーが教えてくれる。名前は出さない）
  const cur = inWindow && t.cur && now >= t.cur.s && now < t.cur.e ? t.cur : null;
  const mine = !!cur && cur.holder === "me";
  return { inWindow, locked: inWindow && !mine, cur, holder: cur ? cur.holder : null, mine, times: tm };
}

export function kakuPanelHtml() {
  const esc = deps.esc;
  if (!data || !data.active) return "";
  const now = nowMs();
  const t = data.today, tm = data.tomorrow;
  let html = `<div class="yk-panel"><div class="yk-title">🌈 確変台チケット売り場</div>`;
  if (msg) html += `<div class="yk-msg">${esc(msg)}</div>`;
  if (t) {
    const mi = deps.machines[t.machine] || { name: t.machine, emoji: "🎰" };
    const T = t.times;
    html += `<div class="yk-today"><div class="yk-today-name">${mi.emoji} 今日の確変台：<b>${esc(mi.name)}</b></div>
      <div class="yk-sub">${hm(T.playStart)}〜${hm(T.playEnd)}／枠をとった人だけが遊べます（当たりの確率が大きくアップ）</div>`;
    // 自分の予定だけを表示する（ほかの人の枠・名前は出さない）
    const mine = t.slots.filter((x) => x.mine).sort((a, b) => a.s - b.s);
    html += `<div class="yk-mine">⭐ あなたの今日の予定：${mine.length ? mine.map((x) => `${hm(x.s)}〜${hm(x.e)}（${KIND[x.kind]}）`).join("、") : "まだありません"}</div>`;
    html += moveHtml(t);
    const lotMine = mine.filter((x) => x.kind === "lot").length;
    if (t.applied1 && t.draw1Done) html += mine.some((x) => x.kind === "pre") ? `<div class="yk-ok">🎉 前日の抽選に当選しました！</div>` : `<div class="yk-sub">前日の抽選は外れでした。当日分の抽選・先着があります！</div>`;
    // 当日分
    const quicks = t.slots.filter((x) => x.kind === "quick");
    html += `<div class="yk-sec">当日分（12:30〜13:20の10分枠：抽選3・先着${quicks.length}）</div>`;
    if (now < T.sameOpen) html += `<div class="yk-sub">抽選の申込は ${hm(T.sameOpen)}〜${hm(T.sameClose)}、先着は ${hm(T.quickOpen)} から。</div>`;
    else if (now < T.sameClose) html += t.applied2 ? `<div class="yk-ok">✓ 当日分の抽選に申込済み（${hm(T.sameClose)}に抽選。結果はあなたにだけ届きます）</div>` : `<button type="button" class="yk-btn" data-kk="apply" data-which="same">🎟 当日分の抽選に申し込む（${hm(T.sameClose)}まで・無料）</button>`;
    else if (t.applied2) html += lotMine ? `<div class="yk-ok">🎉 当日分の抽選に当選しました！</div>` : `<div class="yk-sub">当日分の抽選は外れでした。${now < T.quickOpen ? `先着は ${hm(T.quickOpen)} から！` : "先着に挑戦してみよう！"}</div>`;
    else html += `<div class="yk-sub">当日分の抽選は終わりました。${now < T.quickOpen ? `先着は ${hm(T.quickOpen)} から！` : ""}</div>`;
    // 先着：ゲームで早さを競う（11:45 から）。ボタンから先着ページ（参加・ランキング）を開く
    html += `<div class="yk-sub">先着は ${hm(T.quickOpen)} から・1人1枚。ミニゲームの早さで取り合います！ ランキングも見られます。</div>
      <div class="yk-quick">${quicks.map((x) => {
        const started = now >= x.s;
        const right = x.mine ? `<em>⭐ あなたが獲得！</em>` : x.taken ? `<em>売り切れ</em>` : started ? `<em>受付終了</em>` : "";
        return `<div class="yk-q"><span>${hm(x.s)}〜${hm(x.e)}（先着）</span>${right}</div>`;
      }).join("")}</div>
      <button type="button" class="yk-btn" data-kk="ticket">🎫 当日の先着はこちら</button>`;
    if (t.mode === "sameDay") html += `<div class="yk-sub">※今日は前日の抽選がなく、当日分だけの発売です。</div>`;
    html += `</div>`;
  }
  if (tm) {
    const mi = deps.machines[tm.machine] || { name: tm.machine, emoji: "🎰" };
    const T = tm.times, preOpen = now >= T.preOpen && now < T.preClose && tm.mode !== "sameDay";
    html += `<div class="yk-tomorrow"><div class="yk-sec">${mi.emoji} 明日（${md(T.dayStart)}）の確変台：<b>${esc(mi.name)}</b></div>`;
    if (now < T.preOpen) html += `<div class="yk-sub">前日の抽選（30分枠×13）の申込は、今日の ${hm(T.preOpen)}〜${hm(T.preClose)}。</div>`;
    else if (preOpen) html += tm.applied1 ? `<div class="yk-ok">✓ 抽選に申込済み（${hm(T.preClose)}に抽選・明日 7:50 に結果）</div>` : `<button type="button" class="yk-btn" data-kk="apply" data-which="pre">🎟 明日の抽選に申し込む（${hm(T.preClose)}まで・無料）</button>`;
    else if (tm.mode === "sameDay") html += `<div class="yk-sub">明日は前日の抽選がなく、当日分だけの発売です。</div>`;
    else html += `<div class="yk-sub">前日の抽選の申込は終わりました。結果は明日 7:50 のお知らせで！</div>`;
    html += `</div>`;
  }
  html += ticketHtml();
  html += `<details class="yk-notify" ${openState.notify ? "open" : ""}><summary>🔔 通知の設定</summary>${prefs ? notifyHtml() : `<div class="yk-sub">読み込み中…</div>`}</details></div>`;
  return html;
}
function notifyHtml() {
  const rows = [["pub", "前日12:00：明日の確変台の公開"], ["same", "当日 7:00：当日分の抽選申込スタート"], ["result1", "当日 7:50：前日の抽選結果"], ["result2", "当日10:45：当日分の抽選結果"]];
  return `${rows.map(([k, label]) => `<label class="yk-chk"><input type="checkbox" data-pref="${k}" ${prefs[k] ? "checked" : ""}> ${label}</label>`).join("")}
    <div class="yk-sub">※先着の通知はありません。</div><button type="button" class="yk-btn small" data-kk="savepref">設定を保存</button>`;
}

export function kakuBind(root) {
  root.querySelectorAll("[data-kk]").forEach((b) => b.addEventListener("click", () => onClick(b)));
  const det = root.querySelector(".yk-notify");
  if (det) det.addEventListener("toggle", async () => {
    openState.notify = det.open;
    if (det.open && !prefs) { try { prefs = (await deps.api("kakuGetNotify")).prefs; } catch (_) { return; } deps.onChange && deps.onChange(); }
  });
  root.querySelectorAll("[data-pref]").forEach((c) => c.addEventListener("change", () => { if (prefs) prefs[c.getAttribute("data-pref")] = c.checked; })); // 保存前の変更も、描き直しで消えないように
}
const ERR = {
  no_ticket: "使えるチケットがありません。", too_late: "その枠は、もうすぐ始まる（または始まった）ので取れません。",
  not_open: "いまは受け付けていません。", taken: "その枠はすでに取られました。", quick_limit: "先着は1人1枠までです。", day_limit: "1日に取れる枠は最大3つです。",
  overlap: "同じ時間の枠はとれません。", not_movable: "この枠は、時間を変えられません。", already_moved: "この枠は、すでに1回変えています。", slot_started: "その枠はもう始まっています。", busy: "混み合っています。もう一度お試しください。", not_published: "ただいま準備中です。", no_event: "まだ確変台の開催前です。"
};
async function onClick(b) {
  if (busy) return;
  const kind = b.getAttribute("data-kk");
  busy = true; msg = "";
  try {
    if (kind === "apply") { const r = await deps.api("kakuApply", { which: b.getAttribute("data-which") }); msg = r.already ? "すでに申込済みです。" : "抽選に申し込みました！ 結果をお楽しみに🌈"; }
    else if (kind === "ticket") { busy = false; ticketOpen(); return; }
    else if (kind === "mv-open") { mv.open = !mv.open; if (mv.open) { mv.info = null; deps.onChange && deps.onChange(); try { mv.info = await deps.api("kakuMoveInfo"); } catch (_) { mv.info = { days: [] }; } } }
    else if (kind === "mv-do") {
      const day = b.getAttribute("data-day"), from = Number(b.getAttribute("data-from")), to = Number(b.getAttribute("data-to"));
      const label = b.textContent.trim();
      if (!window.confirm(`当たった枠を ${label} に変えます。よろしいですか？\n（変えられるのは1回だけです）`)) { busy = false; return; }
      const r = await deps.api("kakuMove", { day, from, to });
      mv.open = false; mv.info = null;
      msg = `⏰ ${hm(r.from.s)}〜${hm(r.from.e)} の枠を、${hm(r.to.s)}〜${hm(r.to.e)} に変えました！`;
    }
    else if (kind === "tk-open") { tk.open = !tk.open; if (tk.open) { tk.info = null; deps.onChange && deps.onChange(); await loadTickets(); } }
    else if (kind === "tk-use") {
      const mode = b.getAttribute("data-mode"), day = b.getAttribute("data-day"), slot = Number(b.getAttribute("data-slot"));
      const label = ((b.firstChild && b.firstChild.textContent) || b.textContent).trim();
      if (!window.confirm(`${label} の枠を、チケット1回ぶんで確定でもらいます。よろしいですか？`)) { busy = false; return; }
      const r = await deps.api("kakuTicketUse", { mode, day, slot });
      msg = `🎉 ${md(r.s)} ${hm(r.s)}〜${hm(r.e)} の枠を、確定で取りました！（チケット 残り ${r.left} 回）`;
      await loadTickets();
    }
    else if (kind === "savepref") {
      const next = {}; document.querySelectorAll("[data-pref]").forEach((c) => { next[c.getAttribute("data-pref")] = c.checked; });
      prefs = (await deps.api("kakuSetNotify", { prefs: next })).prefs; msg = "通知の設定を保存しました。";
    }
  } catch (e) { msg = ERR[e.code] || `うまくいきませんでした（${e.code || "エラー"}）`; }
  busy = false;
  await refreshKaku();
}

function injectStyles() {
  if (stylesDone) return; stylesDone = true;
  const css = `
  .yk-panel { margin: 12px 0; padding: 14px; border-radius: 16px; color: #fff; background: linear-gradient(135deg,#2b1570,#7a1bd6 55%,#c2187a); box-shadow: 0 6px 22px rgba(120,40,200,.35); position: relative; overflow: hidden; }
  .yk-panel::before { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: .35; background: linear-gradient(115deg, transparent 30%, rgba(255,255,255,.5) 45%, transparent 60%); background-size: 250% 100%; animation: yk-shine 3.5s linear infinite; }
  @keyframes yk-shine { from { background-position: 200% 0; } to { background-position: -100% 0; } }
  .yk-panel > * { position: relative; }
  .yk-title { font-weight: 900; font-size: 16px; text-shadow: 0 0 10px #ffe14a; margin-bottom: 8px; }
  .yk-today-name { font-size: 17px; } .yk-today-name b { color: #ffe14a; text-shadow: 0 0 10px rgba(255,225,74,.9); }
  .yk-mv { margin: 6px 0; } .yk-sub { font-size: 12px; opacity: .92; line-height: 1.7; margin: 4px 0; } .yk-mine { margin: 6px 0; padding: 6px 10px; border-radius: 10px; background: rgba(255,225,74,.22); font-weight: 800; }
  .yk-sec { margin-top: 12px; font-weight: 800; font-size: 13px; } .yk-ok { margin: 6px 0; padding: 8px 10px; border-radius: 10px; background: rgba(23,227,106,.25); font-weight: 800; font-size: 13px; }
  .yk-msg { margin: 6px 0; padding: 8px 10px; border-radius: 10px; background: #fff6d6; color: #7a4a00; font-weight: 800; font-size: 13px; }
  .yk-btn { display: block; width: 100%; margin: 8px 0; border: none; border-radius: 12px; padding: 11px 10px; font-size: 14px; font-weight: 900; color: #3a2a00; cursor: pointer; background: linear-gradient(135deg,#ffd700,#ff9a00); box-shadow: 0 3px 12px rgba(255,160,0,.5); }
  .yk-btn.small { display: inline-block; width: auto; margin: 0; padding: 7px 14px; font-size: 12px; }
  .yk-btn:disabled { background: rgba(255,255,255,.28); color: rgba(255,255,255,.85); box-shadow: none; cursor: default; }
  .yk-quick { display: flex; flex-direction: column; gap: 6px; margin: 6px 0; } .yk-q { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 10px; background: rgba(255,255,255,.14); font-size: 13px; } .yk-q em { font-style: normal; font-weight: 800; color: #ffe14a; }
  .yk-notify summary { cursor: pointer; font-weight: 800; font-size: 13px; margin-top: 10px; } .yk-tomorrow { margin-top: 6px; padding-top: 6px; border-top: 1px dashed rgba(255,255,255,.35); }
  .yk-chk { display: block; padding: 5px 0; font-size: 13px; }
  .yk-tk { margin-top: 10px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,.35); }
  .yk-tkgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 6px; margin: 6px 0; }
  .yk-tkbtn { border: none; border-radius: 10px; padding: 8px 6px; font-size: 12px; font-weight: 800; color: #3a2a00; cursor: pointer; background: linear-gradient(135deg,#ffe68a,#ffb347); text-align: center; }
  .yk-tkbtn em { display: block; font-style: normal; font-size: 10px; font-weight: 700; }
  .yk-tkbtn.off { background: rgba(255,255,255,.2); color: rgba(255,255,255,.85); cursor: default; }
  .yw-machine.yw-kaku { position: relative; border: 3px solid transparent; background: linear-gradient(#fff,#fff) padding-box, linear-gradient(120deg,#ff2d78,#ff8a00,#ffe14a,#17e36a,#17b6ff,#b14cff,#ff2d78) border-box; background-size: 100% 100%, 300% 100%; animation: yk-rainbow 4s linear infinite; box-shadow: 0 0 18px rgba(255,160,0,.55), 0 0 30px rgba(177,76,255,.35); }
  @keyframes yk-rainbow { from { background-position: 0 0, 0% 50%; } to { background-position: 0 0, 300% 50%; } }
  .yw-kaku-badge { position: absolute; top: -10px; right: 10px; padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 900; color: #fff; background: linear-gradient(90deg,#ff2d78,#ff8a00,#b14cff); box-shadow: 0 2px 8px rgba(0,0,0,.3); animation: yk-pulse 1.1s ease-in-out infinite; }
  .yw-kaku-note { margin: 6px 0; font-size: 12px; font-weight: 800; color: #b3125f; text-align: center; }
  @keyframes yk-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.1); } }
  .yw-kaku-banner { text-align: center; font-weight: 900; padding: 6px 10px; border-radius: 10px; color: #fff; background: linear-gradient(90deg,#ff2d78,#ff8a00,#ffe14a,#17e36a,#17b6ff,#b14cff); background-size: 300% 100%; animation: yk-rainbow2 3s linear infinite; text-shadow: 0 1px 4px rgba(0,0,0,.5); margin-bottom: 6px; }
  @keyframes yk-rainbow2 { from { background-position: 0% 50%; } to { background-position: 300% 50%; } }
  @media (prefers-reduced-motion: reduce) { .yk-panel::before, .yw-machine.yw-kaku, .yw-kaku-badge, .yw-kaku-banner { animation: none; } }
  `;
  const style = document.createElement("style"); style.id = "yukaku-styles"; style.textContent = css; document.head.appendChild(style);
}
