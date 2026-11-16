/* =========================================================
   消しバト「パーツを探す」：回転寿司のベルトコンベア
   ・ベルトの右端から、パーツが次々に流れてきて、左端まで流れると消える。パーツの上に値段が書いてある。
   ・ふつうのパーツが多く、ときどき、レア（R）・スーパーレア（SR）・ウルトラレア（UR）の、高くて強いパーツが流れる。
   ・パーツをタップすると、付けたときの強さが出て、「買う」「買わない」を選べる。
   ・何が流れるかは、端末ごとの種（ベルトを開くときに Worker（keshiBelt）が1つ渡す）と時刻から、この端末の中で決める（端末ごとに違う）。
     買えるかどうかは、Worker（keshiBeltBuy）が、種の署名と時刻とパーツを確かめて決める。
   ・いまは管理者だけが使える（Worker が確かめる）。
========================================================= */
import { keshiStatsView, keshiPunchView, keshiBeltItemView } from "./yukeshi-core.js?v=20261116-belt2";

const SLOT_NAMES = { body: "本体", edge: "ふち", sole: "そこ", weight: "おもり" };
const SLOT_ICONS = { body: "🧽", edge: "🖼️", sole: "👟", weight: "⚖️" };
const STAT_NAMES = [["m", "重さ"], ["s", "すべり"], ["b", "反発"], ["z", "大きさ"]];
const RARITY = { N: "ふつう", R: "レア", SR: "スーパーレア", UR: "ウルトラレア" };
const CARD_W = 104;
let run = 0, stylesDone = false;

export function stopBelt() { run++; }

/* c：{ root, esc, api, table, st（keshiState の結果）, onBack } */
export function renderBelt(c) {
  stopBelt();
  injectStyles();
  const my = run, esc = c.esc, root = c.root;
  let st = c.st, table = c.table, busy = false, offset = 0, B = null;
  const items = new Map(), els = new Map();
  const yen = (n) => `🪙 ${Number(n).toLocaleString("ja-JP")}`;

  root.innerHTML = `<div class="yb-head"><button type="button" class="yw-back" id="ybBack">← 消しゴムの改造へ</button><h2>🍣 パーツを探す</h2><div class="yb-coins" id="ybCoins">${yen(st.coins)}</div></div>
    <p class="yb-note">ベルトコンベアに、パーツが流れてきます。気になるパーツをタップすると、強さが見られて、買えます。流れていったパーツは、もう買えません。</p>
    <div class="yb-belt" id="ybBelt"><div class="yb-lane" id="ybLane"></div><div class="yb-load" id="ybLoad">ベルトを動かしています…</div></div>
    <div class="yb-legend"><span class="N">ふつう</span><span class="R">レア</span><span class="SR">スーパーレア</span><span class="UR">ウルトラレア</span></div>
    <div class="yb-msg" id="ybMsg"></div>`;
  const $ = (s) => root.querySelector(s);
  $("#ybBack").addEventListener("click", () => { stopBelt(); c.onBack(); });

  const nowMs = () => Date.now() + offset;
  async function open() {
    try {
      const r = await c.api("keshiBelt");
      if (my !== run) return;
      offset = r.serverNowMs - Date.now(); B = r;
      items.clear(); els.forEach((e) => e.remove()); els.clear();
      $("#ybLoad")?.remove();
    } catch (e) {
      if (my !== run) return;
      const m = $("#ybMsg"); if (m) m.textContent = e && e.code === "not_published" ? "このページは、まだ公開されていません。" : "ベルトを読み込めませんでした。通信環境をご確認ください。";
    }
  }

  function makeCard(it) {
    const el = document.createElement("button");
    el.type = "button"; el.className = `yb-card ${it.rarity}`;
    el.innerHTML = `<span class="pr">${yen(it.price)}</span><span class="plate"><span class="ico">${SLOT_ICONS[it.slot]}</span></span><span class="nm">${esc(it.name)}</span><span class="rr">${it.rarity === "N" ? SLOT_NAMES[it.slot] : `${RARITY[it.rarity]}`}</span>`;
    el.addEventListener("click", () => openSheet(it));
    return el;
  }

  const t0Expired = () => !busy && !root.querySelector(".yb-sheet") && nowMs() > B.expiresMs - 300000;   // 種の期限が近づいたら、シートを開いていないときに、新しい種をもらう

  function frame() {
    if (my !== run || !root.isConnected) return;
    const lane = $("#ybLane");
    if (lane && B) {
      const W = lane.clientWidth, t = nowMs();
      for (let k = Math.floor((t - B.travelMs) / B.tickMs); k <= Math.floor(t / B.tickMs); k++) if (!items.has(k)) items.set(k, keshiBeltItemView(B.pool, B.rates, B.tickMs, B.seed, k));
      items.forEach((it, tick) => {
        const p = (t - it.startMs) / B.travelMs;
        if (p < 0 || p >= 1) {
          const old = els.get(tick); if (old) { old.remove(); els.delete(tick); }
          if (p >= 1) items.delete(tick);
          return;
        }
        let el = els.get(tick);
        if (!el) { el = makeCard(it); els.set(tick, el); lane.appendChild(el); }
        el.style.transform = `translateX(${(W - p * (W + CARD_W)).toFixed(1)}px)`;
      });
    }
    if (B && t0Expired()) { B = null; open(); }
    requestAnimationFrame(frame);
  }

  function openSheet(it) {
    const eq0 = st.eq, eq1 = { ...st.eq, [it.slot]: it.id };
    const t = { ...table, parts: { ...table.parts, [it.slot]: [...table.parts[it.slot].filter((p) => p.id !== it.id), { id: it.id, name: it.name, price: it.price, m: it.m, s: it.s, b: it.b, z: it.z }] } };
    const a = keshiStatsView(t, eq0), b = keshiStatsView(t, eq1), pa = keshiPunchView(t, eq0), pb = keshiPunchView(t, eq1);
    const owned = (st.have?.[it.slot] || []).includes(it.id);
    const sign = (n) => (n > 0 ? "+" + n : String(n));
    const fx = STAT_NAMES.filter(([k]) => it[k]).map(([k, l]) => `${l}${sign(it[k])}`).join(" ") || "変化なし";
    const row = (label, x, y) => { const d = Math.round((y - x) * 10) / 10; return `<div class="yb-st"><span>${label}</span><b>${x}</b><i>→</i><b>${y}</b><em class="${d > 0 ? "up" : d < 0 ? "down" : ""}">${d ? (d > 0 ? "▲" : "▼") + Math.abs(d) : ""}</em></div>`; };
    const el = document.createElement("div");
    el.className = "yb-sheet";
    el.innerHTML = `<div class="yb-box ${it.rarity}"><div class="yb-rar">${RARITY[it.rarity]}</div><h3>${SLOT_ICONS[it.slot]} ${esc(it.name)}</h3>
      <p class="yb-d">${SLOT_NAMES[it.slot]}のパーツ　${esc(it.desc)}<br>効き目：${esc(fx)}</p>
      <div class="yb-cmp"><b>いま付けている消しゴムに付けたら</b>
        ${STAT_NAMES.map(([k, l]) => row(l, a[k], b[k])).join("")}
        ${row("総合力", a.rating, b.rating)}
        ${row("攻撃力", `×${pa.atk.toFixed(1)}`, `×${pb.atk.toFixed(1)}`)}
        ${row("守り", `×${pa.def.toFixed(1)}`, `×${pb.def.toFixed(1)}`)}</div>
      <p class="yb-note2">買っただけでは付きません。付けるときは「消しゴムの改造」の画面で選びます。</p>
      <div class="yb-btns"><button type="button" class="yw-btn yb-no" data-no>買わない</button><button type="button" class="yw-btn yb-yes" data-yes ${owned || st.coins < it.price ? "disabled" : ""}>${owned ? "持っています" : st.coins < it.price ? `コインが足りません（${yen(it.price)}）` : `買う（${yen(it.price)}）`}</button></div></div>`;
    el.addEventListener("click", async (e) => {
      if (e.target === el || e.target.hasAttribute("data-no")) { el.remove(); return; }
      if (!e.target.hasAttribute("data-yes") || busy) return;
      busy = true; e.target.disabled = true;
      try {
        const r = await c.api("keshiBeltBuy", { token: B.token, tick: it.tick, slot: it.slot, part: it.id });
        st = { ...st, ...r }; if (r.table) table = r.table;
        $("#ybCoins").textContent = yen(st.coins);
        el.remove();
        const m = $("#ybMsg"); if (m) m.innerHTML = `✅ <b>${esc(it.name)}</b> を買いました！（付けるときは「消しゴムの改造」の画面から）`;
      } catch (err) {
        const code = err && err.code;
        const msg = { gone: "このパーツは、流れていってしまいました。", expired: "ベルトを入れ替えます。もう一度お試しください。", insufficient_coins: "コインが足りません。", already_owned: "もう持っています。", seated: "ゆうスロの席に着いているあいだは買えません。", busy: "混み合っています。もう一度お試しください。", not_published: "このページは、まだ公開されていません。" }[code] || "買えませんでした。";
        alert(msg); el.remove();
      } finally { busy = false; }
    });
    root.appendChild(el);
  }

  open().then(() => { if (my === run) requestAnimationFrame(frame); });
}

function injectStyles() {
  if (stylesDone) return; stylesDone = true;
  const css = `
  .yb-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; } .yb-head h2 { margin: 6px 0 4px; font-size: 20px; flex: 1; }
  .yb-coins { font-weight: 800; background: #fff6d8; border: 1px solid #f0dc9a; border-radius: 999px; padding: 4px 12px; font-size: 14px; }
  .yb-note { color: #666; font-size: 12.5px; line-height: 1.7; margin: 4px 0 10px; }
  .yb-belt { position: relative; height: 176px; border-radius: 16px; overflow: hidden; background: repeating-linear-gradient(90deg, #5b4a3a 0 22px, #4c3d30 22px 44px); box-shadow: inset 0 6px 14px rgba(0,0,0,.45), 0 4px 14px rgba(0,0,0,.2); border: 4px solid #2f2620; }
  .yb-belt::before, .yb-belt::after { content: ""; position: absolute; left: 0; right: 0; height: 10px; background: linear-gradient(#cfd3d8, #8d939b); z-index: 2; } .yb-belt::before { top: 0; } .yb-belt::after { bottom: 0; }
  .yb-lane { position: absolute; inset: 0; }
  .yb-load { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; }
  .yb-card { position: absolute; left: 0; top: 14px; width: ${CARD_W}px; padding: 0; border: none; background: none; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 2px; will-change: transform; -webkit-tap-highlight-color: transparent; }
  .yb-card .pr { background: #fff; color: #b45309; font-weight: 900; font-size: 13px; border-radius: 999px; padding: 2px 9px; box-shadow: 0 2px 0 rgba(0,0,0,.25); }
  .yb-card .plate { width: 84px; height: 84px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: radial-gradient(circle at 35% 30%, #fff, #e9e4d6 70%); box-shadow: 0 4px 8px rgba(0,0,0,.4), inset 0 0 0 5px #fff, inset 0 0 0 7px #d8d1bf; }
  .yb-card .ico { font-size: 38px; }
  .yb-card .nm { color: #fff; font-weight: 800; font-size: 11.5px; line-height: 1.2; text-align: center; text-shadow: 0 1px 2px #000; max-width: ${CARD_W}px; }
  .yb-card .rr { font-size: 10px; font-weight: 800; color: #ddd; text-shadow: 0 1px 2px #000; }
  .yb-card.R .plate { box-shadow: 0 4px 8px rgba(0,0,0,.4), inset 0 0 0 5px #bfe3ff, inset 0 0 0 7px #4aa0e0, 0 0 14px #4aa0e0; } .yb-card.R .rr { color: #8fd0ff; }
  .yb-card.SR .plate { box-shadow: 0 4px 8px rgba(0,0,0,.4), inset 0 0 0 5px #e6d2ff, inset 0 0 0 7px #8a4ae0, 0 0 18px #a56bff; } .yb-card.SR .rr { color: #cfa8ff; }
  .yb-card.UR .plate { background: radial-gradient(circle at 35% 30%, #fff6c8, #ffd04a 75%); box-shadow: 0 4px 8px rgba(0,0,0,.4), inset 0 0 0 5px #fff0a8, inset 0 0 0 7px #e0a000, 0 0 24px #ffcf33; animation: yb-glow 1.2s ease-in-out infinite; } .yb-card.UR .rr { color: #ffd966; }
  @keyframes yb-glow { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.25); } }
  @media (prefers-reduced-motion: reduce) { .yb-card.UR .plate { animation: none; } }
  .yb-legend { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; font-size: 11.5px; font-weight: 800; } .yb-legend span { border-radius: 999px; padding: 2px 10px; background: #eee; color: #444; }
  .yb-legend .R { background: #dff0ff; color: #14507a; } .yb-legend .SR { background: #eadfff; color: #5a2aa0; } .yb-legend .UR { background: #fff0b8; color: #7a5200; }
  .yb-msg { font-size: 13px; line-height: 1.7; color: #2c6a3a; min-height: 20px; }
  .yb-sheet { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 60; padding: 16px; }
  .yb-box { width: 100%; max-width: 380px; max-height: 92vh; overflow: auto; background: #fff; border-radius: 16px; padding: 16px; border-top: 8px solid #bbb; } .yb-box.R { border-color: #4aa0e0; } .yb-box.SR { border-color: #8a4ae0; } .yb-box.UR { border-color: #e0a000; }
  .yb-rar { font-size: 11.5px; font-weight: 900; color: #777; } .yb-box h3 { margin: 2px 0 6px; font-size: 18px; } .yb-d { font-size: 12.5px; line-height: 1.7; color: #555; margin: 0 0 8px; }
  .yb-cmp { background: #fff8e8; border-radius: 10px; padding: 8px 10px; font-size: 13px; } .yb-cmp > b { display: block; margin-bottom: 4px; font-size: 12.5px; }
  .yb-st { display: grid; grid-template-columns: 64px 1fr 18px 1fr 44px; gap: 4px; align-items: center; padding: 2px 0; text-align: center; } .yb-st span { text-align: left; } .yb-st i { font-style: normal; color: #999; }
  .yb-st .up { color: #2fbf55; font-size: 12px; font-style: normal; font-weight: 800; } .yb-st .down { color: #ff6b5e; font-size: 12px; font-style: normal; font-weight: 800; }
  .yb-note2 { font-size: 11.5px; color: #777; line-height: 1.6; margin: 8px 0; }
  .yb-btns { display: grid; grid-template-columns: 1fr 2fr; gap: 8px; } .yb-btns .yw-btn { padding: 12px 8px; font-size: 14px; } .yb-no { background: #8a8f98; } .yb-yes { background: #e0902f; }
  `;
  const el = document.createElement("style"); el.id = "yb-style"; el.textContent = css; document.head.appendChild(el);
}
