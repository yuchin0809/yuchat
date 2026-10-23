/* 🥊 最強決定戦に、最近ログインした人をまとめてエントリーさせる（管理者だけ。ユーザー管理タブの上に出す）
   ・「対象を確認」で、直近◯日にログインした人のうち、まだエントリーしていない人を数えて見せる（何も書かない）。
   ・「◯人をエントリーさせる」で、Worker の keshiLeagueEnroll（apply: true）を呼ぶ。本人は、あとからいつでもやめられる。 */

let cfg = null;
const S = { days: 7, preview: null, busy: false, msg: "", error: false };
let stylesDone = false;

export function keshiEnrollInit(config) { cfg = config; }
export function keshiEnrollReset() { S.preview = null; S.busy = false; S.msg = ""; S.error = false; const el = document.getElementById("userManageKeshi"); if (el) el.innerHTML = ""; }
export function keshiEnrollOpen() { if (!cfg || !cfg.isAdmin()) return; ensureStyles(); render(); }

function render() {
  const el = document.getElementById("userManageKeshi");
  if (!el) return;
  if (!cfg || !cfg.isAdmin()) { el.innerHTML = ""; return; }
  const esc = cfg.esc, p = S.preview;
  const preview = p ? `<div class="yke-preview"><p>直近 <b>${p.days}</b> 日にログインした人：<b>${p.active}</b> 人（うち、すでにエントリー済み：${p.already} 人）</p>
      <p>これからエントリーさせる人：<b class="yke-n">${p.willEnroll}</b> 人</p>
      ${p.willEnroll ? `<details><summary>名前を見る${p.names.length < p.willEnroll ? `（先頭 ${p.names.length} 人）` : ""}</summary><div class="yke-names">${p.names.map((n) => `<span>${esc(n)}</span>`).join("")}</div></details>
      <button type="button" class="yke-go" data-ke="apply" ${S.busy ? "disabled" : ""}>${p.willEnroll} 人をエントリーさせる</button>` : `<p class="yke-note">エントリーさせる人はいません。</p>`}</div>` : "";
  el.innerHTML = `<div class="yke-head"><h3>🥊 最強決定戦に、まとめてエントリー</h3></div>
    <p class="yke-note">最近ログインした人を、最強決定戦（消しバトのリーグ戦）に、まとめてエントリーさせます。本人は、あとからいつでも「エントリーをやめる」できます。</p>
    <div class="yke-row">直近 <input id="ykeDays" type="number" min="1" max="60" value="${S.days}" inputmode="numeric"> 日 <button type="button" class="yke-btn" data-ke="check" ${S.busy ? "disabled" : ""}>${S.busy && !p ? "確認中…" : "対象を確認"}</button></div>
    ${preview}${S.msg ? `<p class="${S.error ? "yke-err" : "yke-ok"}">${esc(S.msg)}</p>` : ""}`;
}

async function call(apply) {
  const input = document.getElementById("ykeDays");
  const days = Math.round(Number(input ? input.value : S.days)) || 7;
  S.days = Math.min(60, Math.max(1, days));
  S.busy = true; S.msg = ""; S.error = false; render();
  try {
    const r = await cfg.callAdmin("keshiLeagueEnroll", { days: S.days, apply });
    if (apply) { S.msg = `${r.enrolled} 人をエントリーさせました（エントリー済みの人は ${r.already + r.enrolled} 人）。`; S.preview = { ...r, already: r.already + r.enrolled, willEnroll: 0, names: [] }; }
    else S.preview = r;
  } catch (error) { console.error("最強決定戦のエントリーのエラー:", error); S.msg = "うまくいきませんでした。もう一度お試しください。"; S.error = true; }
  S.busy = false; render();
}

document.addEventListener("click", (event) => {
  const t = event.target.closest?.("[data-ke]");
  if (!t || !document.getElementById("userManageKeshi")?.contains(t) || S.busy) return;
  if (t.dataset.ke === "check") call(false);
  else if (t.dataset.ke === "apply" && S.preview) {
    if (confirm(`直近 ${S.preview.days} 日にログインした ${S.preview.willEnroll} 人を、最強決定戦にエントリーさせます。よろしいですか？\n（本人は、あとからいつでもやめられます）`)) call(true);
  }
});

function ensureStyles() {
  if (stylesDone) return; stylesDone = true;
  const el = document.createElement("style"); el.id = "yke-style";
  el.textContent = `
  #userManageKeshi .yke-head h3 { margin: 0 0 4px; font-size: 15px; } #userManageKeshi .yke-note { color: #666; font-size: 12px; line-height: 1.6; margin: 4px 0; }
  #userManageKeshi .yke-row { display: flex; align-items: center; gap: 6px; margin: 8px 0; font-size: 13px; } #userManageKeshi input[type=number] { width: 64px; padding: 6px; border: 1px solid #ccc; border-radius: 8px; font-size: 14px; }
  #userManageKeshi .yke-btn, #userManageKeshi .yke-go { border: none; border-radius: 10px; padding: 8px 14px; font-weight: 800; cursor: pointer; color: #fff; background: #14507a; } #userManageKeshi .yke-go { display: block; width: 100%; margin-top: 8px; padding: 12px; background: #e0902f; font-size: 15px; } #userManageKeshi button:disabled { opacity: .5; cursor: default; }
  #userManageKeshi .yke-preview { background: #fff8e8; border: 1px solid #f0dc9a; border-radius: 10px; padding: 8px 12px; font-size: 13px; } #userManageKeshi .yke-preview p { margin: 4px 0; } #userManageKeshi .yke-n { font-size: 20px; color: #b45309; }
  #userManageKeshi .yke-names { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; max-height: 160px; overflow: auto; } #userManageKeshi .yke-names span { background: #fff; border: 1px solid #e5dcc0; border-radius: 999px; padding: 2px 8px; font-size: 12px; }
  #userManageKeshi .yke-ok { color: #2c8a52; font-weight: 800; font-size: 13px; } #userManageKeshi .yke-err { color: #c0392b; font-weight: 800; font-size: 13px; }`;
  document.head.appendChild(el);
}
