/* =========================================================
   🧽 消しバト（ゆうワールドのお店）：消しゴムの改造（第1段階）
   ・パーツの種類・値段・強さの計算・コインの引き落としは、すべて Worker（keshiState / keshiBuy / keshiEquip）が行う。
     このファイルは、画面（3Dの消しゴム・強さ・パーツの一覧）を描いて、「買う」「付ける」を頼むだけ。
   ・ゆうワールド（yuworld.js）から renderKeshi({ root, api, esc, onBack }) で開く。
========================================================= */
import { keshiStatsView } from "./yukeshi-core.js?v=20261023-keshi2";
import { createEraserStage, SLEEVE_COLORS } from "./yukeshi3d.js?v=20261023-keshi2";

const SLOT_NAMES = { body: "本体", edge: "ふち", sole: "そこ", weight: "おもり" };
const STAT_NAMES = [["m", "重さ"], ["s", "すべり"], ["b", "反発"], ["z", "大きさ"]];
let ctx = null, st = null, table = null, sel = { tab: "body", part: "plain" }, busy = false, stage = null, stylesDone = false, token = 0;
const $ = (s) => ctx && ctx.root.querySelector(s);

export function stopKeshi() { token++; if (stage) { try { stage.dispose(); } catch (_) {} stage = null; } }

export function renderKeshi(c) {
  stopKeshi();
  ctx = c; st = null; table = null; busy = false; sel = { tab: "body", part: "plain" };
  injectStyles();
  const my = token;
  ctx.root.innerHTML = `<div class="yk2-head"><button type="button" class="yw-back" id="ykBack">← お店の一覧</button><h2>🧽 消しバト</h2></div><div class="yk2-card yk2-msg">読み込み中…</div>`;
  $("#ykBack")?.addEventListener("click", back);
  return load(my);
}
function back() { stopKeshi(); ctx.onBack(); }

async function load(my) {
  try {
    const r = await ctx.api("keshiState");
    if (my !== token) return;
    st = r; table = r.table; sel = { tab: "body", part: st.eq.body };
    drawShell();
  } catch (e) { if (my === token) fail(e && e.code); }
}
function fail(code) {
  const text = code === "not_published" ? "消しバトはまだ公開されていません。" : "読み込みに失敗しました。通信環境をご確認のうえ、もう一度お試しください。";
  ctx.root.innerHTML = `<div class="yk2-head"><button type="button" class="yw-back" id="ykBack">← お店の一覧</button><h2>🧽 消しバト</h2></div>
    <div class="yk2-card yk2-msg"><b>${ctx.esc(text)}</b>${code === "not_published" ? "" : `<p><button type="button" class="yw-btn" id="ykRetry">もう一度</button></p>`}</div>`;
  $("#ykBack")?.addEventListener("click", back);
  $("#ykRetry")?.addEventListener("click", () => renderKeshi(ctx));
}

/* 画面の枠は1回だけ作る（3Dの消しゴムを作り直さないため）。パーツの一覧などは、変わるたびに中身だけ描き直す */
function drawShell() {
  const my = token;
  ctx.root.innerHTML = `<div class="yk2-head"><button type="button" class="yw-back" id="ykBack">← お店の一覧</button><h2>🧽 消しバト</h2><div class="yk2-coins" id="ykCoins"></div></div>
    <p class="yk2-note">リーグ戦・2人対戦は、このあと追加します。まずは、自分だけの最強の消しゴムを作ろう！</p>
    <div class="yk2-stagebox"><div class="yk2-stage" id="ykStage"><div class="yk2-fallback">🧽</div></div><div class="yk2-rating" id="ykRating"></div></div>
    <div class="yk2-card"><div class="yk2-stats" id="ykStats"></div></div>
    <div class="yk2-tabs" id="ykTabs"></div>
    <div class="yk2-card"><div class="yk2-parts" id="ykParts"></div><div id="ykAct"></div></div>`;
  $("#ykBack")?.addEventListener("click", back);
  draw();
  createEraserStage($("#ykStage")).then((s) => {
    if (!s) return;
    if (my !== token) { s.dispose(); return; }
    stage = s; $("#ykStage")?.querySelector(".yk2-fallback")?.remove(); updateStage();
  }).catch(() => {});
}
const previewEq = () => ({ ...st.eq, ...(sel.tab !== "color" && sel.part ? { [sel.tab]: sel.part } : {}) });
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
  }).join("");
  $("#ykTabs").innerHTML = [...Object.entries(SLOT_NAMES), ["color", "カバーの色"]].map(([k, label]) => `<button type="button" class="yk2-tab${sel.tab === k ? " on" : ""}" data-tab="${k}">${label}</button>`).join("");
  if (sel.tab === "color") {
    $("#ykParts").innerHTML = `<div class="yk2-colors">${SLEEVE_COLORS.map((c, i) => `<button type="button" class="yk2-color${st.color === i ? " on" : ""}" data-color="${i}" style="background:${c}" aria-label="${ctx.esc(table.colors[i])}"><span>${ctx.esc(table.colors[i])}</span></button>`).join("")}</div>`;
    $("#ykAct").innerHTML = `<p class="yk2-desc">カバーの色は、いくつでも無料で変えられます。強さには関係しません。</p>`;
  } else {
    const slot = sel.tab, have = st.have[slot];
    $("#ykParts").innerHTML = table.parts[slot].map((p) => {
      const owned = have.includes(p.id), on = st.eq[slot] === p.id;
      return `<button type="button" class="yk2-part${sel.part === p.id ? " sel" : ""}${on ? " eq" : ""}" data-part="${p.id}"><span class="nm">${ctx.esc(p.name)}</span><span class="fx">${effectText(p)}</span><span class="pr">${on ? "装備中" : owned ? "持っている" : `🪙 ${p.price.toLocaleString("ja-JP")}`}</span></button>`;
    }).join("");
    const p = table.parts[slot].find((x) => x.id === sel.part) || table.parts[slot][0];
    const owned = have.includes(p.id), on = st.eq[slot] === p.id;
    let btn;
    if (on) btn = `<button type="button" class="yw-btn yk2-go" disabled>装備中</button>`;
    else if (owned) btn = `<button type="button" class="yw-btn yk2-go" id="ykEquip" ${busy ? "disabled" : ""}>この消しゴムに付ける</button>`;
    else if (st.coins < p.price) btn = `<button type="button" class="yw-btn yk2-go" disabled>コインが足りません（🪙 ${p.price.toLocaleString("ja-JP")}）</button>`;
    else btn = `<button type="button" class="yw-btn yk2-go yk2-buy" id="ykBuy" ${busy ? "disabled" : ""}>買って付ける（🪙 ${p.price.toLocaleString("ja-JP")}）</button>`;
    $("#ykAct").innerHTML = `<p class="yk2-desc"><b>${ctx.esc(p.name)}</b>：${ctx.esc(p.desc)}（${effectText(p)}）</p>${btn}`;
  }
  ctx.root.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { sel.tab = b.dataset.tab; sel.part = sel.tab === "color" ? null : st.eq[sel.tab]; draw(); updateStage(); }));
  ctx.root.querySelectorAll("[data-part]").forEach((b) => b.addEventListener("click", () => { sel.part = b.dataset.part; draw(); updateStage(); }));
  ctx.root.querySelectorAll("[data-color]").forEach((b) => b.addEventListener("click", () => setColor(Number(b.dataset.color))));
  $("#ykEquip")?.addEventListener("click", equip);
  $("#ykBuy")?.addEventListener("click", buy);
}
async function call(action, payload) {
  if (busy) return null;
  busy = true; draw();
  try { const r = await ctx.api(action, payload); st = { ...st, ...r }; return r; }
  catch (e) { errorMsg(e && e.code); return null; }
  finally { busy = false; draw(); updateStage(); }
}
async function equip() { await call("keshiEquip", { eq: { [sel.tab]: sel.part } }); }
async function setColor(i) { if (busy || st.color === i) return; await call("keshiEquip", { color: i }); }
async function buy() {
  const p = table.parts[sel.tab].find((x) => x.id === sel.part); if (!p) return;
  if (!confirm(`「${p.name}」を ${p.price.toLocaleString("ja-JP")} コインで買って、消しゴムに付けますか？`)) return;
  const r = await call("keshiBuy", { slot: sel.tab, part: sel.part });
  if (r && r.bought) { ctx.root.querySelector("#ykCoins")?.classList.add("pop"); setTimeout(() => ctx.root.querySelector("#ykCoins")?.classList.remove("pop"), 600); }
}
function errorMsg(code) {
  const m = { insufficient_coins: "コインが足りません。", seated: "ゆうスロの席に着いているあいだは買えません。席を立ってから、もう一度お試しください。", busy: "通信が重なりました。もう一度お試しください。", already_owned: "そのパーツはすでに持っています。", not_published: "消しバトは、ただいま非公開になりました。" };
  alert(m[code] || "うまくいきませんでした（" + (code || "エラー") + "）。もう一度お試しください。");
  if (code === "busy" || code === "already_owned") load(token);
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
  .yk2-fallback { font-size: 80px; }
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
  .yk2-stage, .yk2-parts, .yk2-tabs { touch-action: manipulation; -webkit-user-select: none; user-select: none; }
  `;
  const el = document.createElement("style"); el.id = "yk2-style"; el.textContent = css; document.head.appendChild(el);
}
