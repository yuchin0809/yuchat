/* =========================================================
   消しバト「パーツを探す」：回転寿司のベルトコンベア
   ・ベルトの右端から、パーツが次々に流れてきて、左端まで流れると消える。パーツの上に値段が書いてある。
   ・ふつうのパーツが多く、ときどき、レア（R）・スーパーレア（SR）・ウルトラレア（UR）の、高くて強いパーツが流れる。
   ・パーツをタップすると、付けたときの強さが出て、「買う」「買わない」を選べる。
   ・何が流れるかは、端末ごとの種（ベルトを開くときに Worker（keshiBelt）が1つ渡す）と時刻から、この端末の中で決める（端末ごとに違う）。
     買えるかどうかは、Worker（keshiBeltBuy）が、種の署名と時刻とパーツを確かめて決める。
   ・ベータ版。
========================================================= */
import { createPartsStage } from "./yukeshi3d.js?v=20261117-legend1";
import { keshiStatsView, keshiPunchView, keshiBeltItemView } from "./yukeshi-core.js?v=20261117-legend1";

const SLOT_NAMES = { body: "本体", edge: "ふち", sole: "そこ", weight: "おもり" };
const STAT_NAMES = [["m", "重さ"], ["s", "すべり"], ["b", "反発"], ["z", "大きさ"]];
const RARITY = { N: "ふつう", R: "レア", SR: "スーパーレア", UR: "ウルトラレア", LR: "トップレア" };
const CARD_W = 104;

/* パーツの見た目（ベルトの上に置いてあるように、パーツだけを描く。ふちは、中が空洞の枠だけ） */
const LOOK = {
  body: { plain: "#f4f1ea", sponge: "#ffd84a", sand: "#b8b2a4", pro: "#fde7ee", titan: "#d2d6dc", carbon: "#2b2e34", diamond: "#cdf3ff", meteor: "#5a4640", ltd: "#7fa3d6", gel: "#9fe8ff", bamboo: "#2e3a33", ruby: "#c2203a", dragon: "#2a6b3a" },
  edge: { paper: "#ffffff", plastic: "#9fd8ff", band: "#d8262a", metal: "#b9c0c8", crystal: "#66d0ff", titanf: "#c9ced6", mithril: "#bcd8ff", aurora: "url(#ybAur)", ltd: "#ffc933", neon: "#39ff88", carbonf: "#2b2e34", rubyf: "#c2203a", blackhole: "#2a1450" },
  sole: { tape: "#f4d20a", wax: "#fff1c9", teflon: "#1c1c20", air: "#c4ecff", hover: "#c8ffdc", linear: "#8ccaff", zero: "#f4fbff", ltd: "#ff7a45", roller: "#555a63", gelsole: "#aef0ff", plasma: "#ff6aff", antigrav: "#e6ffff" },
  weight: { coin: "#d9a233", bolt: "#aab0b8", lead: "#4a4d54", gold: "#ffc933", tungsten: "#6b6f78", platinum: "#e6edf2", neutron: "#9ad0ff", ltd: "#5fe6cf", mercury: "#c9d1d9", diamondw: "#cdf3ff", osmium: "#3a4a6a", blackholew: "#1a1030" }
};
function partSvg(slot, id) {
  const c = (LOOK[slot] && LOOK[slot][id]) || "#ddd", rim = "stroke=\"rgba(0,0,0,.35)\" stroke-width=\"1.5\"";
  const defs = `<defs><linearGradient id="ybAur" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7affd4"/><stop offset=".5" stop-color="#b57aff"/><stop offset="1" stop-color="#ff7ac8"/></linearGradient><radialGradient id="ybShine" cx=".3" cy=".25" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".75"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>`;
  let g = "";
  if (slot === "body") g = `<rect x="8" y="14" width="72" height="34" rx="9" fill="${c}" ${rim}/><rect x="8" y="14" width="72" height="34" rx="9" fill="url(#ybShine)"/>${id === "sponge" || id === "sand" || id === "meteor" ? [[20, 24], [34, 38], [50, 26], [62, 40], [44, 20], [26, 42]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2" fill="rgba(0,0,0,.28)"/>`).join("") : ""}`;
  else if (slot === "edge") g = id === "band"
    ? `<rect x="8" y="12" width="9" height="38" rx="3" fill="${c}" ${rim}/><rect x="71" y="12" width="9" height="38" rx="3" fill="${c}" ${rim}/>`
    : `<rect x="9" y="13" width="70" height="36" rx="8" fill="none" stroke="rgba(0,0,0,.3)" stroke-width="12"/><rect x="9" y="13" width="70" height="36" rx="8" fill="none" stroke="${c}" stroke-width="9" ${id === "plastic" || id === "crystal" ? "opacity=\".8\"" : ""}/>`;
  else if (slot === "sole") g = `<rect x="6" y="26" width="76" height="9" rx="4" fill="${c}" ${rim}/><rect x="6" y="26" width="76" height="9" rx="4" fill="url(#ybShine)"/>`;
  else g = id === "coin" ? `<circle cx="44" cy="31" r="17" fill="${c}" ${rim}/><circle cx="44" cy="31" r="11" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="2"/>`
    : id === "bolt" ? `<polygon points="44,12 60,21 60,41 44,50 28,41 28,21" fill="${c}" ${rim}/><circle cx="44" cy="31" r="6" fill="rgba(0,0,0,.3)"/>`
    : id === "neutron" || id === "mercury" || id === "blackholew" ? `<circle cx="44" cy="31" r="19" fill="${c}" ${rim}/><circle cx="44" cy="31" r="19" fill="url(#ybShine)"/><circle cx="44" cy="31" r="26" fill="none" stroke="#9ad0ff" stroke-opacity=".5" stroke-width="3"/>`
    : `<rect x="22" y="16" width="44" height="30" rx="5" fill="${c}" ${rim}/><rect x="22" y="16" width="44" height="30" rx="5" fill="url(#ybShine)"/>`;
  return `<svg class="yb-art" viewBox="0 0 88 62" aria-hidden="true">${defs}${g}</svg>`;
}
/* iPad だけ、ベルトの速さを1.15倍にする（スマホはそのまま）。iPadOS は「Mac」を名乗ることがあるので、タッチ対応の Mac も iPad とみなす */
const IS_IPAD = (() => { try { return /iPad/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); } catch (_) { return false; } })();
const SPEED = IS_IPAD ? 1.15 : 1;
let run = 0, stylesDone = false, cur3d = null;

/* =========================================================
   演出（出現・購入）：画面の光・揺れ・バナー・紙吹雪・音・振動。レアなほど派手になる
   ・段階（level）：1＝レア／ゴールド、2＝スーパーレア／ダイヤ、3＝ウルトラレア／レインボー、4＝トップレア
   ・音は、端末の中で作る（音の素材は使わない）。最初にタップするまで、スマホは音を出せない。右上のボタンで、音を切れる
   ・「動きを減らす」設定の端末では、光・揺れ・紙吹雪を出さない（バナーと音だけ）
========================================================= */
const RLEVEL = { N: 0, R: 1, SR: 2, UR: 3, LR: 4 }, MLEVEL = { "": 0, g: 1, d: 2, r: 3 };
const levelOf = (it) => Math.max(RLEVEL[it.rarity] || 0, MLEVEL[it.mut || ""] || 0);
const LCOL = ["#ffffff", "#4aa0e0", "#a56bff", "#ffcf33", "#ff7ae0"];
const reducedMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; } };
let actx = null, muted = false;
try { muted = localStorage.getItem("yb_mute") === "1"; } catch (_) {}
function unlockAudio() {
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === "suspended") actx.resume(); } catch (_) { actx = null; }
}
function tone(freq, at, dur, type = "sine", vol = .1) {
  if (muted || !actx || actx.state !== "running") return;
  try {
    const o = actx.createOscillator(), g = actx.createGain(), t0 = actx.currentTime + at;
    o.type = type; o.frequency.value = freq; g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + .01); g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
    o.connect(g); g.connect(actx.destination); o.start(t0); o.stop(t0 + dur + .05);
  } catch (_) {}
}
const NOTES = [523, 659, 784, 1047, 1319, 1568];
function sfxSpawn(level) { for (let i = 0; i < Math.min(NOTES.length, level + 1); i++) tone(NOTES[i], i * .07, .18, i % 2 ? "triangle" : "sine", .09 + level * .02); if (level >= 3) tone(220, 0, .5, "sawtooth", .05); }
function sfxBuy(level) { tone(1318, 0, .09, "square", .07); tone(1760, .09, .2, "square", .07); for (let i = 0; i < level + 1; i++) tone(NOTES[Math.min(i, 5)] * 2, .25 + i * .08, .25, "triangle", .08); }
const vibrate = (p) => { try { if (!muted && navigator.vibrate) navigator.vibrate(p); } catch (_) {} };

function fxOverlay() {
  let el = document.getElementById("ybFx");
  if (!el) { el = document.createElement("div"); el.id = "ybFx"; el.className = "yb-fx"; document.body.appendChild(el); }
  return el;
}
/* 派手な演出（スーパーレア以上）のあいだは、画面全体を暗い色でおおって、白い余白を見せない */
function backdrop(level) {
  if (level < 2) return;
  const d = document.createElement("div"); d.className = `yb-dark l${level}`; fxOverlay().prepend(d); setTimeout(() => d.remove(), level >= 3 ? 2700 : 1900);
}
function flash(level) {
  if (reducedMotion()) return;
  const f = document.createElement("div"); f.className = `yb-flash l${level}`; fxOverlay().appendChild(f); setTimeout(() => f.remove(), 900);
}
function banner(text, level) {
  const el = document.createElement("div"); el.className = `yb-banner l${level}`; el.textContent = text; fxOverlay().appendChild(el); setTimeout(() => el.remove(), level >= 3 ? 2600 : 1800);
}
function shake(root, level) {
  if (reducedMotion() || level < 3) return;
  root.classList.remove("yb-shake"); void root.offsetWidth; root.classList.add("yb-shake"); setTimeout(() => root.classList.remove("yb-shake"), 700);
}
function confetti(level, from) {
  if (reducedMotion()) return;
  const layer = fxOverlay(), n = 18 + level * 16, cols = level >= 4 ? ["#ff7ae0", "#ffe27a", "#7affd4", "#7ab8ff", "#c88aff", "#fff"] : level === 3 ? ["#ffcf33", "#ffe27a", "#fff", "#ff9a33"] : level === 2 ? ["#a56bff", "#e0c8ff", "#fff"] : ["#4aa0e0", "#bfe3ff", "#fff", "#ffd966"];
  for (let i = 0; i < n; i++) {
    const p = document.createElement("i"), ang = Math.random() * Math.PI * 2, d = 90 + Math.random() * (140 + level * 40);
    p.className = i % 5 === 0 ? "yb-conf coin" : "yb-conf"; if (i % 5 === 0) p.textContent = "🪙";
    p.style.cssText = `left:${from.x}px;top:${from.y}px;background:${i % 5 === 0 ? "none" : cols[i % cols.length]};--dx:${Math.cos(ang) * d}px;--dy:${Math.sin(ang) * d - 60}px;--rot:${Math.random() * 720 - 360}deg;animation-delay:${Math.random() * .12}s`;
    layer.appendChild(p); setTimeout(() => p.remove(), 1700);
  }
}
const RAR_TEXT = { R: "レア", SR: "スーパーレア", UR: "ウルトラレア", LR: "トップレア" };
function fxSpawn(it, root, defs) {
  const level = levelOf(it); if (level === 0) return;
  sfxSpawn(level); backdrop(level); flash(level); shake(root, level);
  const name = it.mut && defs && defs[it.mut] ? defs[it.mut].name : "";
  if (level >= 2 || it.mut) banner(`${it.mut ? `✨${name}　` : ""}${it.rarity !== "N" ? `${RAR_TEXT[it.rarity]}出現！` : "出現！"}`, level);
  vibrate(level >= 3 ? [40, 30, 80] : 25);
}
function fxBuy(it, root, at) {
  const level = levelOf(it);
  sfxBuy(level); vibrate(level >= 3 ? [60, 40, 60, 40, 120] : [30, 30, 50]);
  backdrop(level); flash(Math.max(1, level - 1)); confetti(level, at); shake(root, level);
  banner(`GET！　${it.name}`, Math.max(2, level));
}

export function stopBelt() { run++; if (cur3d) { try { cur3d.dispose(); } catch (_) {} cur3d = null; } }

/* c：{ root, esc, api, table, st（keshiState の結果）, onBack } */
export function renderBelt(c) {
  stopBelt();
  injectStyles();
  const my = run, esc = c.esc, root = c.root;
  let st = c.st, table = c.table, busy = false, offset = 0, B = null, stage = null;   // stage：パーツの3D表示（読めない端末では null。そのときは、平らな絵）
  const items = new Map(), els = new Map(), fxDone = new Set();
  const yen = (n) => `🪙 ${Number(n).toLocaleString("ja-JP")}`;

  root.innerHTML = `<div class="yb-head"><button type="button" class="yw-back" id="ybBack">← 消しゴムの改造へ</button><h2>🍣 パーツを探す</h2><button type="button" class="yb-snd" id="ybSnd" aria-label="音">${muted ? "🔇" : "🔊"}</button><div class="yb-coins" id="ybCoins">${yen(st.coins)}</div></div>
    <p class="yb-note">ベルトコンベアに、パーツが流れてきます。気になるパーツをタップすると、強さが見られて、買えます。流れていったパーツは、もう買えません。</p>
    <div class="yb-belt" id="ybBelt"><div class="yb-lane" id="ybLane"></div><div class="yb-load" id="ybLoad">ベルトを動かしています…</div></div>
    <div class="yb-legend"><span class="N">ふつう</span><span class="R">レア</span><span class="SR">スーパーレア</span><span class="UR">ウルトラレア</span><span class="LR">トップレア</span></div>
    <div class="yb-msg" id="ybMsg"></div>`;
  const $ = (s) => root.querySelector(s);
  $("#ybBack").addEventListener("click", () => { stopBelt(); c.onBack(); });
  root.addEventListener("pointerdown", unlockAudio);
  $("#ybSnd").addEventListener("click", () => { muted = !muted; try { localStorage.setItem("yb_mute", muted ? "1" : "0"); } catch (_) {} $("#ybSnd").textContent = muted ? "🔇" : "🔊"; if (!muted) { unlockAudio(); tone(880, 0, .12); } });

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
    el.type = "button"; el.className = `yb-card ${it.rarity}${it.mut ? ` mut-${it.mut}` : ""}`;
    el.innerHTML = `<span class="pr">${yen(it.price)}</span><span class="plate">${stage ? "" : partSvg(it.slot, it.id)}</span><span class="nm">${esc(it.name)}</span><span class="rr">${it.mut ? "✨ " : ""}${it.rarity === "N" ? SLOT_NAMES[it.slot] : `${RARITY[it.rarity]}`}</span>`;
    el.addEventListener("click", () => openSheet(it));
    return el;
  }

  const t0Expired = () => !busy && !root.querySelector(".yb-sheet") && nowMs() > B.expiresMs - 300000;   // 種の期限が近づいたら、シートを開いていないときに、新しい種をもらう

  function frame() {
    if (my !== run || !root.isConnected) return;
    const lane = $("#ybLane");
    if (lane && B) {
      const W = lane.clientWidth, t = nowMs();
      for (let k = Math.floor((t - B.travelMs / SPEED) / B.tickMs); k <= Math.floor(t / B.tickMs); k++) if (!items.has(k)) items.set(k, keshiBeltItemView(B.pool, B.rates, B.tickMs, B.seed, k, B.mutRates, B.mutDefs));
      items.forEach((it, tick) => {
        const p = ((t - it.startMs) / B.travelMs) * SPEED;
        if (p < 0 || p >= 1) {
          const old = els.get(tick); if (old) { old.remove(); els.delete(tick); }
          if (stage) stage.remove(tick);
          if (p >= 1) items.delete(tick);
          return;
        }
        let el = els.get(tick);
        if (!el) { el = makeCard(it); els.set(tick, el); lane.appendChild(el); if (p < 0.2 && !fxDone.has(tick)) { fxDone.add(tick); fxSpawn(it, root, B.mutDefs); } }
        const x = W - p * (W + CARD_W);
        el.style.transform = `translateX(${x.toFixed(1)}px)`;
        if (stage) { if (!stage.has(tick)) stage.add(tick, it.slot, it.id, it.rarity); stage.move(tick, x + CARD_W / 2, 73); }
      });
      if (stage) stage.render(performance.now());
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
    el.innerHTML = `<div class="yb-box ${it.rarity}"><div class="yb-rar">${RARITY[it.rarity]}</div><div class="yb-look ${it.rarity}" id="ybLook">${stage ? "" : partSvg(it.slot, it.id)}</div><h3>${esc(it.name)}</h3>
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
        const rb = $("#ybBelt").getBoundingClientRect(); fxBuy(it, root, { x: rb.left + rb.width / 2, y: rb.top + rb.height / 2 });
        const cb = $("#ybCoins"); if (cb) { cb.classList.add("pop"); setTimeout(() => cb.classList.remove("pop"), 600); }
        const m = $("#ybMsg"); if (m) m.innerHTML = `✅ <b>${esc(it.name)}</b> を買いました！（付けるときは「消しゴムの改造」の画面から）`;
      } catch (err) {
        const code = err && err.code;
        const msg = { gone: "このパーツは、流れていってしまいました。", expired: "ベルトを入れ替えます。もう一度お試しください。", insufficient_coins: "コインが足りません。", already_owned: "もう持っています。", seated: "ゆうスロの席に着いているあいだは買えません。", busy: "混み合っています。もう一度お試しください。", not_published: "このページは、まだ公開されていません。" }[code] || "買えませんでした。";
        alert(msg); el.remove();
      } finally { busy = false; }
    });
    root.appendChild(el);
    if (stage) {   // 買う前の確認：パーツを大きく、3Dで回して見せる
      const look = el.querySelector("#ybLook");
      createPartsStage(look).then((s3) => {
        if (!s3) { look.innerHTML = partSvg(it.slot, it.id); return; }
        if (!el.isConnected) { s3.dispose(); return; }
        s3.add("p", it.slot, it.id, it.rarity, it.slot === "weight" ? 70 : 130);
        const loop = (t) => { if (!el.isConnected || my !== run) { s3.dispose(); return; } s3.move("p", look.clientWidth / 2, look.clientHeight / 2); s3.render(t); requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
      }).catch(() => { look.innerHTML = partSvg(it.slot, it.id); });
    }
  }

  (async () => {
    try { stage = await createPartsStage($("#ybLane")); } catch (_) { stage = null; }
    if (my !== run) { if (stage) stage.dispose(); return; }
    cur3d = stage;
    await open();
    if (my === run) requestAnimationFrame(frame);
  })();
}

function injectStyles() {
  if (stylesDone) return; stylesDone = true;
  const css = `
  .yb-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; } .yb-head h2 { margin: 6px 0 4px; font-size: 20px; flex: 1 1 auto; white-space: nowrap; }
  .yb-coins { font-weight: 800; background: #fff6d8; border: 1px solid #f0dc9a; border-radius: 999px; padding: 4px 12px; font-size: 14px; }
  .yb-snd { border: none; background: #eee; border-radius: 999px; width: 34px; height: 30px; font-size: 16px; cursor: pointer; } .yb-coins { transition: transform .3s; } .yb-coins.pop { transform: scale(1.35); }
  .yb-card.mut-g .pr { background: linear-gradient(90deg, #ffe27a, #ffc933); } .yb-card.mut-g .nm { color: #ffe27a; }
  .yb-card.mut-d .pr { background: linear-gradient(90deg, #bff4ff, #6ad0ff); } .yb-card.mut-d .nm { color: #bff4ff; }
  .yb-card.mut-r .pr { background: linear-gradient(90deg, #ff9aa8, #ffe27a, #8affc8, #8ac8ff, #c88aff); } .yb-card.mut-r .nm { background: linear-gradient(90deg, #ff9aa8, #ffe27a, #8affc8, #8ac8ff, #c88aff); -webkit-background-clip: text; background-clip: text; color: transparent; text-shadow: none; font-weight: 900; }
  .yb-fx { position: fixed; inset: 0; pointer-events: none; z-index: 90; overflow: hidden; }
  .yb-dark { position: absolute; inset: 0; opacity: 0; animation: yb-dark 1.9s ease-in-out forwards; } .yb-dark.l2 { background: radial-gradient(circle at 50% 40%, rgba(120,70,220,.55), rgba(14,8,34,.9) 75%); } .yb-dark.l3 { background: radial-gradient(circle at 50% 40%, rgba(255,190,40,.55), rgba(30,16,2,.92) 75%); animation-duration: 2.7s; } .yb-dark.l4 { background: linear-gradient(135deg, rgba(255,74,160,.7), rgba(255,184,74,.6) 25%, rgba(74,255,154,.55) 50%, rgba(74,154,255,.6) 75%, rgba(176,74,255,.7)), #12081e; animation-duration: 2.7s; }
  @keyframes yb-dark { 0% { opacity: 0; } 12% { opacity: 1; } 78% { opacity: 1; } 100% { opacity: 0; } }
  .yb-flash { position: absolute; inset: 0; opacity: 0; animation: yb-flash .7s ease-out; } .yb-flash.l1 { background: radial-gradient(circle, rgba(74,160,224,.35), transparent 70%); } .yb-flash.l2 { background: radial-gradient(circle, rgba(165,107,255,.5), transparent 70%); } .yb-flash.l3 { background: radial-gradient(circle, rgba(255,207,51,.7), transparent 75%); } .yb-flash.l4 { background: linear-gradient(120deg, rgba(255,122,224,.7), rgba(255,226,122,.7), rgba(122,255,212,.7), rgba(122,184,255,.7)); }
  @keyframes yb-flash { 0% { opacity: 0; } 15% { opacity: 1; } 100% { opacity: 0; } }
  .yb-banner { position: absolute; left: 50%; top: 24%; transform: translateX(-50%); white-space: nowrap; max-width: 94vw; overflow: hidden; text-overflow: ellipsis; padding: 8px 22px; border-radius: 999px; font-weight: 900; color: #fff; font-size: 18px; text-shadow: 0 2px 0 rgba(0,0,0,.4); box-shadow: 0 6px 20px rgba(0,0,0,.4); animation: yb-banner 1.8s ease-out forwards; }
  .yb-banner.l1 { background: #3a86c8; } .yb-banner.l2 { background: linear-gradient(90deg, #7a4ad6, #b57aff); font-size: min(22px, 4.6vw); } .yb-banner.l3 { background: linear-gradient(90deg, #e0a000, #ffd34a); color: #4a3000; text-shadow: none; font-size: min(26px, 4.8vw); animation-duration: 2.6s; } .yb-banner.l4 { background: linear-gradient(90deg, #ff4aa0, #ffb84a, #4aff9a, #4a9aff, #b04aff); font-size: min(30px, 5vw); animation-duration: 2.6s; }
  @keyframes yb-banner { 0% { opacity: 0; transform: translateX(-50%) scale(.3); } 12% { opacity: 1; transform: translateX(-50%) scale(1.15); } 22% { transform: translateX(-50%) scale(1); } 85% { opacity: 1; } 100% { opacity: 0; transform: translateX(-50%) translateY(-14px) scale(1); } }
  .yb-conf { position: absolute; width: 9px; height: 13px; border-radius: 2px; animation: yb-conf 1.5s cubic-bezier(.2,.7,.3,1) forwards; } .yb-conf.coin { width: auto; height: auto; font-size: 18px; }
  @keyframes yb-conf { 0% { transform: translate(0, 0) rotate(0); opacity: 1; } 70% { opacity: 1; } 100% { transform: translate(var(--dx), calc(var(--dy) + 220px)) rotate(var(--rot)); opacity: 0; } }
  .yb-shake { animation: yb-shake .6s; } @keyframes yb-shake { 0%, 100% { transform: translate(0, 0); } 15% { transform: translate(-7px, 3px); } 30% { transform: translate(6px, -4px); } 45% { transform: translate(-5px, -3px); } 60% { transform: translate(5px, 4px); } 80% { transform: translate(-2px, 1px); } }
  @media (prefers-reduced-motion: reduce) { .yb-flash, .yb-conf, .yb-shake { animation: none; display: none; } }
  .yb-note { color: #666; font-size: 12.5px; line-height: 1.7; margin: 4px 0 10px; }
  .yb-belt { position: relative; height: 176px; border-radius: 16px; overflow: hidden; background: repeating-linear-gradient(90deg, #5b4a3a 0 22px, #4c3d30 22px 44px); box-shadow: inset 0 6px 14px rgba(0,0,0,.45), 0 4px 14px rgba(0,0,0,.2); border: 4px solid #2f2620; }
  .yb-belt::before, .yb-belt::after { content: ""; position: absolute; left: 0; right: 0; height: 10px; background: linear-gradient(#cfd3d8, #8d939b); z-index: 2; } .yb-belt::before { top: 0; } .yb-belt::after { bottom: 0; }
  .yb-lane { position: absolute; inset: 0; }
  .yb-load { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; }
  .yb-card { position: absolute; left: 0; top: 14px; width: ${CARD_W}px; padding: 0; border: none; background: none; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 2px; will-change: transform; -webkit-tap-highlight-color: transparent; }
  .yb-card .pr { background: #fff; color: #b45309; font-weight: 900; font-size: 13px; border-radius: 999px; padding: 2px 9px; box-shadow: 0 2px 0 rgba(0,0,0,.25); }
  .yb-card .plate { width: 92px; height: 70px; display: flex; align-items: center; justify-content: center; }
  .yb-art { width: 92px; height: 65px; filter: drop-shadow(0 4px 3px rgba(0,0,0,.55)); }
  .yb-card .nm { color: #fff; font-weight: 800; font-size: 11.5px; line-height: 1.2; text-align: center; text-shadow: 0 1px 2px #000; max-width: ${CARD_W}px; }
  .yb-card .rr { font-size: 10px; font-weight: 800; color: #ddd; text-shadow: 0 1px 2px #000; }
  .yb-card.R .art, .yb-card.R .yb-art { filter: drop-shadow(0 0 6px #4aa0e0) drop-shadow(0 4px 3px rgba(0,0,0,.55)); } .yb-card.R .rr { color: #8fd0ff; }
  .yb-card.SR .yb-art { filter: drop-shadow(0 0 8px #a56bff) drop-shadow(0 4px 3px rgba(0,0,0,.55)); } .yb-card.SR .rr { color: #cfa8ff; }
  .yb-card.LR .yb-art { filter: drop-shadow(0 0 12px #fff) drop-shadow(0 0 20px #ff7ae0) drop-shadow(0 4px 3px rgba(0,0,0,.55)); animation: yb-glow 0.8s ease-in-out infinite; } .yb-card.LR .rr { color: #ffb8f0; font-weight: 900; } .yb-card.LR .pr { background: linear-gradient(90deg, #ffe27a, #ffb8f0, #8ac8ff); }
  .yb-card.UR .yb-art { filter: drop-shadow(0 0 10px #ffcf33) drop-shadow(0 4px 3px rgba(0,0,0,.55)); animation: yb-glow 1.2s ease-in-out infinite; } .yb-card.UR .rr { color: #ffd966; }
  @keyframes yb-glow { 0%, 100% { filter: drop-shadow(0 0 6px #ffcf33) drop-shadow(0 4px 3px rgba(0,0,0,.55)); } 50% { filter: drop-shadow(0 0 16px #ffe27a) drop-shadow(0 4px 3px rgba(0,0,0,.55)); } }
  @media (prefers-reduced-motion: reduce) { .yb-card.UR .yb-art, .yb-card.LR .yb-art { animation: none; } }
  .yb-legend { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; font-size: 11.5px; font-weight: 800; } .yb-legend span { border-radius: 999px; padding: 2px 10px; background: #eee; color: #444; }
  .yb-legend .R { background: #dff0ff; color: #14507a; } .yb-legend .SR { background: #eadfff; color: #5a2aa0; } .yb-legend .UR { background: #fff0b8; color: #7a5200; }
  .yb-legend .LR { background: linear-gradient(90deg, #ff9aa8, #ffe27a, #8affc8, #8ac8ff, #c88aff); color: #3a1a00; }
  .yb-msg { font-size: 13px; line-height: 1.7; color: #2c6a3a; min-height: 20px; }
  .yb-sheet { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 60; padding: 16px; }
  .yb-box { width: 100%; max-width: 380px; max-height: 92vh; overflow: auto; background: #fff; border-radius: 16px; padding: 16px; border-top: 8px solid #bbb; } .yb-box.R { border-color: #4aa0e0; } .yb-box.SR { border-color: #8a4ae0; } .yb-box.UR { border-color: #e0a000; } .yb-box.LR { border-image: linear-gradient(90deg, #ff7ae0, #ffe27a, #7affd4, #7ab8ff) 1; }
  .yb-look { position: relative; min-height: 105px; display: flex; justify-content: center; align-items: center; margin: 4px 0; background: repeating-linear-gradient(90deg, #5b4a3a 0 22px, #4c3d30 22px 44px); border-radius: 10px; padding: 6px 0; } .yb-look .yb-art { width: 120px; height: 85px; }
  .yb-rar { font-size: 11.5px; font-weight: 900; color: #777; } .yb-box h3 { margin: 2px 0 6px; font-size: 18px; } .yb-d { font-size: 12.5px; line-height: 1.7; color: #555; margin: 0 0 8px; }
  .yb-cmp { background: #fff8e8; border-radius: 10px; padding: 8px 10px; font-size: 13px; } .yb-cmp > b { display: block; margin-bottom: 4px; font-size: 12.5px; }
  .yb-st { display: grid; grid-template-columns: 64px 1fr 18px 1fr 44px; gap: 4px; align-items: center; padding: 2px 0; text-align: center; } .yb-st span { text-align: left; } .yb-st i { font-style: normal; color: #999; }
  .yb-st .up { color: #2fbf55; font-size: 12px; font-style: normal; font-weight: 800; } .yb-st .down { color: #ff6b5e; font-size: 12px; font-style: normal; font-weight: 800; }
  .yb-note2 { font-size: 11.5px; color: #777; line-height: 1.6; margin: 8px 0; }
  .yb-btns { display: grid; grid-template-columns: 1fr 2fr; gap: 8px; } .yb-btns .yw-btn { padding: 12px 8px; font-size: 14px; } .yb-no { background: #8a8f98; } .yb-yes { background: #e0902f; }
  `;
  const el = document.createElement("style"); el.id = "yb-style"; el.textContent = css; document.head.appendChild(el);
}
