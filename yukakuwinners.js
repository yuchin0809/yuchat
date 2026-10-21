/* 🌈 確変台の当選者（管理者だけ。ユーザー管理タブの上に出す）
   ・その日の枠ごとに、当選したプレイヤー・NPC・空きを見られる（昨日・今日・明日の切り替え）。
   ・プレイヤーには見せない（ほかの人の名前は出さない決まり）。Worker の kakuWinners（管理者だけ）を呼んで表示するだけ。 */

let cfg = null;
let data = null;
let day = "";      // "" ＝ 今日（サーバーの日付）
let loading = false;

const KIND = { pre: "前日抽選", lot: "当日抽選", quick: "先着" };
const pad = (n) => String(n).padStart(2, "0");
const hm = (ms) => { const d = new Date(ms + 9 * 3600000); return `${d.getUTCHours()}:${pad(d.getUTCMinutes())}`; };
const dayShift = (base, n) => { const [y, m, d] = base.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
const todayJst = () => { const t = new Date(Date.now() + 9 * 3600000); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };

export function kakuWinnersInit(config) { cfg = config; }
export function kakuWinnersReset() { data = null; day = ""; loading = false; const el = document.getElementById("userManageKaku"); if (el) el.innerHTML = ""; }

export async function kakuWinnersOpen(targetDay = day) {
  if (!cfg || !cfg.isAdmin()) return;
  ensureStyles();
  day = targetDay;
  loading = true; render();
  try { data = await cfg.callAdmin("kakuWinners", day ? { day } : {}); }
  catch (error) { console.error("確変台の当選者の読み込みエラー:", error); data = { error: true }; }
  loading = false; render();
}

function render() {
  const el = document.getElementById("userManageKaku");
  if (!el) return;
  if (!cfg || !cfg.isAdmin()) { el.innerHTML = ""; return; }
  const esc = cfg.esc;
  const cur = data && data.day ? data.day : (day || todayJst());
  const base = todayJst();
  const tab = (label, d) => `<button type="button" class="ykw-tab ${cur === d ? "is-on" : ""}" data-ykw-day="${d}">${label}</button>`;
  let body;
  if (loading && !data) body = `<p class="ykw-note">読み込み中…</p>`;
  else if (!data || data.error) body = `<p class="ykw-note">読み込めませんでした。「更新」を押してください。</p>`;
  else if (!data.exists) body = `<p class="ykw-note">${esc(data.day)} の確変台のデータはまだありません（確変台：${esc(data.machineName || "-")}）。</p>`;
  else {
    const rows = data.slots.map((x) => {
      const who = x.empty ? `<span class="ykw-empty">（空き・まだ決まっていません）</span>` : x.npc ? `<span class="ykw-npc">🤖 NPC（${esc(x.name)}）</span>` : `<b class="ykw-real">${esc(x.name)}</b>`;
      return `<div class="ykw-row ${x.npc ? "is-npc" : ""} ${!x.npc && !x.empty ? "is-real" : ""}"><span class="ykw-time">${hm(x.s)}〜${hm(x.e)}</span><span class="ykw-kind">${KIND[x.kind] || esc(x.kind)}</span>${who}</div>`;
    }).join("");
    const reals = data.slots.filter((x) => !x.npc && !x.empty).length;
    body = `<p class="ykw-note">${esc(data.day)} の確変台：<b>${esc(data.machineName)}</b>／前日抽選 ${data.draw1Done ? `済（申込 ${data.applied1} 人）` : "まだ"}／当日抽選 ${data.draw2Done ? `済（申込 ${data.applied2} 人）` : "まだ"}／実在プレイヤーの枠：${reals} 件</p><div class="ykw-list">${rows}</div>`;
  }
  el.innerHTML = `<div class="ykw-head"><h3>🌈 確変台の当選者</h3><button type="button" class="ykw-tab" data-ykw-reload="1">更新</button></div>
    <div class="ykw-tabs">${tab("昨日", dayShift(base, -1))}${tab("今日", base)}${tab("明日", dayShift(base, 1))}</div>${body}
    <p class="ykw-note">管理者だけが見られます（プレイヤーには、自分の枠以外は見えません）。</p>`;
}

document.addEventListener("click", (event) => {
  const t = event.target.closest?.("[data-ykw-day],[data-ykw-reload]");
  if (!t || !document.getElementById("userManageKaku")?.contains(t)) return;
  if (t.dataset.ykwDay) kakuWinnersOpen(t.dataset.ykwDay === todayJst() ? "" : t.dataset.ykwDay);
  else kakuWinnersOpen(day);
});

function ensureStyles() {
  if (document.getElementById("yukakuwinners-styles")) return;
  const style = document.createElement("style");
  style.id = "yukakuwinners-styles";
  style.textContent = `
    .ykw-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; } .ykw-head h3 { margin: 0; font-size: 14px; }
    .ykw-tabs { display: flex; gap: 6px; margin: 8px 0; }
    .ykw-tab { padding: 6px 12px; border: 1px solid #d1d5db; border-radius: 999px; background: #fff; font-size: 12px; font-weight: 800; cursor: pointer; }
    .ykw-tab.is-on { background: #7c3aed; color: #fff; border-color: #7c3aed; }
    .ykw-note { margin: 6px 0; font-size: 12px; color: #4b5563; line-height: 1.7; }
    .ykw-list { display: grid; gap: 4px; }
    .ykw-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 10px; background: #f3f4f6; font-size: 13px; }
    .ykw-row.is-real { background: #ecfdf5; border: 1px solid #6ee7b7; } .ykw-row.is-npc { background: #f9fafb; color: #6b7280; }
    .ykw-time { font-weight: 800; min-width: 84px; } .ykw-kind { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: #ede9fe; color: #5b21b6; font-weight: 800; }
    .ykw-real { font-size: 15px; } .ykw-empty { color: #9ca3af; }
  `;
  document.head.appendChild(style);
}
