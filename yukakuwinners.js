/* 🌈 確変台の当選者（管理者だけ。ユーザー管理タブの上に出す）
   ・その日の枠ごとに、当選したプレイヤー・NPC・空きを見られる（昨日・今日・明日の切り替え）。
   ・プレイヤーには見せない（ほかの人の名前は出さない決まり）。Worker の kakuWinners（管理者だけ）を呼んで表示するだけ。 */

let cfg = null;
let data = null;
let day = "";      // "" ＝ 今日（サーバーの日付）
let loading = false;
const G = { count: 1, id: "", busy: false, msg: "", error: false };   // 確変チケットを全員に配る

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
    <p class="ykw-note">管理者だけが見られます（プレイヤーには、自分の枠以外は見えません）。</p>
    <h3 class="ykw-sub">🎟 確変チケットを全員に配る</h3>
    <p class="ykw-note">全員に、確変台の予約チケットを配ります（1枚＝枠を1回予約できる。有効期限：配ってから60日。ゆうマートでは売れません）。1人にだけ渡すときは、ユーザー一覧の詳細から。</p>
    <div class="ykw-grant"><select id="ykwGrantCount" aria-label="配る枚数">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}"${G.count === n ? " selected" : ""}>${n}枚</option>`).join("")}</select>
      <button type="button" class="ykw-tab is-on" data-ykw-grant="1" ${G.busy ? "disabled" : ""}>${G.busy ? "配っています…" : "全員に配る"}</button></div>
    ${G.msg ? `<p class="ykw-note" style="font-weight:800;color:${G.error ? "#c0392b" : "#2c8a52"}">${esc(G.msg)}</p>` : ""}`;
}

async function grantAll() {
  if (G.busy) return;
  const count = Number(document.getElementById("ykwGrantCount")?.value) || 1;
  G.count = count;
  if (!confirm(`全員に、確変台の予約チケットを ${count} 枚ずつ配ります。よろしいですか？\n（配ったあとは取り消せません）`)) return;
  G.id = G.id || crypto.randomUUID().replace(/-/g, "");
  G.busy = true; G.msg = ""; G.error = false; render();
  try {
    const r = await cfg.callAdmin("grantKakuTicket", { all: true, count, grantId: G.id });
    if (!r.busy) G.id = "";   // うまくいかなかった人がいるときは、同じ印で押し直す（配った人には2回目を配らない）
    G.msg = `${r.granted} 人に ${count} 枚ずつ配りました。${r.already ? `（すでに配ってあった人：${r.already} 人）` : ""}${r.busy ? `（うまくいかなかった人：${r.busy} 人。もう一度押すと、その人だけに配ります）` : ""}`;
    if (r.busy) G.error = true;
  } catch (error) { console.error("確変チケットを配るエラー:", error); G.msg = "うまくいきませんでした。もう一度お試しください（二重には配りません）。"; G.error = true; }
  G.busy = false; render();
}

document.addEventListener("click", (event) => {
  const g = event.target.closest?.("[data-ykw-grant]");
  if (g && document.getElementById("userManageKaku")?.contains(g)) { grantAll(); return; }
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
    .ykw-tabs { display: flex; gap: 6px; margin: 8px 0; } .ykw-sub { margin: 16px 0 0; font-size: 14px; } .ykw-grant { display: flex; align-items: center; gap: 8px; margin: 6px 0; } .ykw-grant select { padding: 6px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; }
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
