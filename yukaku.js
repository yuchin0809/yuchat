/* =========================================================
   🌈 ゆうスロ「確変台」のパネル（yuworld.js のロビー＝台の一覧の上に出す）

   ・今日の確変台と全18枠、当日分の抽選申込・先着、明日の確変台の申込、通知の設定をまとめた「チケット売り場」。
   ・抽選・先着・枠の判定・当選はすべて通知 Worker（/yuslot の kaku* アクション）が決める。ここは表示と、申込ボタンを押して頼むだけ。
   ・Firebase には触れない。Worker に聞くのは、ロビーを開いたときと30秒おき、ボタンを押したときだけ。
========================================================= */

import { ticketInit, ticketOpen } from "./yuticket.js?v=20261022-ticket2";

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
const openState = { notify: false };   // 開いている「詳細」を、自動で描き直しても閉じないように覚える

const pad = (n) => String(n).padStart(2, "0");
const nowMs = () => Date.now() + offset;
function hm(ms) { const d = new Date(ms + 9 * 3600000); return `${d.getUTCHours()}:${pad(d.getUTCMinutes())}`; }
function md(ms) { const d = new Date(ms + 9 * 3600000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; }
const KIND = { pre: "前日抽選", lot: "当日抽選", quick: "先着" };

export function kakuInit(d) {
  deps = d; injectStyles();
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
async function pollLoop() { await refreshKaku(); if (running) timer = setTimeout(pollLoop, pollDelay()); }

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
  scheduleBoundary();
  deps.onChange && deps.onChange();
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
    const lotMine = mine.filter((x) => x.kind === "lot").length;
    if (t.applied1 && t.draw1Done) html += mine.some((x) => x.kind === "pre") ? `<div class="yk-ok">🎉 前日の抽選に当選しました！</div>` : `<div class="yk-sub">前日の抽選は外れでした。当日分の抽選・先着があります！</div>`;
    if (t.weekend) html += `<div class="yk-sub">🎊 土日は人気のため、抽選に当たる確率は約5%です（先着は同じ）。</div>`;
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
    if (tm.weekend) html += `<div class="yk-sub">🎊 明日は土日のため、抽選に当たる確率は約5%です。</div>`;
    if (now < T.preOpen) html += `<div class="yk-sub">前日の抽選（30分枠×13）の申込は、今日の ${hm(T.preOpen)}〜${hm(T.preClose)}。</div>`;
    else if (preOpen) html += tm.applied1 ? `<div class="yk-ok">✓ 抽選に申込済み（${hm(T.preClose)}に抽選・明日 7:50 に結果）</div>` : `<button type="button" class="yk-btn" data-kk="apply" data-which="pre">🎟 明日の抽選に申し込む（${hm(T.preClose)}まで・無料）</button>`;
    else if (tm.mode === "sameDay") html += `<div class="yk-sub">明日は前日の抽選がなく、当日分だけの発売です。</div>`;
    else html += `<div class="yk-sub">前日の抽選の申込は終わりました。結果は明日 7:50 のお知らせで！</div>`;
    html += `</div>`;
  }
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
  not_open: "いまは受け付けていません。", taken: "その枠はすでに取られました。", quick_limit: "先着は1人1枠までです。", day_limit: "1日に取れる枠は最大3つです。",
  overlap: "同じ時間の枠はとれません。", slot_started: "その枠はもう始まっています。", busy: "混み合っています。もう一度お試しください。", not_published: "ただいま準備中です。", no_event: "まだ確変台の開催前です。"
};
async function onClick(b) {
  if (busy) return;
  const kind = b.getAttribute("data-kk");
  busy = true; msg = "";
  try {
    if (kind === "apply") { const r = await deps.api("kakuApply", { which: b.getAttribute("data-which") }); msg = r.already ? "すでに申込済みです。" : "抽選に申し込みました！ 結果をお楽しみに🌈"; }
    else if (kind === "ticket") { busy = false; ticketOpen(); return; }
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
  .yk-sub { font-size: 12px; opacity: .92; line-height: 1.7; margin: 4px 0; } .yk-mine { margin: 6px 0; padding: 6px 10px; border-radius: 10px; background: rgba(255,225,74,.22); font-weight: 800; }
  .yk-sec { margin-top: 12px; font-weight: 800; font-size: 13px; } .yk-ok { margin: 6px 0; padding: 8px 10px; border-radius: 10px; background: rgba(23,227,106,.25); font-weight: 800; font-size: 13px; }
  .yk-msg { margin: 6px 0; padding: 8px 10px; border-radius: 10px; background: #fff6d6; color: #7a4a00; font-weight: 800; font-size: 13px; }
  .yk-btn { display: block; width: 100%; margin: 8px 0; border: none; border-radius: 12px; padding: 11px 10px; font-size: 14px; font-weight: 900; color: #3a2a00; cursor: pointer; background: linear-gradient(135deg,#ffd700,#ff9a00); box-shadow: 0 3px 12px rgba(255,160,0,.5); }
  .yk-btn.small { display: inline-block; width: auto; margin: 0; padding: 7px 14px; font-size: 12px; }
  .yk-btn:disabled { background: rgba(255,255,255,.28); color: rgba(255,255,255,.85); box-shadow: none; cursor: default; }
  .yk-quick { display: flex; flex-direction: column; gap: 6px; margin: 6px 0; } .yk-q { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 10px; background: rgba(255,255,255,.14); font-size: 13px; } .yk-q em { font-style: normal; font-weight: 800; color: #ffe14a; }
  .yk-notify summary { cursor: pointer; font-weight: 800; font-size: 13px; margin-top: 10px; } .yk-tomorrow { margin-top: 6px; padding-top: 6px; border-top: 1px dashed rgba(255,255,255,.35); }
  .yk-chk { display: block; padding: 5px 0; font-size: 13px; }
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
