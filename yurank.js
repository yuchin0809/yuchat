/* =========================================================
   🏅 ゆうスロの会員ランクのカード（yuworld.js のロビー＝台の一覧の上に出す）

   ・ランクは、ゆうスロで「1週間に使ったコイン」で決まる（毎週金曜 15:10 に、先週の分で更新）。ランクが高いほど、見た目が豪華になる。
   ・ランクの判定・今週の進み・条件はすべて通知 Worker（/yuslot の rankStatus）が返す。ここは表示だけ。
   ・ランクが上がると確変台の抽選に当たりやすくなる、ことだけを書く（確率・倍率は出さない）。
   ・Firebase には触れない。Worker に聞くのは、ロビーを開いたときだけ。
========================================================= */

let deps = null;          // { api, esc, onChange }
let data = null;          // 直近の rankStatus
let fetchedAt = 0;
let stylesDone = false;

const pad = (n) => String(n).padStart(2, "0");
const coin = (n) => Number(n || 0).toLocaleString();
function mdhm(ms) { const d = new Date(ms + 9 * 3600000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${pad(d.getUTCMinutes())}`; }

/* ランクごとの飾り（高いほど豪華） */
const LOOK = [
  { cls: "yr-l0", icon: "🌱", tag: "はじめの一歩" },
  { cls: "yr-l1", icon: "🥉", tag: "ブロンズ会員" },
  { cls: "yr-l2", icon: "🥈", tag: "シルバー会員" },
  { cls: "yr-l3", icon: "🥇", tag: "ゴールド会員" },
  { cls: "yr-l4", icon: "💠", tag: "プラチナ会員" },
  { cls: "yr-l5", icon: "💎", tag: "最高ランク" }
];

export function rankInit(d) { deps = d; injectStyles(); }

export async function rankRefresh({ force = false } = {}) {
  if (!deps) return;
  if (!force && data && Date.now() - fetchedAt < 20000) return;
  try {
    data = await deps.api("rankStatus");
    fetchedAt = Date.now();
  } catch (_) { /* 取れなくても、台の一覧は使える（カードを出さないだけ） */ return; }
  deps.onChange && deps.onChange();
}

export function rankPanelHtml() {
  if (!deps || !data || !data.ok) return "";
  const esc = deps.esc;
  const lv = Math.min(LOOK.length - 1, Math.max(0, data.level | 0));
  const look = LOOK[lv];
  const next = data.next;
  const thisWeek = Number(data.thisWeek) || 0;
  const pct = next ? Math.max(0, Math.min(100, Math.floor((thisWeek / next.min) * 100))) : 100;
  const sparkles = lv >= 3 ? `<span class="yr-sp yr-sp1">✨</span><span class="yr-sp yr-sp2">✨</span>${lv >= 4 ? `<span class="yr-sp yr-sp3">✨</span><span class="yr-sp yr-sp4">⭐</span>` : ""}${lv >= 5 ? `<span class="yr-sp yr-sp5">💫</span><span class="yr-sp yr-sp6">✨</span>` : ""}` : "";
  const progress = next
    ? `<div class="yr-bar" aria-hidden="true"><i style="width:${pct}%"></i></div>
       <div class="yr-line">今週 <b>${coin(thisWeek)}</b> / ${coin(next.min)} コイン（${esc(next.name)}まで あと <b>${coin(Math.max(0, next.min - thisWeek))}</b>）</div>`
    : `<div class="yr-line">👑 最高ランクです！ 今週 <b>${coin(thisWeek)}</b> コイン使いました</div>`;
  const proj = data.projected > lv
    ? `<div class="yr-line yr-up">📈 今のペースなら、来週は <b>${esc(data.projectedName)}</b>！</div>`
    : data.projected < lv
      ? `<div class="yr-line yr-down">今週の分が少ないと、来週のランクは <b>${esc(data.projectedName)}</b> になります</div>`
      : "";
  const chips = data.levels.map((l, i) => `<span class="yr-chip ${i === lv ? "is-now" : ""} ${LOOK[i].cls}"><span>${LOOK[i].icon} ${esc(l.name)}</span><small>${i === 0 ? "—" : `${coin(l.min)}〜`}</small></span>`).join("");
  return `<div class="yr-panel ${look.cls}">${sparkles}
    <div class="yr-head"><span class="yr-icon" aria-hidden="true">${look.icon}</span>
      <div><div class="yr-tag">${esc(look.tag)}</div><div class="yr-name">${esc(data.name)}</div></div></div>
    ${progress}${proj}
    <div class="yr-last">先週に使ったコイン：${coin(data.lastWeek)}</div>
    <details class="yr-detail"><summary>ランクの条件を見る</summary>
      <div class="yr-chips">${chips}</div>
      <p class="yr-note">1週間（金曜 15:10〜翌金曜 15:10）に、ゆうスロで使ったコインの合計でランクが決まります（確変中に使った分も数えます。無料スピンは数えません）。ランクは毎週金曜 15:10 に、先週の分で更新されます（次の更新：${esc(mdhm(data.nextRollMs))}）。ランクが上がると、確変台の抽選に当たりやすくなります。</p>
    </details></div>`;
}

function injectStyles() {
  if (stylesDone) return; stylesDone = true;
  const css = `
  .yr-panel { position: relative; overflow: hidden; margin: 12px 0; padding: 14px; border-radius: 16px; color: #1f2937; background: #f3f4f6; border: 1px solid #e5e7eb; }
  .yr-panel > * { position: relative; }
  .yr-head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .yr-icon { font-size: 40px; line-height: 1; filter: drop-shadow(0 2px 4px rgba(0,0,0,.25)); }
  .yr-tag { font-size: 11px; font-weight: 800; letter-spacing: .08em; opacity: .85; }
  .yr-name { font-size: 22px; font-weight: 900; }
  .yr-bar { height: 10px; margin: 8px 0 4px; border-radius: 999px; background: rgba(0,0,0,.12); overflow: hidden; }
  .yr-bar i { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg,#34d399,#fbbf24); transition: width .6s ease; }
  .yr-line { font-size: 13px; line-height: 1.7; } .yr-last { font-size: 12px; opacity: .85; margin-top: 2px; }
  .yr-up { font-weight: 800; } .yr-down { opacity: .9; }
  .yr-detail summary { cursor: pointer; font-weight: 800; font-size: 13px; margin-top: 8px; }
  .yr-chips { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 6px; margin-top: 8px; }
  .yr-chip { display: flex; justify-content: space-between; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 10px; font-size: 12px; font-weight: 800; background: rgba(255,255,255,.55); border: 1px solid rgba(0,0,0,.08); }
  .yr-chip small { font-weight: 700; opacity: .8; } .yr-chip.is-now { outline: 3px solid #f59e0b; background: rgba(255,255,255,.9); }
  .yr-note { font-size: 12px; line-height: 1.7; margin: 8px 0 0; opacity: .92; }
  /* ランクごとの見た目：高いほど豪華 */
  .yr-l1 { background: linear-gradient(135deg,#f6e0c8,#d9a36b 60%,#b77a3f); color: #3b2312; border-color: #b77a3f; }
  .yr-l2 { background: linear-gradient(135deg,#f9fafb,#cfd6de 55%,#9aa5b1); color: #1f2937; border-color: #9aa5b1; box-shadow: 0 4px 14px rgba(120,130,145,.35); }
  .yr-l3 { background: linear-gradient(135deg,#fff3b0,#f7c948 50%,#d9951a); color: #4a2f00; border-color: #d9951a; box-shadow: 0 6px 20px rgba(230,170,30,.5); }
  .yr-l4 { background: linear-gradient(135deg,#1e3a8a,#3b82f6 45%,#a5f3fc); color: #fff; border-color: #93c5fd; box-shadow: 0 8px 26px rgba(59,130,246,.55); }
  .yr-l5 { background: linear-gradient(135deg,#2b1570,#7a1bd6 40%,#e0309a 70%,#ffb347); color: #fff; border: 2px solid transparent; background-clip: padding-box; box-shadow: 0 10px 34px rgba(190,60,230,.65), 0 0 0 2px rgba(255,255,255,.35) inset; }
  .yr-l4 .yr-chip, .yr-l5 .yr-chip { color: #1f2937; }
  .yr-l3::before, .yr-l4::before, .yr-l5::before { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: .45; background: linear-gradient(115deg, transparent 30%, rgba(255,255,255,.75) 46%, transparent 62%); background-size: 250% 100%; animation: yr-shine 3.4s linear infinite; }
  .yr-l5::before { opacity: .6; animation-duration: 2.4s; }
  .yr-l5 .yr-name { text-shadow: 0 0 14px rgba(255,235,120,.95), 0 0 26px rgba(255,120,220,.8); } .yr-l4 .yr-name, .yr-l3 .yr-name { text-shadow: 0 0 10px rgba(255,255,255,.7); }
  .yr-l5 .yr-icon { animation: yr-pulse 1.8s ease-in-out infinite; } .yr-l4 .yr-icon, .yr-l3 .yr-icon { animation: yr-pulse 2.6s ease-in-out infinite; }
  .yr-sp { position: absolute; font-size: 16px; pointer-events: none; animation: yr-twinkle 2.2s ease-in-out infinite; }
  .yr-sp1 { top: 8px; right: 14px; } .yr-sp2 { top: 46px; right: 52px; animation-delay: .7s; } .yr-sp3 { bottom: 12px; right: 20px; animation-delay: 1.2s; }
  .yr-sp4 { top: 14px; right: 88px; animation-delay: .3s; } .yr-sp5 { bottom: 40px; right: 70px; animation-delay: 1.6s; } .yr-sp6 { top: 70px; right: 14px; animation-delay: 1s; }
  @keyframes yr-shine { from { background-position: 200% 0; } to { background-position: -100% 0; } }
  @keyframes yr-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.12); } }
  @keyframes yr-twinkle { 0%,100% { opacity: .2; transform: scale(.7) rotate(0deg); } 50% { opacity: 1; transform: scale(1.2) rotate(20deg); } }
  @media (prefers-reduced-motion: reduce) { .yr-l3::before, .yr-l4::before, .yr-l5::before, .yr-icon, .yr-sp { animation: none; } }
  `;
  const style = document.createElement("style"); style.id = "yurank-styles"; style.textContent = css; document.head.appendChild(style);
}
